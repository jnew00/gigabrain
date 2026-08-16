"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { useGigaverse } from "@/lib/use-gigaverse";
import { pickBestAction } from "@/lib/auto-battle";
import { probeEnemyMove } from "@/lib/enemy-probe";
import { didWinRun } from "@/lib/run-outcome";
import { pickBestCard, pickGroveMove, resolveGrid } from "@/lib/fishing-ai";
import { beginHaulCapture, endHaulCapture, peekHaulCapture } from "@/lib/use-gigaverse";
import { probeFishMove } from "@/lib/fishing-probe";
import { pendingCatchCards } from "@/lib/fishing-state";
import type { FishingGameState } from "@/lib/types";
import { restoreVerdict, isRepairExhausted } from "@/lib/gear";
import { suggestGear, deadSlotsWithoutOptions, describeEffects, type GearRecipe } from "@/lib/gear-advisor";
import { buildLoadout, loadoutWarnings, emptyWoodsSlots, usableHands } from "@/lib/loadout";
import { Sword, Package, Fish, AlertTriangle, Info, Lightbulb, ChevronRight } from "lucide-react";
import { recordRunAction, recordCastAction, getDungeonPerformanceAction, getPondYieldsAction } from "./actions";
import { getMaxRunsPerDay, findDungeonInfo, isEventDungeon, isAwakeningActive, pickEntryTier, CLAIM_RECIPES, CLAIM_RECIPE_IDS, AWAKENING, FISHING } from "@/lib/game-data";
import {
  openCastNodes, openPonds, pondById, pondCurrencyLabel, castAllowance, pondEntryOptions,
  isDailyCapError, clampRestoredCasts,
} from "@/lib/ponds";
import { buildRecommendation } from "@/lib/energy-advisor";
import type { AdvisorResult } from "@/lib/energy-advisor";


/* ─── Constants ────────────────────────────────────────────── */

// Every castable node across every open pond. Event ponds fall out of this on
// their own end date, so nothing here needs an isAwakeningActive() check.
const CAST_NODES = openCastNodes();

// Recipe ids come from the shared claim table in game-data so this file and
// the Pots & Chests panel cannot drift apart again.
const RECIPE_ITEMS = CLAIM_RECIPE_IDS;

// Mana falls by one per card on every redraw so the loop terminates anyway;
// the cap stops a stubborn hand from spending a whole cast reshuffling.
const MAX_REDRAWS_PER_CAST = 3;

/** Item rarity palette, matching the one the rest of the app uses */
const RARITY_COLORS = ["var(--text-faint)", "var(--green)", "var(--blue)", "var(--gold)", "var(--orange)"];

const PRESETS_KEY = "giga-daily-presets";
const LAST_ALLOC_KEY = "giga-daily-last";
const LAST_RUN_KEY = "giga-daily-last-run";

/** Extract loot item names from a recipe response */
function formatRecipeLoot(
  r: { gameItemBalanceChanges?: { id: number; amount: number }[]; entities?: unknown[] } | null | undefined,
  itemInfo: Record<string, { name?: string }>,
  itemNames: Record<string, string>
): string[] {
  const parts: string[] = [];
  if (r?.gameItemBalanceChanges) {
    for (const c of r.gameItemBalanceChanges) {
      const name = itemInfo[String(c.id)]?.name || itemNames[String(c.id)] || `#${c.id}`;
      parts.push(`${c.amount}x ${name}`);
    }
  }
  return parts;
}

/* ─── Types ────────────────────────────────────────────────── */

export interface MissionControlProps {
  giga: ReturnType<typeof useGigaverse>;
  addLog: (msg: string) => void;
  handleVote: () => Promise<void>;
  hasVoted: boolean;
  refreshRunStats: () => void;
}

interface DungeonAlloc {
  dungeonId: number;
  name: string;
  energyCost: number;
  runs: number;
  maxRuns: number;
}

/**
 * Casts planned on one node.
 *
 * There is a list of these rather than a single one because the daily cast
 * allowance is a single pool shared by every pond: "6 Grove casts and 4 Big
 * classic casts" is a legitimate plan, and a lone {castNodeId, casts} could not
 * express it. That limitation is why the advisor used to route the entire pool
 * to the Grove during the event — not because that was optimal, but because it
 * was the only thing the plan could say.
 */
interface FishingAlloc {
  pondId: number;
  castNodeId: string;
  castCost: number;
  castLabel: string;
  casts: number;
}

interface FreeActions {
  claimRomResources: boolean;   // claim shards + dust from ROMs
  romEnergyMode: "claim" | "convert" | "skip";  // claim energy to pool, convert to dust, or skip
  openChests: boolean;
  breakPots: boolean;
  sellFish: boolean;
  vote: boolean;
  tradeHugis: boolean;          // execute affordable traveling-merchant deals
  repairGear: boolean;          // repair worn hands/rods/lures/equipped gear first
  /**
   * Pay a pond's higher entry offering when one is affordable.
   *
   * Off by default and never inferred. The Grove's tier 2 and 3 offerings
   * multiply Cores by 2x and 4x, but they are bought with faction rings —
   * Legendary collectables — and whether a ring is worth 4x Cores on a single
   * cast is a market question, not something the planner should answer on its
   * own. Tier 1 is free and is what gets sent unless this is on.
   */
  spendEntryOfferings: boolean;
}

interface Preset {
  name: string;
  dungeonAllocs: DungeonAlloc[];
  fishingAllocs: FishingAlloc[];
  /** Presets saved before the plan supported more than one pond */
  fishingAlloc?: LegacyFishingAlloc;
  freeActions: FreeActions;
}

// "skipped" means the plan had nothing to do for this step.
// "not-run" means the run ended before reaching it — a different fact,
// and the one that matters after a failure.
type StepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "not-run";

type LogType = "loot" | "dungeon" | "fishing" | "error" | "info";

interface McLogEntry {
  id: number;
  msg: string;
  type: LogType;
  ts: number;
}

interface ExecutionStep {
  id: string;
  label: string;
  status: StepStatus;
  /** Full detail — itemized where the step spends or liquidates something. */
  detail: string;
  /** One-line form for the compact plan preview. Falls back to `detail`. */
  brief?: string;
}

/* ─── Helpers ──────────────────────────────────────────────── */

function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePresets(presets: Preset[]) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

/**
 * A saved allocation from before the plan could hold more than one pond.
 *
 * Kept only so `migrateFishingAllocs` can read it — nothing else should know
 * the single-node shape ever existed.
 */
interface LegacyFishingAlloc {
  castNodeId: string;
  castCost: number;
  castLabel: string;
  casts: number;
}

/**
 * Turn whatever was in localStorage into a list of per-pond allocations.
 *
 * A saved single alloc names a node, and the node names the pond — so the
 * migration is lossless. An unrecognised node (one from a pond that has since
 * closed, or a node that never existed) is dropped rather than filed under
 * pond 1.
 */
function migrateFishingAllocs(
  saved: FishingAlloc[] | LegacyFishingAlloc | undefined
): FishingAlloc[] {
  if (!saved) return [];
  const list = Array.isArray(saved) ? saved : [saved];
  const out: FishingAlloc[] = [];
  for (const a of list) {
    if (!a || typeof a.castNodeId !== "string") continue;
    const pond = openPonds().find((p) => p.nodes.some((n) => n.nodeId === a.castNodeId));
    if (!pond) continue;
    const node = pond.nodes.find((n) => n.nodeId === a.castNodeId)!;
    out.push({
      pondId: pond.pondId,
      castNodeId: node.nodeId,
      castCost: node.cost,
      castLabel: node.label,
      casts: Math.max(0, a.casts ?? 0),
    });
  }
  return out;
}

function loadLastAlloc(): {
  dungeonAllocs?: DungeonAlloc[];
  fishingAllocs?: FishingAlloc[];
  /** Pre-multi-pond saves */
  fishingAlloc?: LegacyFishingAlloc;
  freeActions?: FreeActions;
} | null {
  try {
    const raw = localStorage.getItem(LAST_ALLOC_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Migrate old freeActions format
    if (data?.freeActions && "claimRoms" in data.freeActions) {
      const old = data.freeActions;
      data.freeActions = {
        claimRomResources: old.claimRoms ?? true,
        romEnergyMode: old.convertEnergy ? "convert" : "skip",
        openChests: old.openChests ?? true,
        breakPots: old.breakPots ?? true,
        sellFish: old.sellFish ?? true,
        vote: old.vote ?? true,
      };
    }
    // Saved allocs from before Hugis auto-trade / auto-repair existed
    if (data?.freeActions && !("tradeHugis" in data.freeActions)) {
      data.freeActions.tradeHugis = true;
    }
    if (data?.freeActions && !("repairGear" in data.freeActions)) {
      data.freeActions.repairGear = true;
    }
    // Offering rings are Legendary collectables, so a save from before the
    // toggle existed must not start spending them.
    if (data?.freeActions && !("spendEntryOfferings" in data.freeActions)) {
      data.freeActions.spendEntryOfferings = false;
    }
    return data;
  } catch {
    return null;
  }
}

function saveLastAlloc(data: { dungeonAllocs: DungeonAlloc[]; fishingAllocs: FishingAlloc[]; freeActions: FreeActions }) {
  localStorage.setItem(LAST_ALLOC_KEY, JSON.stringify(data));
}

function getCooldownInfo(
  recipeId: string,
  worldRecipes: { docId: string; COOLDOWN_CID: number }[],
  playerRecipes: { entities?: { ID_CID: string; END_TIMESTAMP_CID: number }[] } | null
): { text: string; onCooldown: boolean; remainingSec: number } {
  const recipe = worldRecipes.find((r) => r.docId === recipeId);
  const progress = playerRecipes?.entities?.find((p) => p.ID_CID === recipeId);
  if (!recipe?.COOLDOWN_CID) return { text: "", onCooldown: false, remainingSec: 0 };
  if (!progress) return { text: "Ready", onCooldown: false, remainingSec: 0 };
  const expiresAt = progress.END_TIMESTAMP_CID + recipe.COOLDOWN_CID;
  const remaining = expiresAt - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return { text: "Ready", onCooldown: false, remainingSec: 0 };
  const hours = Math.floor(remaining / 3600);
  const days = Math.floor(hours / 24);
  return { text: days > 0 ? `${days}d ${hours % 24}h` : `${hours}h`, onCooldown: true, remainingSec: remaining };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function statusIcon(status: StepStatus): string {
  switch (status) {
    case "pending": return "\u25CB";   // hollow circle
    case "running": return "\u25CF";   // filled circle (pulsing via CSS)
    case "done": return "\u2713";      // checkmark
    case "failed": return "\u2717";    // x mark
    case "skipped": return "\u2013";   // dash
    case "not-run": return "\u2298";   // circled slash
  }
}

// Glyph + color alone carry the whole status, which a screen reader reads as
// "x mark, Blue Pot". This is rendered as sr-only text beside the glyph.
function statusLabel(status: StepStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "running": return "Running";
    case "done": return "Done";
    case "failed": return "Failed";
    case "skipped": return "Skipped, nothing to do";
    case "not-run": return "Not run, the run ended first";
  }
}

function statusColor(status: StepStatus): string {
  switch (status) {
    case "pending": return "var(--text-faint)";
    case "running": return "var(--orange)";
    case "done": return "var(--green)";
    case "failed": return "var(--red)";
    case "skipped": return "var(--text-faint)";
    case "not-run": return "var(--text-dim)";
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside an open dialog and restores focus to the trigger on close.
 * Returns a cleanup function for use as a useEffect teardown.
 */
function trapFocus(panel: HTMLElement | null, onEscape: () => void): () => void {
  const trigger = document.activeElement as HTMLElement | null;
  panel?.focus();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      onEscape();
      return;
    }
    if (e.key !== "Tab" || !panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === panel
    );
    if (items.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  window.addEventListener("keydown", onKey);
  return () => {
    window.removeEventListener("keydown", onKey);
    trigger?.focus?.();
  };
}

function loadLastRun(): string | null {
  try {
    return localStorage.getItem(LAST_RUN_KEY);
  } catch {
    return null;
  }
}

/* ─── Component ────────────────────────────────────────────── */

export function MissionControlPage({ giga, addLog, handleVote, hasVoted, refreshRunStats }: MissionControlProps) {
  const gigaRef = useRef(giga);
  gigaRef.current = giga;

  const cancelRef = useRef(false);
  const [executing, setExecuting] = useState(false);
  const [steps, setSteps] = useState<ExecutionStep[]>([]);
  const stepsRef = useRef<ExecutionStep[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  // Itemised haul from the last run. Counts alone ("7 fish caught") don't tell
  // you whether the energy was well spent; the actual items do.
  const [haul, setHaul] = useState<{ id: number; name: string; amount: number; rarity?: number }[]>([]);
  const [summaryFailed, setSummaryFailed] = useState(false);
  // Announced to screen readers one line at a time. The step list itself is
  // not a live region — re-rendering it on every updateStep would re-announce
  // the whole plan.
  const [liveMessage, setLiveMessage] = useState("");
  const [mcLog, setMcLog] = useState<McLogEntry[]>([]);
  const mcLogIdRef = useRef(0);
  const progressRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const adjustRef = useRef<HTMLDivElement>(null);
  const [showModal, setShowModal] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [adjustSection, setAdjustSection] = useState<"energy" | "free" | "merchant" | "presets">("energy");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmTrade, setConfirmTrade] = useState<string | null>(null);
  const [confirmRepairAll, setConfirmRepairAll] = useState(false);
  const restoredEmptyRef = useRef(false);
  /**
   * Dungeon count the saved plan was last restored for, or null when a restore
   * is still pending. Stops the restore re-running on unrelated data changes.
   */
  const restoredOnceRef = useRef<number | null>(null);
  const autoAppliedRef = useRef(false);

  // Restore the last run's summary so a reload mid-run or after one doesn't
  // erase the record of what was spent.
  useEffect(() => {
    const last = loadLastRun();
    if (last) {
      setSummary(last);
      setSummaryFailed(last.startsWith("Run stopped"));
    }
  }, []);

  // Two-press confirmations disarm on a timer rather than on blur, so tabbing
  // to read the confirm label doesn't silently cancel it.
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(null), 5000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  useEffect(() => {
    if (!confirmTrade) return;
    const t = setTimeout(() => setConfirmTrade(null), 5000);
    return () => clearTimeout(t);
  }, [confirmTrade]);

  useEffect(() => {
    if (!confirmRepairAll) return;
    const t = setTimeout(() => setConfirmRepairAll(false), 5000);
    return () => clearTimeout(t);
  }, [confirmRepairAll]);


  // Presets
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [showPresetInput, setShowPresetInput] = useState(false);

  // Load presets on mount
  useEffect(() => {
    setPresets(loadPresets());
  }, []);

  // Energy state
  const eng = giga.energy?.entities?.[0]?.parsedData;
  const currentEnergy = Math.floor(eng?.energyValue ?? 0);
  const maxEnergy = eng?.maxEnergy ?? 240;

  // Dungeon data. Memoised because the `?? []` fallbacks allocate a fresh array
  // every render, which would make anything depending on them recompute
  // constantly — including the runs-remaining derivation below.
  const dungeons = useMemo(
    () => giga.dungeonToday?.dungeonDataEntities ?? [],
    [giga.dungeonToday]
  );
  const dayProgress = useMemo(
    () => giga.dungeonToday?.dayProgressEntities ?? [],
    [giga.dungeonToday]
  );

  // Initialize dungeon allocations
  const [dungeonAllocs, setDungeonAllocs] = useState<DungeonAlloc[]>([]);
  // One entry per node the plan spends casts on. Empty means no fishing today.
  const [fishingAllocs, setFishingAllocs] = useState<FishingAlloc[]>([]);
  const [freeActions, setFreeActions] = useState<FreeActions>({
    claimRomResources: true,
    romEnergyMode: "convert",
    openChests: true,
    breakPots: true,
    sellFish: true,
    vote: true,
    tradeHugis: true,
    repairGear: true,
    spendEntryOfferings: false,
  });

  /**
   * Runs still available today, per dungeon.
   *
   * Derived, never stored: the allocation table is initialised once when the
   * dungeon list loads, so a `maxRuns` captured there goes stale the moment a
   * run completes. That is how the advisor came to warn about 7 Forbidden
   * Woods runs when only 2 remained, and would have planned runs the server
   * refuses. Only the user's chosen `runs` belongs in state; the cap is a fact
   * about the day and is read fresh.
   */
  const runsRemaining = useMemo(() => {
    const out: Record<number, number> = {};
    for (const d of dungeons) {
      const used = dayProgress.find((p) => p.ID_CID === `Dungeon#${d.ID_CID}`)?.UINT256_CID ?? 0;
      out[d.ID_CID] = Math.max(0, getMaxRunsPerDay(d, eng?.isPlayerJuiced ?? false) - used);
    }
    return out;
  }, [dungeons, dayProgress, eng?.isPlayerJuiced]);

  const remainingFor = useCallback(
    (alloc: { dungeonId: number; maxRuns: number }) => runsRemaining[alloc.dungeonId] ?? alloc.maxRuns,
    [runsRemaining]
  );

  // Initialize dungeon allocs when data arrives
  useEffect(() => {
    if (dungeons.length === 0) return;
    // Keyed on the dungeon count rather than a plain boolean so a genuine change
    // to the dungeon list still rebuilds the rows, which is what this effect did
    // before deferral existed.
    if (restoredOnceRef.current === dungeons.length) return;
    const last = loadLastAlloc();

    // Saved casts can only be clamped against the day's allowance once the
    // fishing state is in, so when it isn't they are deferred to a later pass.
    //
    // Deferred, not blocking: an earlier version of this returned here and took
    // the dungeon restore down with it, so a missing fishing state emptied the
    // whole plan and left `restoredEmptyRef` unset — which is the flag the
    // advisor's auto-apply reads, so no plan appeared at all. Fishing readiness
    // has no business gating dungeon allocation.
    const hasSavedCasts = migrateFishingAllocs(
      last?.fishingAllocs ?? last?.fishingAlloc
    ).some((a) => a.casts > 0);
    const castsDeferred = hasSavedCasts && !giga.fishingState;
    // Left unset while casts are deferred, so the effect runs again when the
    // fishing state lands and the casts can finally be clamped.
    restoredOnceRef.current = castsDeferred ? null : dungeons.length;

    // Filter out item-cost dungeons (like Temporal Void) that don't use energy
    const currentEnergy = Math.floor(eng?.energyValue ?? 0);
    let energyBudget = currentEnergy;

    const allocs = dungeons.filter((d) => d.ENERGY_CID > 0).map((d) => {
      const progressEntry = dayProgress.find((p) => p.ID_CID === `Dungeon#${d.ID_CID}`);
      const runsToday = progressEntry?.UINT256_CID ?? 0;
      const maxRuns = getMaxRunsPerDay(d, eng?.isPlayerJuiced ?? false) - runsToday;
      const saved = last?.dungeonAllocs?.find((a) => a.dungeonId === d.ID_CID);
      // Clamp saved runs by both max runs remaining AND available energy
      let runs = saved ? Math.min(saved.runs, maxRuns) : 0;
      if (d.ENERGY_CID > 0) {
        const maxByEnergy = Math.floor(energyBudget / d.ENERGY_CID);
        runs = Math.min(runs, maxByEnergy);
        energyBudget -= runs * d.ENERGY_CID;
      }
      return {
        dungeonId: d.ID_CID,
        name: d.NAME_CID,
        energyCost: d.ENERGY_CID,
        runs,
        maxRuns: Math.max(0, maxRuns),
      };
    });
    setDungeonAllocs(allocs);

    // Saved casts, clamped by the energy actually available AND by the casts the
    // day has left. The clamp walks the list rather than dividing once, because
    // the entries can be on different nodes at different prices and both budgets
    // are shared between them.
    //
    // The daily clamp is the one the dungeon branch above has always had and
    // this one lacked. Without it, running the plan a second time in one day
    // restored the first run's cast count verbatim: 18 saved casts, all still
    // affordable, every one already spent. The plan showed 18, the server
    // refused 18. It was never intermittent — it happened every second run.
    const castsLeftToday = castAllowance(
      giga.fishingState, eng?.isPlayerJuiced ?? false, FISHING
    ).left;

    const savedCasts = migrateFishingAllocs(last?.fishingAllocs ?? last?.fishingAlloc);
    const restoredCasts = castsDeferred
      ? []
      : clampRestoredCasts(savedCasts, { energy: energyBudget, castsLeftToday });
    setFishingAllocs(restoredCasts);

    if (last?.freeActions) {
      setFreeActions(last.freeActions);
    }

    // Plan-first: if nothing was restored, the advisor's plan fills in once it's ready
    restoredEmptyRef.current =
      allocs.every((a) => a.runs === 0) && restoredCasts.length === 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dungeons.length, giga.fishingState]);

  // Fishing state
  const fs = giga.fishingState;
  const isJuiced = eng?.isPlayerJuiced ?? false;
  const allowance = castAllowance(fs, isJuiced, FISHING);
  const castsKnown = allowance.known;
  const remainingCasts = allowance.left;

  // Mission Control plans against the cast allowance, but nothing on the way in
  // fetches it — `connect` deliberately skips the fishing state, and the
  // Fishing tab is what usually loads it. Land here first and the plan would
  // wait on a number that was never going to be asked for.
  const castsRequestedRef = useRef(false);
  useEffect(() => {
    if (!giga.token || !giga.address || giga.fishingState || castsRequestedRef.current) return;
    // Once per mount: a failed fetch returns null without setting state, and
    // retrying on every render would hammer the endpoint.
    castsRequestedRef.current = true;
    giga.fetchFishingState();
  }, [giga]);

  // Casts already planned, which the steppers cap against. One number because
  // the allowance is one pool — a pond does not have casts of its own.
  const plannedCasts = fishingAllocs.reduce((s, a) => s + a.casts, 0);
  const unplannedCasts = Math.max(0, remainingCasts - plannedCasts);

  // Execution order. During The Awakening, Core-yielding dungeons run first:
  // if a run fails or energy comes up short, the spend that survives should be
  // the one that expires with the event, not the scrap that's farmable forever.
  // Both the previewed step list and the executor read this, so what the plan
  // shows is the order it actually runs in.
  const orderedDungeonAllocs = useMemo(() => {
    if (!isAwakeningActive()) return dungeonAllocs;
    return [...dungeonAllocs].sort(
      (a, b) => Number(isEventDungeon(b.name)) - Number(isEventDungeon(a.name))
    );
  }, [dungeonAllocs]);

  // Allocated energy
  const dungeonEnergy = dungeonAllocs.reduce((s, d) => s + d.runs * d.energyCost, 0);
  const fishingEnergy = fishingAllocs.reduce((s, a) => s + a.casts * a.castCost, 0);
  const allocatedEnergy = dungeonEnergy + fishingEnergy;

  // ROM stats
  const roms = giga.roms?.entities ?? [];
  const totalRomE = roms.reduce((s, r) => s + Math.floor(r.factoryStats.energyCollectable), 0);
  // Energy the plan can actually spend: pool + ROM energy when it will be
  // claimed as energy before the runs start. A claim can't push the pool past
  // its cap, so only the headroom counts — budgeting the full ROM balance at
  // full energy plans a run that can't be paid for.
  const romEnergyClaimable = Math.min(totalRomE, Math.max(0, maxEnergy - currentEnergy));
  const effectiveEnergy =
    currentEnergy + (freeActions.romEnergyMode === "claim" ? romEnergyClaimable : 0);
  const totalRomS = roms.reduce((s, r) => s + Math.floor(r.factoryStats.shardCollectable), 0);
  const totalRomD = roms.reduce((s, r) => s + Math.floor(r.factoryStats.dustCollectable), 0);

  // Recipe cooldowns
  const chestCd = getCooldownInfo(RECIPE_ITEMS.chest, giga.worldRecipes, giga.playerRecipes);
  const juiceChestCd = getCooldownInfo(RECIPE_ITEMS.juiceChest, giga.worldRecipes, giga.playerRecipes);
  const juiceChestForestCd = getCooldownInfo(RECIPE_ITEMS.juiceChestForest, giga.worldRecipes, giga.playerRecipes);
  const bluePotCd = getCooldownInfo(RECIPE_ITEMS.bluePot, giga.worldRecipes, giga.playerRecipes);
  const tanPotCd = getCooldownInfo(RECIPE_ITEMS.tanPot, giga.worldRecipes, giga.playerRecipes);
  const juicedNow = eng?.isPlayerJuiced ?? false;
  const chestsReady =
    !chestCd.onCooldown ||
    (juicedNow && (!juiceChestCd.onCooldown || !juiceChestForestCd.onCooldown));

  // Find hands gear for pots.
  //
  // Durability is part of the test, not an afterthought. Matching on name alone
  // returned whichever pair was found first — including one at zero uses — so
  // the panel reported the pot ready and the break then failed against hands
  // that had nothing left in them.
  const findHandsGear = (handsType: "Paper Hands" | "Rock Hands"): string => {
    const owned = giga.gearInstances?.entities ?? [];
    const match = handsType === "Paper Hands" ? "paper" : "rock";
    return (
      usableHands(owned, giga.gearDefs, (id) => giga.itemInfo[String(id)]?.name || "", match)
        ?.docId ?? ""
    );
  };
  const paperHandsId = findHandsGear("Paper Hands");
  const rockHandsId = findHandsGear("Rock Hands");
  const bluePotReady = !bluePotCd.onCooldown && !!paperHandsId;
  const tanPotReady = !tanPotCd.onCooldown && !!rockHandsId;
  const potsActuallyReady = bluePotReady || tanPotReady;

  // Fish stall info
  const fishStallInfo = useMemo(() => {
    const rates = fs?.exchangeRates || [];
    const balMap = giga.itemBalances;
    const fish = rates
      .map((r) => {
        const qty = balMap[String(r.id)] ?? 0;
        if (qty <= 0) return null;
        const pct = Math.round(((r.value - r.baseVal) / r.baseVal) * 100);
        // pondId identifies which stall buys this fish; the sell call is
        // rejected without it now that the Grove added a second one.
        return { id: r.id, qty, value: r.value, pct, pondId: r.pondId };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null && f.pct >= 50);
    const totalCount = fish.reduce((s, f) => s + f.qty, 0);
    // Split by pond: the two stalls pay different currencies, so one total
    // would be adding Seaweed to Infused Sediment.
    const byPond = new Map<number, number>();
    for (const f of fish) byPond.set(f.pondId, (byPond.get(f.pondId) ?? 0) + f.value * f.qty);
    const proceeds = Array.from(byPond, ([pondId, amount]) => ({
      pondId, amount, label: pondCurrencyLabel(pondId),
    }));
    return { fish, totalCount, proceeds };
  }, [fs?.exchangeRates, giga.itemBalances]);

  /**
   * Ponds where a better entry offering is currently affordable.
   *
   * Reported, not taken. The offering multiplies a cast's Cores by 2x or 4x but
   * costs a faction ring, and rings are Legendary collectables — trading one
   * for a single cast's Cores is a call the planner should surface rather than
   * make. Until the Grove shipped, tier 1 was the only tier ever sent.
   */
  const entryOfferings = useMemo(() => {
    const tiers = fs?.pondEntryTiers;
    return openPonds()
      .map((p) => ({ pond: p, ...pondEntryOptions(tiers, p.pondId, giga.itemBalances, giga.currentDay) }))
      // With no free tier at all, any payable tier is worth surfacing — it is
      // the only way to cast that pond.
      .filter((o) => o.payable != null && o.payable.dropMultiplier > (o.free?.dropMultiplier ?? 0));
  }, [fs?.pondEntryTiers, giga.itemBalances, giga.currentDay]);

  // Save current allocation to localStorage when it changes
  useEffect(() => {
    if (dungeonAllocs.length > 0) {
      saveLastAlloc({ dungeonAllocs, fishingAllocs, freeActions });
    }
  }, [dungeonAllocs, fishingAllocs, freeActions]);

  /* ─── Energy Advisor ────────────────────────────────────── */

  // Per-dungeon run history (last 30 days) for performance-aware advice.
  // `avg_item_amount` is the event Core drop per run, which is what lets the
  // advisor rank a dungeon run against a pond cast on measured return.
  const [dungeonPerf, setDungeonPerf] = useState<
    Record<string, { total_runs: number; wins: number; avg_rooms: number; avg_item_amount?: number | null }>
  >({});
  useEffect(() => {
    if (!giga.address) return;
    getDungeonPerformanceAction(giga.address, AWAKENING.coreItemId)
      .then((rows) => {
        const map: Record<string, { total_runs: number; wins: number; avg_rooms: number; avg_item_amount?: number | null }> = {};
        for (const r of rows) map[r.dungeon_name] = r;
        setDungeonPerf(map);
      })
      .catch(() => {});
  }, [giga.address]);

  // Measured Cores per cast, per pond. Empty until casts have been recorded —
  // the advisor treats an absent entry as "unmeasured", never as zero.
  const [pondYields, setPondYields] = useState<Record<number, number | null>>({});
  useEffect(() => {
    if (!giga.address) return;
    getPondYieldsAction(giga.address, AWAKENING.coreItemId)
      .then((rows) => {
        const map: Record<number, number | null> = {};
        for (const r of rows) map[r.pond_id] = r.avg_item_amount;
        setPondYields(map);
      })
      .catch(() => {});
  }, [giga.address]);

  /** Ponds castable right now, with whatever yield history exists for each. */
  const advisorPonds = useMemo(
    () =>
      openPonds().map((p) => ({
        pondId: p.pondId,
        name: p.name,
        nodes: p.nodes.map((n) => ({ ...n })),
        eventPriority: p.pondId === AWAKENING.pondId,
        coresPerCast: pondYields[p.pondId] ?? null,
      })),
    [pondYields]
  );

  const recommendation = useMemo<AdvisorResult | null>(() => {
    if (dungeonAllocs.length === 0 || !eng) return null;
    return buildRecommendation({
      currentEnergy,
      maxEnergy,
      regenPerHour: eng.regenPerHour || (isJuiced ? 17.5 : 10),
      isJuiced,
      romEnergyAvailable: totalRomE,
      dungeons: dungeonAllocs.map((d) => {
        const perf = dungeonPerf[d.name];
        return {
          dungeonId: d.dungeonId,
          name: d.name,
          energyCost: d.energyCost,
          runsLeft: remainingFor(d),
          winRate: perf && perf.total_runs > 0 ? perf.wins / perf.total_runs : null,
          avgRooms: perf?.avg_rooms ?? null,
          totalRuns: perf?.total_runs ?? 0,
          eventPriority: isEventDungeon(d.name),
          coresPerRun: perf?.avg_item_amount ?? null,
        };
      }),
      // One shared pool. Which pond each cast lands in is the advisor's call.
      fishingCastsLeft: remainingCasts,
      ponds: advisorPonds,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dungeonAllocs, currentEnergy, maxEnergy, isJuiced, totalRomE, dungeonPerf, remainingCasts, advisorPonds]);

  const applyRecommendation = () => {
    if (!recommendation) return;
    setDungeonAllocs((prev) =>
      prev.map((d) => {
        const rec = recommendation.dungeonRuns.find((r) => r.dungeonId === d.dungeonId);
        return { ...d, runs: rec ? Math.min(rec.runs, remainingFor(d)) : 0 };
      })
    );
    // The advisor returns one entry per pond it wants casts in. Reading a
    // single one used to drop every Grove cast on the floor — the advisor said
    // "10x Grove cast, 120E" while the plan allocated none, so a run spent a
    // fraction of the pool and the rest had to be run again.
    setFishingAllocs(
      recommendation.fishing
        .filter((f) => f.casts > 0)
        .flatMap((f) => {
          const node = CAST_NODES.find(
            (n) => n.nodeId === f.nodeId && n.pondId === f.pondId
          );
          // A recommendation for a node this build does not know about is not
          // something to approximate — drop it and let the plan come up short
          // visibly rather than casting somewhere else.
          if (!node) return [];
          return [{
            pondId: node.pondId,
            castNodeId: node.nodeId,
            castCost: node.cost,
            castLabel: node.label,
            casts: f.casts,
          }];
        })
    );
    if (recommendation.claimRomEnergy) {
      setFreeActions((prev) => ({ ...prev, romEnergyMode: "claim" }));
    }
  };

  // Land on the advisor's plan when there's nothing saved to restore
  useEffect(() => {
    if (autoAppliedRef.current || !restoredEmptyRef.current || !recommendation) return;
    if (dungeonAllocs.length === 0) return;
    autoAppliedRef.current = true;
    applyRecommendation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendation, dungeonAllocs.length]);

  // Event dungeons (Void): item-based entry, not part of the energy plan
  const eventDungeons = dungeons.filter((d) => d.ENERGY_CID === 0 && (d.entryData?.length ?? 0) > 0);

  // Gear the server has told us is out of repairs this session. It reports
  // "already at max repair count N of N" and publishes no constant for that
  // ceiling, so the ceiling is learned rather than guessed.
  const [unrepairable, setUnrepairable] = useState<Set<string>>(new Set());

  // Gear that's broken or one use from it — only gear the daily loop needs
  // (equipped dungeon gear, hands for pots, rods/lures for fishing)
  const allWornGear = useMemo(() => {
    const out: {
      docId: string; name: string; gameItemId: number; durability: number;
      equipped: boolean; spent: boolean;
    }[] = [];
    for (const g of giga.gearInstances?.entities ?? []) {
      const name = giga.itemInfo[String(g.GAME_ITEM_ID_CID)]?.name || `Gear #${g.GAME_ITEM_ID_CID}`;
      const lower = name.toLowerCase();
      const relevant =
        g.EQUIPPED_TO_SLOT_CID >= 0 ||
        ["hand", "rod", "lure"].some((k) => lower.includes(k));
      if (!relevant) continue;
      if (g.DURABILITY_CID <= 1) {
        out.push({
          docId: g.docId, name, gameItemId: g.GAME_ITEM_ID_CID,
          durability: g.DURABILITY_CID, equipped: g.EQUIPPED_TO_SLOT_CID >= 0,
          // Read from the definitions rather than waited for. The server will
          // refuse a repair on these, and it used to be the only thing that
          // knew: the piece sat under "Gear needs repair", went into the plan,
          // and moved to the restore section only after the run had already
          // tried and failed on it.
          spent: isRepairExhausted(g, giga.gearDefs[g.GAME_ITEM_ID_CID]),
        });
      }
    }
    return out;
  }, [giga.gearInstances, giga.itemInfo, giga.gearDefs]);

  // Still worn, but repair will be refused — these need the restore flow, so
  // they stay visible as a warning and out of every repair attempt.
  //
  // Two sources, because they cover different gaps: the definitions answer
  // before anything is attempted, and `unrepairable` catches the pieces whose
  // definition never loaded, where the server's refusal is the only evidence
  // there is.
  const exhaustedGear = useMemo(
    () => allWornGear.filter((g) => g.spent || unrepairable.has(g.docId)),
    [allWornGear, unrepairable]
  );
  const wornGear = useMemo(
    () => allWornGear.filter((g) => !g.spent && !unrepairable.has(g.docId)),
    [allWornGear, unrepairable]
  );

  /**
   * Gear worth making next, from the game's own recipes and effect tables.
   *
   * Capped at three per activity. The full list runs to dozens and a wall of
   * craftables is a catalogue, not advice — the ranking already puts a dead
   * slot above an empty one above an upgrade, so the top of each list is the
   * part that changes anything.
   */
  const gearAdvice = useMemo(() => {
    const itemName = (id: number) =>
      giga.itemInfo[String(id)]?.name || giga.itemNames[String(id)] || `#${id}`;
    const input = {
      defs: giga.gearDefs,
      recipes: giga.worldRecipes as GearRecipe[],
      balances: giga.itemBalances,
      owned: giga.gearInstances?.entities ?? [],
      itemName,
    };
    const all = suggestGear(input);
    const dungeon = all.filter((s) => s.purpose === "dungeon").slice(0, 3);
    const fishing = all.filter((s) => s.purpose === "fishing").slice(0, 3);
    const shown = [...dungeon, ...fishing];
    const ready = shown.filter((s) => s.affordable).length;
    return {
      dungeon,
      fishing,
      stranded: deadSlotsWithoutOptions(input, all),
      itemName,
      // Counts what the panel would list, not the whole catalogue — a summary
      // promising nine suggestions that opens onto six is worse than no summary.
      summary:
        ready > 0
          ? `${ready} you can make now${shown.length > ready ? ` · ${shown.length - ready} short` : ""}`
          : `${shown.length} short on materials`,
    };
  }, [giga.gearDefs, giga.worldRecipes, giga.itemBalances, giga.gearInstances, giga.itemInfo, giga.itemNames]);

  // What is actually worn, and what is wrong with it. Separate from the worn-
  // gear scan above, which only ever looks at damage — a healthy pair of hands
  // in the bag is not damaged, and an empty hands slot is why a pot refuses.
  const loadout = useMemo(
    () =>
      buildLoadout(
        giga.gearInstances?.entities ?? [],
        giga.gearDefs,
        (id) => giga.itemInfo[String(id)]?.name || giga.itemNames[String(id)] || `#${id}`
      ),
    [giga.gearInstances, giga.gearDefs, giga.itemInfo, giga.itemNames]
  );
  const kitWarnings = useMemo(
    () => loadoutWarnings(loadout, emptyWoodsSlots(loadout)),
    [loadout]
  );

  /**
   * The one line that has to survive the section being shut.
   *
   * Both gear panels sit collapsed by default, so the header is the only thing
   * most days show. It counts problems rather than naming gear: "2 finished"
   * is a reason to open the panel, where a list of six slot names is just the
   * panel again, worse.
   */
  const kitSummary = useMemo(() => {
    const count = (kind: string) => kitWarnings.filter((w) => w.kind === kind).length;
    const parts: string[] = [];
    const woods = count("woods-slot-empty");
    if (woods > 0) parts.push(`${woods} Woods slot${woods === 1 ? "" : "s"} empty`);
    const dead = count("equipped-dead");
    if (dead > 0) parts.push(`${dead} finished`);
    const low = count("equipped-low");
    if (low > 0) parts.push(`${low} nearly broken`);
    const swap = count("bench-beats-equipped") + count("slot-empty-with-bench");
    if (swap > 0) parts.push(`${swap} to swap`);
    return parts.length > 0
      ? parts.join(" · ")
      : `${loadout.length} slot${loadout.length === 1 ? "" : "s"}, nothing wrong`;
  }, [kitWarnings, loadout]);

  const [repairing, setRepairing] = useState(false);

  const repairWorn = useCallback(async (items: { docId: string; name: string }[], log?: (m: string) => void) => {
    const emit = log ?? addLog;
    setRepairing(true);
    let repaired = 0;
    const exhausted: string[] = [];
    try {
      for (const item of items) {
        const r = await gigaRef.current.repairGear(item.docId);
        // repairGear swallows transport errors and returns null, so anything
        // that isn't an explicit success is a failure — reporting null as
        // "Repaired" is how a 500 used to look like it worked.
        const ok = r != null && r.success !== false;
        if (ok) {
          repaired++;
          emit(`Repaired ${item.name}`);
        } else {
          const msg = r?.message || gigaRef.current.lastErrorRef.current || "failed";
          emit(`Repair ${item.name}: ${msg}`);
          if (/max repair count/i.test(msg)) exhausted.push(item.docId);
        }
        await delay(300);
      }
    } finally {
      setRepairing(false);
      if (exhausted.length > 0) {
        setUnrepairable((prev) => new Set([...prev, ...exhausted]));
      }
    }
    return repaired;
  }, [addLog]);

  /**
   * Restore one gear instance — the flow repair itself points at once an
   * instance is out of repairs.
   *
   * What restore costs has never been observed and is published nowhere, so
   * this is deliberately one instance per click rather than a "restore all":
   * the first one tells you the price before the rest of the bag spends it.
   * On success the instance leaves the exhausted list and becomes repairable
   * again, since its repair count is the thing restore is expected to clear.
   */
  const [restoring, setRestoring] = useState<string | null>(null);

  const restoreOne = useCallback(async (item: { docId: string; name: string }) => {
    setRestoring(item.docId);
    try {
      const r = await gigaRef.current.restoreGear(item.docId);
      const ok = r != null && r.success !== false;
      if (ok) {
        addLog(`Restored ${item.name}${r?.message ? `: ${r.message}` : ""}`);
        setUnrepairable((prev) => {
          const next = new Set(prev);
          next.delete(item.docId);
          return next;
        });
      } else {
        // The server's own words. This is the only place the cost of a restore
        // has ever been visible, so it is not summarised away.
        addLog(`Restore ${item.name}: ${r?.message || gigaRef.current.lastErrorRef.current || "failed"}`);
      }
    } finally {
      setRestoring(null);
    }
  }, [addLog]);

  // Traveling merchant (Hugis/Munis) deals — read-only until the trade POST
  // is captured; shape probed defensively since only the GET is verified
  const merchantDeals = useMemo(() => {
    const itemName = (id: number) =>
      giga.itemInfo[String(id)]?.name || giga.itemNames[String(id)] || `#${id}`;
    return (giga.vendorListings?.entities ?? []).map((e, i) => {
      const inputs = (e.INPUT_ID_CID_array ?? []).map((id, j) => ({
        id,
        name: itemName(id),
        amount: e.INPUT_AMOUNT_CID_array?.[j] ?? 1,
      }));
      const outputs = (e.LOOT_ID_CID_array ?? []).map((id, j) => ({
        id,
        name: itemName(id),
        amount: e.LOOT_AMOUNT_CID_array?.[j] ?? 1,
      }));
      const done = e.COMPLETIONS_CID ?? e.DAY_COUNT_CID ?? 0;
      const max = e.MAX_COMPLETIONS_CID;
      const affordable =
        inputs.length > 0 &&
        inputs.every((inp) => (giga.itemBalances[String(inp.id)] ?? 0) >= inp.amount);
      // Trades execute via /api/offchain/recipes/start with a Recipe#9xxxx id
      // (captured Aug 2026) — only offer the button when the id looks right
      const recipeId =
        typeof e.ID_CID === "string" && e.ID_CID.startsWith("Recipe#")
          ? e.ID_CID
          : typeof e.docId === "string" && e.docId.startsWith("Recipe#")
          ? e.docId
          : null;
      return {
        key: e.docId || e.ID_CID || String(i),
        recipeId,
        name: e.NAME_CID || `Deal ${i + 1}`,
        inputs,
        outputs,
        done,
        max,
        affordable,
        capped: max !== undefined && done >= max,
      };
    });
  }, [giga.vendorListings, giga.itemInfo, giga.itemNames, giga.itemBalances]);

  // The Merchant tab only exists while there are deals to show
  useEffect(() => {
    if (adjustSection === "merchant" && merchantDeals.length === 0) setAdjustSection("energy");
  }, [adjustSection, merchantDeals.length]);

  /* ─── Stepper helpers ────────────────────────────────────── */

  const adjustDungeon = (idx: number, delta: number) => {
    setDungeonAllocs((prev) => {
      const next = [...prev];
      const d = next[idx];
      const newRuns = Math.max(0, Math.min(remainingFor(d), d.runs + delta));
      const energyDelta = (newRuns - d.runs) * d.energyCost;
      if (allocatedEnergy + energyDelta > effectiveEnergy && delta > 0) return prev;
      next[idx] = { ...d, runs: newRuns };
      return next;
    });
  };

  /** Casts currently planned on one node. */
  const castsForNode = (nodeId: string) =>
    fishingAllocs.find((a) => a.castNodeId === nodeId)?.casts ?? 0;

  /**
   * Move casts on or off one node.
   *
   * Two ceilings apply and they are different things: energy, and the shared
   * daily cast pool. Adding a Grove cast has to be refused when the pool is
   * spoken for even if there is plenty of energy, because the pool is what the
   * server actually counts.
   */
  const adjustFishingNode = (nodeId: string, delta: number) => {
    const node = CAST_NODES.find((n) => n.nodeId === nodeId);
    if (!node) return;
    setFishingAllocs((prev) => {
      const current = prev.find((a) => a.castNodeId === nodeId)?.casts ?? 0;
      const plannedElsewhere = prev.reduce(
        (s, a) => s + (a.castNodeId === nodeId ? 0 : a.casts),
        0
      );
      const poolCeiling = Math.max(0, remainingCasts - plannedElsewhere);
      const next = Math.max(0, Math.min(poolCeiling, current + delta));
      if (next === current) return prev;
      const energyDelta = (next - current) * node.cost;
      if (delta > 0 && allocatedEnergy + energyDelta > effectiveEnergy) return prev;
      return upsertCasts(prev, node, next);
    });
  };

  /** Put `casts` on a node, adding or removing its row as needed. */
  const upsertCasts = (
    allocs: FishingAlloc[],
    node: (typeof CAST_NODES)[number],
    casts: number
  ): FishingAlloc[] => {
    const without = allocs.filter((a) => a.castNodeId !== node.nodeId);
    if (casts <= 0) return without;
    return [
      ...without,
      {
        pondId: node.pondId,
        castNodeId: node.nodeId,
        castCost: node.cost,
        castLabel: node.label,
        casts,
      },
    ];
  };

  const maxDungeon = (idx: number) => {
    setDungeonAllocs((prev) => {
      const next = [...prev];
      const d = next[idx];
      const spare = effectiveEnergy - allocatedEnergy;
      const affordable = d.runs + Math.floor(spare / d.energyCost);
      next[idx] = { ...d, runs: Math.max(0, Math.min(remainingFor(d), affordable)) };
      return next;
    });
  };

  const maxFishingNode = (nodeId: string) => {
    const node = CAST_NODES.find((n) => n.nodeId === nodeId);
    if (!node) return;
    setFishingAllocs((prev) => {
      const current = prev.find((a) => a.castNodeId === nodeId)?.casts ?? 0;
      const plannedElsewhere = prev.reduce(
        (s, a) => s + (a.castNodeId === nodeId ? 0 : a.casts),
        0
      );
      const spare = effectiveEnergy - allocatedEnergy;
      const affordable = current + Math.floor(spare / node.cost);
      const poolCeiling = Math.max(0, remainingCasts - plannedElsewhere);
      return upsertCasts(prev, node, Math.max(0, Math.min(poolCeiling, affordable)));
    });
  };

  /* ─── Preset handlers ───────────────────────────────────── */

  const savePreset = () => {
    if (!presetName.trim()) return;
    const preset: Preset = {
      name: presetName.trim(),
      dungeonAllocs,
      fishingAllocs,
      freeActions,
    };
    const updated = [...presets.filter((p) => p.name !== preset.name), preset];
    setPresets(updated);
    savePresets(updated);
    setPresetName("");
    setShowPresetInput(false);
  };

  const loadPreset = (preset: Preset) => {
    // Apply preset allocs, capping to current limits
    const newAllocs = dungeonAllocs.map((d) => {
      const saved = preset.dungeonAllocs.find((a) => a.dungeonId === d.dungeonId);
      return { ...d, runs: saved ? Math.min(saved.runs, remainingFor(d)) : 0 };
    });
    setDungeonAllocs(newAllocs);
    // Presets predating multi-pond hold a single alloc; migrate on read. Casts
    // are then trimmed against the shared pool in order, since the preset may
    // have been saved on a day with a fuller allowance.
    let poolLeft = remainingCasts;
    setFishingAllocs(
      migrateFishingAllocs(preset.fishingAllocs ?? preset.fishingAlloc)
        .map((a) => {
          const casts = Math.min(a.casts, poolLeft);
          poolLeft -= casts;
          return { ...a, casts };
        })
        .filter((a) => a.casts > 0)
    );
    setFreeActions(preset.freeActions);
  };

  const deletePreset = (name: string) => {
    const updated = presets.filter((p) => p.name !== name);
    setPresets(updated);
    savePresets(updated);
  };

  /* ─── Execution Engine ──────────────────────────────────── */

  const updateStep = useCallback((id: string, update: Partial<ExecutionStep>) => {
    setSteps((prev) => {
      const next = prev.map((s) => {
        if (s.id !== id) return s;
        // Announce only status changes — detail updates fire once per dungeon
        // room and would flood the live region.
        if (update.status && update.status !== s.status) {
          setLiveMessage(`${s.label}: ${statusLabel(update.status).toLowerCase()}`);
        }
        return { ...s, ...update };
      });
      stepsRef.current = next;
      return next;
    });
  }, []);

  interface RunSummaryStats {
    dungeonRuns: number;
    dungeonWins: number;
    fishCasts: number;
    fishCaught: number;
    /** Stall proceeds per pond. Separate currencies, so never one figure. */
    currencyByPond: Map<number, number>;
  }

  /**
   * Name and sort raw item deltas for display.
   *
   * Shared by the live haul and the final one so the list never reshuffles or
   * renames itself at the moment the run ends — the rows you watched arrive are
   * the rows you keep.
   */
  const toHaulRows = useCallback((deltas: { id: number; amount: number }[]) => {
    const info = gigaRef.current.itemInfo;
    const names = gigaRef.current.itemNames;
    return deltas
      .map((d) => ({
        id: d.id,
        name: info[String(d.id)]?.name || names[String(d.id)] || `Item #${d.id}`,
        amount: d.amount,
        rarity: info[String(d.id)]?.rarity,
      }))
      .sort((a, b) => b.amount - a.amount);
  }, []);

  // Fill the haul pane while the run is still going. The capture is a plain
  // module-level accumulator with no change notification, so this samples it;
  // a second is well under the pace loot actually arrives at and costs a map
  // over a handful of entries.
  useEffect(() => {
    if (!executing) return;
    const id = setInterval(() => setHaul(toHaulRows(peekHaulCapture())), 1000);
    return () => clearInterval(id);
  }, [executing, toHaulRows]);

  // The summary has to report what actually happened, including steps that
  // failed or never ran. Reading the live step list from a ref keeps that
  // honest without waiting for a state flush.
  const finishRun = useCallback(
    (
      outcome: "done" | "cancelled" | "error",
      stats: RunSummaryStats,
      errorMessage?: string
    ) => {
      const parts: string[] = [];
      if (stats.dungeonRuns > 0) parts.push(`${stats.dungeonRuns} dungeon runs (${stats.dungeonWins}W)`);
      if (stats.fishCasts > 0) parts.push(`${stats.fishCasts} casts, ${stats.fishCaught} fish caught`);
      // Named per pond, never totalled: Seaweed and Infused Sediment are
      // different items feeding different skill trees, and one combined number
      // is not a quantity of anything.
      for (const [pondId, amount] of stats.currencyByPond) {
        if (amount > 0) parts.push(`${fmt(amount)} ${pondCurrencyLabel(pondId)}`);
      }

      const failed = stepsRef.current.filter((s) => s.status === "failed").length;
      const notRun = stepsRef.current.filter((s) => s.status === "not-run").length;
      if (failed > 0) parts.push(`${failed} step${failed === 1 ? "" : "s"} failed`);
      if (notRun > 0) parts.push(`${notRun} never ran`);

      const done = parts.length > 0 ? parts.join(", ") : "nothing to report";
      const text =
        outcome === "error"
          ? `Run stopped after an error: ${errorMessage}. ${done}.`
          : outcome === "cancelled"
          ? `Stopped by you. ${done}.`
          : `Done! ${done}.`;

      // Close the capture even on error or cancel — a partial run still earned
      // whatever it earned, and that is exactly when you want to see it.
      setHaul(toHaulRows(endHaulCapture()));

      setSummary(text);
      setSummaryFailed(outcome !== "done" || failed > 0);
      setLiveMessage(text);
      try {
        localStorage.setItem(LAST_RUN_KEY, text);
      } catch { /* private mode / quota — the in-session summary still stands */ }
    },
    [toHaulRows]
  );

  // Builds the plan's step list from current state. Used three ways: the
  // Today's Plan preview, the review modal, and the execution run itself.
  const buildStepList = (): ExecutionStep[] => {
    const stepList: ExecutionStep[] = [];
    if (freeActions.repairGear && wornGear.length > 0)
      stepList.push({ id: "repair-gear", label: "Repair worn gear", status: "pending", detail: wornGear.map((g) => g.name).join(", ") });
    if (freeActions.claimRomResources && (totalRomS > 0 || totalRomD > 0))
      stepList.push({ id: "claim-roms", label: "Claim ROM shards & dust", status: "pending", detail: `${fmt(totalRomS)}S / ${fmt(totalRomD)}D` });
    if (freeActions.romEnergyMode === "convert" && totalRomE > 0)
      stepList.push({ id: "convert-energy", label: "Convert ROM energy to dust", status: "pending", detail: `${fmt(totalRomE)}E` });
    if (freeActions.romEnergyMode === "claim" && totalRomE > 0)
      stepList.push({
        id: "claim-energy",
        label: "Claim ROM energy",
        status: "pending",
        // Says up front what the run will do with a full pool, rather than
        // listing 168E as if it were about to arrive.
        detail: romEnergyClaimable > 0
          ? `${fmt(romEnergyClaimable)}E`
          : `${fmt(totalRomE)}E — will be skipped, the pool is already at ${fmt(maxEnergy)}E`,
      });
    if (freeActions.openChests && chestsReady)
      stepList.push({ id: "open-chests", label: "Open chests", status: "pending", detail: "" });
    if (freeActions.breakPots && potsActuallyReady)
      stepList.push({ id: "break-pots", label: "Break pots", status: "pending", detail: "" });
    if (freeActions.vote && !hasVoted)
      stepList.push({ id: "vote", label: "Vote on Abstract Portal", status: "pending", detail: "" });
    const hugisDeals = merchantDeals.filter((d) => d.recipeId && d.affordable && !d.capped);
    if (freeActions.tradeHugis && hugisDeals.length > 0)
      stepList.push({
        id: "hugis",
        label: "Traveling merchant trades",
        status: "pending",
        // Itemized: these trades permanently remove materials from inventory,
        // so the review has to show what leaves and what arrives.
        detail: hugisDeals
          .map(
            (d) =>
              `${d.inputs.map((i) => `${i.amount}x ${i.name}`).join(" + ")} → ${
                d.outputs.map((o) => `${o.amount}x ${o.name}`).join(" + ") || d.name
              }`
          )
          .join("\n"),
        brief: `${hugisDeals.length} deal${hugisDeals.length === 1 ? "" : "s"}`,
      });

    for (const d of orderedDungeonAllocs) {
      if (d.runs > 0) {
        stepList.push({ id: `dungeon-${d.dungeonId}`, label: `${d.name} x${d.runs}`, status: "pending", detail: `${d.runs * d.energyCost}E` });
      }
    }
    // One step per node, so a plan that splits the pool between ponds shows
    // both halves and the executor has something to attach status to for each.
    for (const a of fishingAllocs) {
      if (a.casts <= 0) continue;
      // The node label is there to tell one node from another, so it only earns
      // its place on a pond that has more than one. The Grove has a single node
      // named "Grove", which read as "Dendren Grove Grove x20".
      const pond = pondById(a.pondId);
      const label = pond.nodes.length > 1
        ? `${pond.name} ${a.castLabel} x${a.casts}`
        : `${pond.name} x${a.casts}`;
      stepList.push({
        id: `fishing-${a.castNodeId}`,
        label,
        status: "pending",
        detail: `${a.casts * a.castCost}E`,
      });
    }
    if (freeActions.sellFish && fishStallInfo.totalCount > 0) {
      const byFish = fishStallInfo.fish
        .map((f) => {
          const name = giga.itemInfo[String(f.id)]?.name || giga.itemNames[String(f.id)] || `#${f.id}`;
          return `${f.qty}x ${name} (+${f.pct}%)`;
        })
        .join("\n");
      stepList.push({
        id: "sell-fish",
        label: "Sell +50% fish",
        status: "pending",
        // Liquidating inventory — name every fish, not just the count.
        detail: `${byFish}\n${fmt(fishStallInfo.totalCount)} fish → ~${fishStallInfo.proceeds.map((p) => `${fmt(p.amount)} ${p.label}`).join(" + ")}`,
        brief: `${fmt(fishStallInfo.totalCount)} fish → ~${fishStallInfo.proceeds.map((p) => `${fmt(p.amount)} ${p.label}`).join(" + ")}`,
      });
    }
    return stepList;
  };

  const execute = async () => {
    cancelRef.current = false;
    setExecuting(true);
    setSummary(null);
    setSummaryFailed(false);
    setHaul([]);
    beginHaulCapture();
    setLiveMessage("Run started");
    setMcLog([]);
    mcLogIdRef.current = 0;
    gigaRef.current.autoBattleRef.current = true;

    const g = () => gigaRef.current;

    // Log to both parent log and local MC log panel. The type is passed in
    // rather than inferred from the prose — matching English with a regex made
    // every copy edit silently reclassify an entry's icon and color.
    const log = (msg: string, type: LogType = "info") => {
      addLog(msg);
      const id = ++mcLogIdRef.current;
      setMcLog((prev) => [...prev, { id, msg, type, ts: Date.now() }]);
      // Errors are the one log class worth interrupting a screen reader for.
      if (type === "error") setLiveMessage(msg);
    };

    // Build step list
    const stepList = buildStepList();
    const gearToRepair = [...wornGear];
    const hugisDeals = merchantDeals.filter((d) => d.recipeId && d.affordable && !d.capped);

    stepsRef.current = stepList;
    setSteps(stepList);

    setShowModal(true);

    const summaryStats: RunSummaryStats = {
      dungeonRuns: 0, dungeonWins: 0, fishCasts: 0, fishCaught: 0,
      currencyByPond: new Map(),
    };
    const addCurrency = (pondId: number, amount: number) => {
      if (amount <= 0) return;
      summaryStats.currencyByPond.set(
        pondId, (summaryStats.currencyByPond.get(pondId) ?? 0) + amount
      );
    };

    // Cast bookkeeping lives out here, alongside summaryStats, so the `finally`
    // can flush a finished cast even when the run dies partway through. A cast
    // that completed still happened, and its yield is what the advisor ranks
    // ponds by.
    //
    // Carried across allocations, because the server's fishing state is global
    // rather than per-pond: a catch waiting to be looted was made in whichever
    // pond was last cast in, and the loot call that collects it is also what
    // starts the next cast — possibly in a different pond.
    let pendingCardsToAdd: { id: number }[] | null = null;

    /**
     * A finished cast whose payout has not all arrived yet.
     *
     * The `loot` action both collects the previous catch and opens the next
     * cast, so the Cores on that response belong to the cast that just ended,
     * not the one just started. Holding the record open until loot lands is
     * what keeps measured pond yield attributed to the right pond.
     */
    let pendingCastRecord:
      | { pondId: number; nodeId: string; energyCost: number; multiplier: number; caught: boolean; gains: Map<number, number> }
      | null = null;

    const mergeGains = (into: Map<number, number>, changes?: { id: number; amount: number }[]) => {
      for (const c of changes ?? []) into.set(c.id, (into.get(c.id) ?? 0) + c.amount);
    };

    /**
     * Records the open cast, if any. Idempotent — clears before it writes.
     *
     * A cast whose catch is still waiting to be collected is DISCARDED rather
     * than recorded. The `loot` call is what delivers the payout, so filing the
     * cast before it lands writes a real cast down as a zero-yield one — and
     * every run's final cast ends in exactly that state, which would bias every
     * pond's measured rate downward by one cast per run, permanently. An
     * unmeasured cast is honest; a falsely empty one corrupts the ordering the
     * advisor spends real energy on.
     */
    const flushCastRecord = () => {
      const rec = pendingCastRecord;
      pendingCastRecord = null;
      if (!rec) return;
      if (pendingCardsToAdd && pendingCardsToAdd.length > 0) {
        log(
          `${pondCurrencyLabel(rec.pondId)} cast not recorded — its catch is still uncollected, so the payout hasn't arrived yet.`,
          "info"
        );
        return;
      }
      const items = Array.from(rec.gains, ([id, amount]) => ({
        id,
        amount,
        name: g().itemInfo[String(id)]?.name || g().itemNames[String(id)] || `#${id}`,
      }));
      recordCastAction(
        rec.pondId, rec.nodeId, rec.energyCost, rec.multiplier, rec.caught, items, g().address
      ).catch(() => {});
    };

    try {
      // 0. Repair worn gear — before anything that needs hands/rods/equipped gear
      if (stepList.find((s) => s.id === "repair-gear")) {
        if (cancelRef.current) throw new Error("cancelled");
        updateStep("repair-gear", { status: "running" });
        const repaired = await repairWorn(gearToRepair, log);
        updateStep("repair-gear", {
          status: cancelRef.current ? "skipped" : "done",
          detail: `${repaired}/${gearToRepair.length} repaired`,
        });
      }

      // 1. Claim ROMs
      if (stepList.find((s) => s.id === "claim-roms")) {
        if (cancelRef.current) throw new Error("cancelled");
        updateStep("claim-roms", { status: "running" });
        let count = 0;
        for (const rom of g().roms?.entities ?? []) {
          if (cancelRef.current) break;
          const fStats = rom.factoryStats;
          // Only claim shards and dust — energy is handled separately
          const types: string[] = [];
          if (Math.floor(fStats.shardCollectable) > 0) types.push("shard");
          if (Math.floor(fStats.dustCollectable) > 0) types.push("dust");
          for (const t of types) {
            if (cancelRef.current) break;
            try {
              const r = await g().claimRom(rom.docId, t);
              if (r?.success) { count++; log(`claimed ${t} #${fStats.serialNumber}`); }
            } catch { /* already claimed or rate limited */ }
            await delay(200);
          }
        }
        updateStep("claim-roms", { status: cancelRef.current ? "skipped" : "done", detail: `${count} claims` });
      }

      // 2a. Claim ROM energy (to player pool)
      if (stepList.find((s) => s.id === "claim-energy")) {
        if (cancelRef.current) throw new Error("cancelled");
        updateStep("claim-energy", { status: "running" });

        // Energy claimed into a full pool is either refused or lost over the
        // cap, and this step has no way to tell which. Not attempting it is the
        // only outcome that is definitely not a loss — and the energy keeps
        // accruing on the ROM meanwhile.
        const pool = g().energy?.entities?.[0]?.parsedData;
        const headroom = Math.max(0, (pool?.maxEnergy ?? 0) - Math.floor(pool?.energyValue ?? 0));
        const onRoms = (g().roms?.entities ?? []).reduce(
          (s, r) => s + Math.floor(r.factoryStats.energyCollectable), 0
        );

        if (pool && headroom <= 0) {
          const why =
            `pool is full at ${Math.floor(pool.energyValue)}/${pool.maxEnergy}E — ${fmt(onRoms)}E left on the ROMs rather than risking it over the cap. Spend energy first, then claim.`;
          log(`ROM energy not claimed: ${why}`, "error");
          updateStep("claim-energy", { status: "skipped", detail: why });
        } else {
          let claimed = 0;
          let refused = 0;
          for (const rom of g().roms?.entities ?? []) {
            if (cancelRef.current) break;
            const amt = Math.floor(rom.factoryStats.energyCollectable);
            if (amt <= 0) continue;
            try {
              const r = await g().claimRom(rom.docId, "energy");
              // claimRom resolves to null on a rejected request rather than
              // throwing, so a refusal and a success both used to land here as
              // a silent non-increment and the step still reported "done".
              if (r?.success) {
                claimed++;
                log(`claimed energy #${rom.factoryStats.serialNumber}`);
              } else {
                refused++;
                log(
                  `ROM #${rom.factoryStats.serialNumber} refused the ${fmt(amt)}E claim: ${g().error || "no reason given"}`,
                  "error"
                );
              }
            } catch (e) {
              refused++;
              log(
                `ROM #${rom.factoryStats.serialNumber} refused the ${fmt(amt)}E claim: ${e instanceof Error ? e.message : "unknown"}`,
                "error"
              );
            }
            await delay(200);
          }
          const detail = refused > 0
            ? `${claimed} claimed, ${refused} refused — that energy is still on the ROMs`
            : `${claimed} ROMs`;
          updateStep("claim-energy", {
            status: cancelRef.current ? "skipped" : refused > 0 && claimed === 0 ? "failed" : "done",
            detail,
          });
        }
      }

      // 2b. Convert ROM energy to dust
      if (stepList.find((s) => s.id === "convert-energy")) {
        if (cancelRef.current) throw new Error("cancelled");
        updateStep("convert-energy", { status: "running" });
        let total = 0;
        for (const rom of g().roms?.entities ?? []) {
          if (cancelRef.current) break;
          const amt = Math.floor(rom.factoryStats.energyCollectable);
          if (amt <= 0) continue;
          try {
            const r = await g().convertEnergyToDust(rom.docId, amt);
            if (r?.success) { total += amt; log(`converted ${amt}E #${rom.factoryStats.serialNumber}`); }
          } catch { /* conversion may fail if energy was already claimed */ }
          await delay(200);
        }
        updateStep("convert-energy", { status: cancelRef.current ? "skipped" : "done", detail: `${total}E converted` });
      }

      // 3. Open chests
      if (stepList.find((s) => s.id === "open-chests")) {
        if (cancelRef.current) throw new Error("cancelled");
        updateStep("open-chests", { status: "running" });
        const results: string[] = [];
        if (!chestCd.onCooldown) {
          try {
            const r = await g().useRecipe(RECIPE_ITEMS.chest);
            if (r?.success !== false) {
              const loot = formatRecipeLoot(r, g().itemInfo, g().itemNames);
              const msg = loot.length > 0 ? `Chest opened — ${loot.join(", ")}` : "Chest opened";
              results.push(msg);
              log(msg, "loot");
            } else {
              const msg = `Chest: ${(r as { message?: string })?.message || "failed"}`;
              results.push(msg);
              log(msg, "error");
            }
          } catch (e) { results.push(`Chest: ${e instanceof Error ? e.message : "error"}`); }
          await delay(200);
        }
        // Both juiced chests: the original and the Awakening forest one. They
        // are separate weekly claims on separate cooldowns.
        const juicedChests = CLAIM_RECIPES.filter((r) => r.needsJuice && !r.handsType).map((r) => ({
          recipe: r.id,
          label: r.label,
          ready: !getCooldownInfo(r.id, g().worldRecipes, g().playerRecipes).onCooldown,
        }));
        for (const jc of juicedChests) {
          if (!jc.ready) continue;
          if (!(g().energy?.entities?.[0]?.parsedData?.isPlayerJuiced ?? false)) continue;
          try {
            const r = await g().useRecipe(jc.recipe);
            if (r?.success !== false) {
              const loot = formatRecipeLoot(r, g().itemInfo, g().itemNames);
              const msg = loot.length > 0 ? `${jc.label} opened — ${loot.join(", ")}` : `${jc.label} opened`;
              results.push(msg);
              log(msg, "loot");
            } else {
              const msg = `${jc.label}: ${(r as { message?: string })?.message || "failed"}`;
              results.push(msg);
              log(msg, "error");
            }
          } catch (e) { results.push(`${jc.label}: ${e instanceof Error ? e.message : "error"}`); }
          await delay(200);
        }
        updateStep("open-chests", { status: "done", detail: results.join(", ") });
      }

      // 4. Break pots (needs gear instance IDs for hands)
      if (stepList.find((s) => s.id === "break-pots")) {
        if (cancelRef.current) throw new Error("cancelled");
        updateStep("break-pots", { status: "running" });
        const results: string[] = [];
        if (bluePotReady && paperHandsId) {
          try {
            const r = await g().useRecipe(RECIPE_ITEMS.bluePot, paperHandsId);
            if (r?.success !== false) {
              const loot = formatRecipeLoot(r, g().itemInfo, g().itemNames);
              const msg = loot.length > 0 ? `Blue Pot broken — ${loot.join(", ")}` : "Blue Pot broken";
              results.push(msg);
              log(msg, "loot");
            } else {
              const msg = `Blue Pot: ${(r as { message?: string })?.message || "failed"}`;
              results.push(msg);
              log(msg, "error");
            }
          } catch (e) { results.push(`Blue Pot: ${e instanceof Error ? e.message : "error"}`); }
          await delay(200);
        }
        if (tanPotReady && rockHandsId) {
          try {
            const r = await g().useRecipe(RECIPE_ITEMS.tanPot, rockHandsId);
            if (r?.success !== false) {
              const loot = formatRecipeLoot(r, g().itemInfo, g().itemNames);
              const msg = loot.length > 0 ? `Tan Pot broken — ${loot.join(", ")}` : "Tan Pot broken";
              results.push(msg);
              log(msg, "loot");
            } else {
              const msg = `Tan Pot: ${(r as { message?: string })?.message || "failed"}`;
              results.push(msg);
              log(msg, "error");
            }
          } catch (e) { results.push(`Tan Pot: ${e instanceof Error ? e.message : "error"}`); }
        }
        updateStep("break-pots", { status: results.length > 0 ? "done" : "skipped", detail: results.join(", ") || "No pots available" });
      }

      // 5. Vote
      if (stepList.find((s) => s.id === "vote")) {
        if (cancelRef.current) throw new Error("cancelled");
        updateStep("vote", { status: "running" });
        try {
          await handleVote();
          updateStep("vote", { status: "done", detail: "Voted!" });
        } catch (e) {
          updateStep("vote", { status: "failed", detail: e instanceof Error ? e.message : "failed" });
        }
      }

      // 5b. Traveling merchant trades (each deal to its cap while affordable)
      if (stepList.find((s) => s.id === "hugis")) {
        if (cancelRef.current) throw new Error("cancelled");
        updateStep("hugis", { status: "running" });
        let trades = 0;
        const results: string[] = [];
        for (const deal of hugisDeals) {
          if (cancelRef.current) break;
          const remaining = deal.max !== undefined ? Math.max(1, deal.max - deal.done) : 1;
          for (let t = 0; t < remaining; t++) {
            if (cancelRef.current) break;
            // Re-check affordability against live balances (earlier trades spend them)
            const canAfford = deal.inputs.every(
              (inp) => (g().itemBalances[String(inp.id)] ?? 0) >= inp.amount
            );
            if (!canAfford) break;
            try {
              const r = await g().useRecipe(deal.recipeId!);
              if (r?.success === false) {
                const msg = `${deal.name}: ${(r as { message?: string })?.message || "failed"}`;
                results.push(msg);
                log(msg, "error");
                break;
              }
              trades++;
              const loot = formatRecipeLoot(r, g().itemInfo, g().itemNames);
              const msg = loot.length > 0 ? `${deal.name} — ${loot.join(", ")}` : `${deal.name} traded`;
              results.push(msg);
              log(msg, "loot");
            } catch (e) {
              results.push(`${deal.name}: ${e instanceof Error ? e.message : "error"}`);
              break;
            }
            await delay(300);
          }
        }
        updateStep("hugis", {
          status: cancelRef.current ? "skipped" : "done",
          detail: trades > 0 ? `${trades} trades — ${results[results.length - 1] ?? ""}` : "nothing affordable",
        });
      }

      // Refresh before energy-consuming steps
      await g().refreshAll();

      // Fetch fresh dungeon state + actionToken before dungeon runs.
      // Free actions above (ROM claims, recipes) rotated the server token.
      const preState = await g().fetchDungeonState();

      // If there's a stuck/active run, play through it (combat + loot)
      if (preState?.data?.run) {
        log(`Active dungeon run found (${preState.message}, loot=${preState.data.run.lootPhase}), finishing it...`, "dungeon");
        let s = preState;
        for (let i = 0; i < 150 && s?.data?.run; i++) {
          if (cancelRef.current) break;
          // Run fully complete and no loot pending — done
          if (s.message === "Run Complete" && !s.data.run.lootPhase) break;

          let action = pickBestAction(s, g().enemyNames);
          // If in loot phase but pickBestAction can't see options, default to loot_one
          if (!action && s.data.run.lootPhase) {
            log(`Collecting loot...`, "dungeon");
            action = "loot_one";
          }
          if (!action) {
            log(`Cannot advance stuck run`, "error");
            break;
          }

          const result = await g().performAction(action);
          if (!result) {
            log(`Action failed during stuck run, recovering...`, "error");
            const fresh = await g().fetchDungeonState();
            if (fresh) { s = fresh; await delay(150); continue; }
            break;
          }
          s = result;
          await delay(150);
        }
        log(`Stuck run finished (${s?.message})`, "dungeon");
        await g().fetchDungeonState();
        await delay(500);
      }

      // 6. Dungeon runs
      for (const alloc of orderedDungeonAllocs) {
        if (alloc.runs <= 0) continue;
        const stepId = `dungeon-${alloc.dungeonId}`;
        if (cancelRef.current) { updateStep(stepId, { status: "skipped" }); continue; }
        updateStep(stepId, { status: "running", detail: "starting..." });

        const runResults: string[] = [];
        const lootTotals = new Map<number, number>();

        for (let run = 0; run < alloc.runs; run++) {
          if (cancelRef.current) break;
          updateStep(stepId, { detail: `Run ${run + 1}/${alloc.runs} starting...` });
          log(`Starting ${alloc.name} run ${run + 1}/${alloc.runs}`, "dungeon");

          try {
            // Highest offering we can pay for from inventory. The server picks
            // which faction ring it wants, so a rejected tier retries at 1
            // rather than losing the run.
            const dungeonData = dungeons.find((d) => d.ID_CID === alloc.dungeonId);
            const entryTier = pickEntryTier(dungeonData?.entryData, giga.itemBalances);
            let startResult = await g().startRun(alloc.dungeonId, false, [], entryTier);
            if (!startResult && entryTier > 1) {
              log(`${alloc.name}: tier ${entryTier} offering refused, entering at tier 1`, "dungeon");
              await delay(300);
              startResult = await g().startRun(alloc.dungeonId, false, [], 1);
            }

            if (!startResult || startResult.success === false) {
              await delay(500);
              startResult = await g().startRun(alloc.dungeonId);
              if (!startResult || startResult.success === false) {
                log(`Could not start ${alloc.name}: ${g().lastErrorRef.current || "unknown"}`, "error");
                runResults.push(...Array(alloc.runs - run).fill("err"));
                break;
              }
            }

            let battleState = startResult;
            let complete = false;
            let iterations = 0;
            let lastRoom = 0;
            const MAX_ITERATIONS = 100;
            const runItems = new Map<number, { name: string; amount: number }>();

            const trackLoot = (resp: typeof battleState) => {
              if (resp?.gameItemBalanceChanges) {
                for (const c of resp.gameItemBalanceChanges) {
                  lootTotals.set(c.id, (lootTotals.get(c.id) ?? 0) + c.amount);
                  const name = g().itemInfo[String(c.id)]?.name || g().itemNames[String(c.id)] || `#${c.id}`;
                  const prev = runItems.get(c.id);
                  runItems.set(c.id, { name, amount: (prev?.amount ?? 0) + c.amount });
                  log(`Loot: ${c.amount}x ${name}`, "loot");
                }
              }
            };
            trackLoot(battleState);

            let consecutiveFailures = 0;

            while (!complete && iterations < MAX_ITERATIONS) {
              if (cancelRef.current) break;
              iterations++;
              if (!battleState) break;

              // Track room progress
              const curRoom = battleState.data?.entity?.ROOM_NUM_CID ?? lastRoom;
              if (curRoom > lastRoom) {
                lastRoom = curRoom;
                updateStep(stepId, { detail: `Run ${run + 1}/${alloc.runs} — Room ${curRoom}` });
              }

              if (battleState.message === "Run Complete" && !battleState.data?.run?.lootPhase) {
                complete = true;
                runResults.push(String(curRoom));
                log(`${alloc.name} run ${run + 1}: reached room ${curRoom}`, "dungeon");
                break;
              }

              // Loot phase
              if (battleState.data?.run?.lootPhase) {
                const lootAction = pickBestAction(battleState, g().enemyNames);
                if (lootAction) {
                  const lootResult = await g().performAction(lootAction);
                  if (lootResult) {
                    battleState = lootResult;
                    trackLoot(lootResult);
                  } else {
                    // Token desync — fetch fresh state to recover
                    log(`Loot action failed, recovering state...`, "error");
                    const fresh = await g().fetchDungeonState();
                    if (fresh) { battleState = fresh; trackLoot(fresh); }
                    else break;
                  }
                  await delay(150);
                  continue;
                }
              }

              const action = pickBestAction(battleState, g().enemyNames);
              if (!action) {
                // No legal action means this run is over — usually death.
                // runResults is shared across the whole allocation, so leaving
                // without recording the room makes the next reader inherit the
                // PREVIOUS run's room and win flag, writing a phantom clear
                // into the history the advisor ranks dungeons by.
                runResults.push(String(battleState.data?.entity?.ROOM_NUM_CID ?? lastRoom));
                break;
              }

              // Enemy charges as they stood before this exchange — the probe
              // can't recover them from the post-action state.
              const enemyBefore = battleState.data?.run?.players?.[1] ?? null;
              const result = await g().performAction(action);
              if (!result) {
                const fresh = await g().fetchDungeonState();
                if (!fresh?.data?.run || fresh.message === "Run Complete") {
                  const room = fresh?.data?.entity?.ROOM_NUM_CID ?? lastRoom;
                  runResults.push(String(room));
                  log(`${alloc.name} run ${run + 1}: reached room ${room}`, "dungeon");
                  trackLoot(fresh!);
                  complete = true;
                  break;
                }
                consecutiveFailures++;
                if (consecutiveFailures >= 3) break;
                battleState = fresh;
                await delay(500);
                continue;
              }
              consecutiveFailures = 0;
              battleState = result;
              trackLoot(result);

              // Opt-in probe: validates that enemy charges deplete and scores
              // the predictor against its 1/3 baseline. No-op unless enabled.
              const enemy = result.data?.run?.players?.[1];
              const entity = result.data?.entity;
              if (enemy?.lastMove && entity && entity.ENEMY_CID >= 0) {
                const stats =
                  g().enemyNames[String(entity.ENEMY_CID)]?.stats ??
                  g().enemyNames[`idx:${entity.ENEMY_CID}`]?.stats;
                probeEnemyMove(enemyBefore, enemy, entity.ENEMY_CID, entity.ROOM_NUM_CID, stats, result.data?.run?.players?.[0]);
              }

              if (result.message === "Run Complete" && !result.data?.run?.lootPhase) {
                complete = true;
                const room = result.data?.entity?.ROOM_NUM_CID ?? lastRoom;
                runResults.push(String(room));
                log(`${alloc.name} run ${run + 1}: reached room ${room}`, "dungeon");
              }

              await delay(150);
            }
            // Record run to stats DB
            const finalRoom = Number(runResults[runResults.length - 1]) || lastRoom;
            const player = battleState?.data?.run?.players?.[0];
            const won = didWinRun(player?.health?.current, finalRoom);
            if (won) summaryStats.dungeonWins++;
            const items = Array.from(runItems, ([id, v]) => ({ id, amount: v.amount, name: v.name }));
            recordRunAction(
              alloc.name, won, finalRoom,
              player?.health?.current ?? 0, player?.health?.currentMax ?? 0,
              items, [], g().address
            ).catch(() => {});
          } catch (e) {
            log(`Error: ${e instanceof Error ? e.message : "unknown"}`, "error");
            runResults.push("err");
          }

          summaryStats.dungeonRuns++;
          if (run < alloc.runs - 1) {
            await g().fetchDungeonState();
            await delay(500);
          }
        }

        // Build detail string: rooms reached + loot summary
        const roomsStr = `rooms: ${runResults.join(", ")}`;
        const lootParts: string[] = [];
        for (const [id, amt] of lootTotals) {
          const name = g().itemInfo[String(id)]?.name || g().itemNames[String(id)] || `#${id}`;
          lootParts.push(`${amt}x ${name}`);
        }
        const detail = lootParts.length > 0
          ? `${roomsStr} | ${lootParts.join(", ")}`
          : roomsStr;

        updateStep(stepId, {
          status: cancelRef.current ? "skipped" : "done",
          detail,
        });
        // Fetch fresh state + token for next dungeon alloc or fishing
        const interState = await g().fetchDungeonState();
        // If there's a stuck/active run (e.g. uncollected loot), finish it
        if (interState?.data?.run) {
          log(`Cleaning up pending run between allocs (${interState.message}, loot=${interState.data.run.lootPhase})`, "dungeon");
          let s = interState;
          for (let i = 0; i < 50 && s?.data?.run; i++) {
            if (cancelRef.current) break;
            if (s.message === "Run Complete" && !s.data.run.lootPhase) break;
            let action = pickBestAction(s, g().enemyNames);
            if (!action && s.data.run.lootPhase) action = "loot_one";
            if (!action) break;
            const result = await g().performAction(action);
            if (!result) {
              const fresh = await g().fetchDungeonState();
              if (fresh) { s = fresh; await delay(150); continue; }
              break;
            }
            s = result;
            await delay(150);
          }
          await g().fetchDungeonState();
        }
      }

      // 7. Fishing casts, one block per pond the plan spends casts in.
      const plannedFishing = fishingAllocs.filter(
        (a) => a.casts > 0 && stepList.find((s) => s.id === `fishing-${a.castNodeId}`)
      );

      /**
       * The fishing state as it was moments before the first cast.
       *
       * Hoisted out of the block below because the cast budget is recounted
       * from it, and that recount has to happen where the casts are spent.
       */
      let preFish: FishingGameState | null = null;

      if (plannedFishing.length > 0) {
        // Check if there's a completed game needing loot (card pick + collect)
        preFish = await g().fetchFishingState();
        const owed = pendingCatchCards(preFish?.gameState);
        if (owed) {
          pendingCardsToAdd = owed;
          log(`Previous catch pending, cards to pick: ${owed.map((c) => c.id).join(", ")}`, "fishing");
          // A catch left over from an earlier fishing day. Every cast below
          // opens with the loot that collects it, so if the server won't take
          // that loot, nothing else in the plan can run either — worth naming
          // before the first failure rather than after the twentieth.
          const catchDay = preFish?.gameState?.DAY_CID;
          const today = g().currentDay;
          if (typeof catchDay === "number" && typeof today === "number" && catchDay < today) {
            log(
              `That catch is from fishing day ${catchDay} and today is ${today}. If the loot is refused, collect it in the game client — casts can't start while it's outstanding.`,
              "error"
            );
          }
        } else if (preFish?.gameState?.data && !preFish.gameState.COMPLETE_CID) {
            // Active in-progress game — play through it first
            log(`Active fishing game found, finishing it...`, "fishing");
            let redrawsThisCast = 0;
            for (let i = 0; i < 50; i++) {
              if (cancelRef.current) break;
              const fs = await g().fetchFishingState();
              if (!fs?.gameState?.data || fs.gameState.COMPLETE_CID) {
                pendingCardsToAdd = pendingCatchCards(fs?.gameState);
                break;
              }
              const gd = fs.gameState.data;
              if (!gd.hand || gd.hand.length === 0) { await delay(300); continue; }
              // The Grove picks card and lure together; other ponds keep the
              // board-cell path.
              const grove = gd.focusMechanicEnabled ? pickGroveMove(gd) : null;
              if (gd.focusMechanicEnabled && !grove) break;
              // Redraw is play_cards with an empty hand: discards and refills
              // for one mana per card held.
              if (grove?.redraw && redrawsThisCast < MAX_REDRAWS_PER_CAST) {
                redrawsThisCast++;
                log(grove.reason, "info");
                await g().fishingAction("play_cards", {
                  cards: [], nodeId: "", focusPoint: gd.focusPoint ?? [],
                });
                await delay(300);
                continue;
              }
              const best = grove
                ? { handIndex: grove.handIndex }
                : pickBestCard(
                    gd.hand, gd.deckCardData, gd.fishPosition, gd.previousFishPosition, gd.nextPosition,
                    resolveGrid(gd)
                  );
              const cr = await g().fishingAction("play_cards", {
                cards: [best.handIndex], nodeId: "",
                focusPoint: grove ? grove.focusPoint : (gd.focusPoint ?? []),
              });
              if (!cr) break;
              probeFishMove(gd, cr.data.doc.data);
              if (cr.data.doc.COMPLETE_CID) {
                pendingCardsToAdd = pendingCatchCards(cr.data.doc);
                break;
              }
              await delay(300);
            }
          }

      }

      /**
       * Why fishing gave up, if it did.
       *
       * The server's fishing state is one global slot, not one per pond, so a
       * loot it refuses is refused for every pond in the plan. Carrying the
       * reason out here is what stops the second pond from rediscovering the
       * same blockage cast by cast.
       */
      let fishingBlocked: string | null = null;
      /** Consecutive failures of the loot that opens a cast. */
      let lootFailures = 0;
      const MAX_LOOT_FAILURES = 2;

      /**
       * Casts the server will still accept, recounted from the state fetched
       * moments ago rather than from the plan.
       *
       * The plan's per-pond cast counts were fixed when the plan was built,
       * which may have been before a dungeon phase, before casts spent in the
       * game client, or before a day rollover. `preFish` is already the live
       * state; not spending it here is what let a stale plan run its full
       * allowance into a server that had been refusing since the first cast.
       *
       * One budget, not one per pond: the daily allowance is a single pool that
       * every pond draws from.
       */
      let castBudget = castAllowance(preFish, isJuiced, FISHING).left;
      const plannedTotal = plannedFishing.reduce((s, a) => s + a.casts, 0);
      if (castBudget < plannedTotal) {
        log(
          `Fishing allowance recounted: the plan holds ${plannedTotal} cast${plannedTotal === 1 ? "" : "s"} but the server has ${castBudget} left today. Running ${castBudget}.`,
          "fishing"
        );
      }

      for (const alloc of plannedFishing) {
        const stepId = `fishing-${alloc.castNodeId}`;
        if (cancelRef.current) { updateStep(stepId, { status: "skipped" }); continue; }
        if (fishingBlocked) {
          updateStep(stepId, { status: "skipped", detail: fishingBlocked });
          continue;
        }

        const pond = pondById(alloc.pondId);

        // This pond's share of what is actually left, not what it was promised.
        const pondCasts = Math.min(alloc.casts, castBudget);
        if (pondCasts <= 0) {
          const why = `no casts left in today's allowance — the plan held ${alloc.casts} for ${pond.name}.`;
          log(`${pond.name} skipped: ${why}`, "fishing");
          updateStep(stepId, { status: "skipped", detail: why });
          continue;
        }

        updateStep(stepId, { status: "running", detail: "starting..." });
        let caught = 0;
        let escaped = 0;

        // Entry offering for this pond. Tier 1 is free; anything above it costs
        // a faction ring, so it is only reached when the plan explicitly opted
        // in. A pond with no offering system resolves to tier 0.
        const entry = pondEntryOptions(
          g().fishingState?.pondEntryTiers, pond.pondId, g().itemBalances, g().currentDay
        );
        const offering =
          freeActions.spendEntryOfferings && entry.payable ? entry.payable : entry.free;
        if (!offering) {
          // Every tier on this pond costs an item and the plan did not opt in
          // to paying. Skipping is the only honest option: casting anyway would
          // spend a faction ring per cast on a decision nobody made.
          const why = `${pond.name} has no free entry offering and "Pay pond entry offerings" is off — skipped ${alloc.casts} cast${alloc.casts === 1 ? "" : "s"}.`;
          log(why, "error");
          updateStep(stepId, { status: "skipped", detail: why });
          continue;
        }
        if (offering.dropMultiplier > 1) {
          log(
            `${pond.name}: paying the tier ${offering.tier} offering for ${offering.dropMultiplier}x Cores — this spends a faction ring per cast`,
            "fishing"
          );
        }

          let stoppedShort = "";
          for (let cast = 0; cast < pondCasts; cast++) {
            if (cancelRef.current) break;

            // The plan's energy budget was computed before the run started;
            // dungeons may have spent more than projected. Both "start_run" and
            // "loot" begin a new cast, so an unaffordable one is rejected
            // outright — check against live energy first.
            const liveEnergy = Math.floor(
              g().energy?.entities?.[0]?.parsedData?.energyValue ?? 0
            );
            if (liveEnergy < alloc.castCost) {
              stoppedShort = `out of energy after ${cast} of ${pondCasts} casts (${liveEnergy}E left, need ${alloc.castCost}E)`;
              log(`Fishing stopped: ${stoppedShort}`, "fishing");
              break;
            }

            updateStep(stepId, { detail: `cast ${cast + 1}/${pondCasts}...` });
            log(`${pond.name} cast ${cast + 1}/${pondCasts} (${alloc.castLabel})`, "fishing");

            // Everything this cast pays out, so the pond's measured yield comes
            // from what actually arrived rather than from an assumed rate.
            const gains = new Map<number, number>();

            try {
              let startResult;

              if (pendingCardsToAdd && pendingCardsToAdd.length > 0) {
                // Use "loot" action: collect fish + pick card + start next cast in one request
                // Pick the first earnable card (simple heuristic)
                const chosenCard = pendingCardsToAdd[0].id;
                log(`Collecting fish, picking card ${chosenCard}`, "fishing");
                startResult = await g().fishingAction("loot", { cards: [chosenCard], nodeId: alloc.castNodeId, tierId: offering.tier });
                // Only close the previous cast's books if the loot actually
                // landed. Clearing `pendingCardsToAdd` on a failed loot left the
                // catch uncollected on the server, and the next cast's
                // start_run recovery would loot it internally — so the previous
                // pond's Cores arrived in this pond's `gains` and were filed
                // against the wrong pond's measured yield. Leaving both open
                // means the next iteration retries the loot and the record is
                // still the one that earned it.
                if (startResult) {
                  // This response pays out the catch that just ended, so it is
                  // credited to that cast's pond — which may not be this one.
                  if (pendingCastRecord) mergeGains(pendingCastRecord.gains, startResult.gameItemBalanceChanges);
                  // Cleared BEFORE the flush: the catch has now been collected,
                  // and flushCastRecord discards any record still showing one
                  // outstanding. Flushing first would throw away the very cast
                  // whose payout just arrived.
                  pendingCardsToAdd = null;
                  flushCastRecord();
                }
              } else {
                // Nothing further will arrive for the previous cast.
                flushCastRecord();
                // No pending card pick — normal start_run
                startResult = await g().fishingAction("start_run", { cards: [], nodeId: alloc.castNodeId, tierId: offering.tier });
                // If start fails, retry with recovered token
                if (!startResult) {
                  await delay(300);
                  startResult = await g().fishingAction("start_run", { cards: [], nodeId: alloc.castNodeId, tierId: offering.tier });
                }
                mergeGains(gains, startResult?.gameItemBalanceChanges);
              }

              if (!startResult) {
                const why = g().lastErrorRef.current || "unknown";
                log(`Fishing cast failed to start: ${why}`, "error");

                // Some refusals are permanent for the rest of the day, and the
                // server says so in as many words. "Player has reached max runs
                // for fishing" cannot become false before the reset, so every
                // remaining cast is a request whose answer is already known.
                //
                // This is the check that makes the cap miscount survivable
                // whatever causes it. Our arithmetic for casts-remaining has
                // been wrong more than once — a per-pond count read as a global
                // one, a plan built before the day rolled over — and each fix
                // only closed that instance. Treating the server's own refusal
                // as authoritative closes the class: however the count goes
                // wrong next, it costs one cast to find out rather than twenty.
                if (isDailyCapError(why)) {
                  fishingBlocked =
                    `stopped after ${cast} of ${pondCasts} casts — the server says the daily cast limit is already reached (${why}). ` +
                    `The plan's count disagreed with the server's; the server wins.`;
                  log(`Fishing stopped: ${fishingBlocked}`, "error");
                  break;
                }

                // A failed loot is the one failure that repeats. The catch it
                // was collecting is still outstanding, so the next cast opens
                // with the identical call and fails identically — twenty casts
                // burned discovering one thing once. Two attempts covers a
                // stale action token; past that the blockage is real and the
                // rest of the plan is not worth trying.
                if (pendingCardsToAdd && pendingCardsToAdd.length > 0) {
                  lootFailures++;
                  if (lootFailures >= MAX_LOOT_FAILURES) {
                    fishingBlocked =
                      `stopped after ${cast + 1} of ${pondCasts} casts — the outstanding catch can't be collected (${why}). ` +
                      `Collect it in the game client; no cast can start until it's cleared.`;
                    log(`Fishing stopped: ${fishingBlocked}`, "error");
                    break;
                  }
                } else {
                  // A start_run failure with nothing outstanding is a different
                  // animal — the next cast is a fresh attempt, so it retries.
                  lootFailures = 0;
                }
                escaped++;
                continue;
              }
              // The cast is open, so it has come out of the shared allowance.
              // Decremented here rather than per loop iteration because a cast
              // the server refused never counted against the day.
              castBudget = Math.max(0, castBudget - 1);
              lootFailures = 0;

              summaryStats.fishCasts++;

              // Play cards loop
              let fishComplete = false;
              let redrawsThisCast = 0;
              let iterations = 0;
              const MAX_FISH_ITERATIONS = 50;

              while (!fishComplete && iterations < MAX_FISH_ITERATIONS) {
                if (cancelRef.current) break;
                iterations++;

                // Fetch fresh state
                const stateResult = await g().fetchFishingState();
                const gameData = stateResult?.gameState?.data;
                const isComplete = stateResult?.gameState?.COMPLETE_CID;

                if (isComplete || !gameData) {
                  fishComplete = true;
                  const success = !!stateResult?.gameState?.SUCCESS_CID;
                  if (success) {
                    caught++;
                    const fish = gameData?.caughtFish;
                    const earned = fish?.currencyEarned ?? 0;
                    addCurrency(alloc.pondId, earned);
                    pendingCardsToAdd = pendingCatchCards(stateResult?.gameState);
                    log(`Caught ${fish?.name ?? "fish"} (+${earned} ${pondCurrencyLabel(alloc.pondId)})`, "fishing");
                  } else {
                    escaped++;
                    pendingCardsToAdd = null;
                    log(`Fish escaped`, "fishing");
                  }
                  pendingCastRecord = {
                    pondId: alloc.pondId,
                    nodeId: alloc.castNodeId,
                    energyCost: alloc.castCost,
                    multiplier: stateResult?.gameState?.MULTIPLIER_CID ?? offering.dropMultiplier,
                    caught: success,
                    gains,
                  };
                  break;
                }

                if (gameData.hand.length === 0) {
                  await delay(300);
                  continue;
                }

                const grove = gameData.focusMechanicEnabled ? pickGroveMove(gameData) : null;
                if (gameData.focusMechanicEnabled && !grove) {
                  log("No playable card in the Grove", "error");
                  break;
                }
                if (grove?.redraw && redrawsThisCast < MAX_REDRAWS_PER_CAST) {
                  redrawsThisCast++;
                  log(grove.reason, "info");
                  await g().fishingAction("play_cards", {
                    cards: [], nodeId: "", focusPoint: gameData.focusPoint ?? [],
                  });
                  await delay(300);
                  continue;
                }
                const best = grove
                  ? { handIndex: grove.handIndex }
                  : pickBestCard(
                      gameData.hand,
                      gameData.deckCardData,
                      gameData.fishPosition,
                      gameData.previousFishPosition,
                      gameData.nextPosition,
                      resolveGrid(gameData)
                    );

                const cardResult = await g().fishingAction("play_cards", {
                  cards: [best.handIndex], nodeId: "",
                  focusPoint: grove ? grove.focusPoint : (gameData.focusPoint ?? []),
                });
                if (cardResult) probeFishMove(gameData, cardResult.data.doc.data);
                if (!cardResult) {
                  log(`Card play failed`, "error");
                  break;
                }
                mergeGains(gains, cardResult.gameItemBalanceChanges);

                // Check if complete from card result
                const doc = cardResult.data.doc;
                if (doc.COMPLETE_CID) {
                  fishComplete = true;
                  if (doc.SUCCESS_CID) {
                    caught++;
                    const fish = doc.data?.caughtFish;
                    const earned = fish?.currencyEarned ?? 0;
                    addCurrency(alloc.pondId, earned);
                    pendingCardsToAdd = pendingCatchCards(doc);
                    log(`Caught ${fish?.name ?? "fish"} (+${earned} ${pondCurrencyLabel(alloc.pondId)})`, "fishing");
                  } else {
                    escaped++;
                    pendingCardsToAdd = null;
                    log(`Fish escaped`, "fishing");
                  }
                  pendingCastRecord = {
                    pondId: alloc.pondId,
                    nodeId: alloc.castNodeId,
                    energyCost: alloc.castCost,
                    multiplier: doc.MULTIPLIER_CID ?? offering.dropMultiplier,
                    caught: !!doc.SUCCESS_CID,
                    gains,
                  };
                }

                await delay(300);
              }
            } catch (e) {
              log(`Fishing error: ${e instanceof Error ? e.message : "unknown"}`, "error");
              escaped++;
            }

            if (cast < pondCasts - 1) {
              await g().refreshAll();
              await delay(300);
            }
          }

          // Outside the cast loop: this used to run per cast against a running
          // total, so three catches reported as six.
          summaryStats.fishCaught += caught;
          // A blocked pond is not a done pond. Reporting it as done with a
          // count of escapes reads as bad luck with the fish, which is the one
          // thing it isn't.
          const reason = fishingBlocked || stoppedShort;
          updateStep(stepId, {
            status: fishingBlocked ? "failed" : cancelRef.current ? "skipped" : "done",
            detail: reason
              ? `${caught} caught / ${escaped} escaped — ${reason}`
              : `${caught} caught / ${escaped} escaped`,
          });
          await g().refreshAll();
      }

      // Collect the last catch without casting again. In the client the fish
      // is claimed first, the spell is picked second, and only then does the
      // pond offer another cast next to a "Leave" button — so the payout is
      // reachable without paying for a cast nobody planned. An empty nodeId is
      // that Leave: loot with nothing to cast into.
      //
      // This is what keeps the final cast of a run measurable. Without it the
      // payout never arrives before the run ends and the cast is discarded.
      // Not attempted when the run already established the server won't take
      // this loot — a third identical refusal proves nothing new.
      if (!cancelRef.current && !fishingBlocked && pendingCardsToAdd && pendingCardsToAdd.length > 0) {
        const chosenCard = pendingCardsToAdd[0].id;
        log(`Collecting the last catch (card ${chosenCard}), not casting again`, "fishing");
        const collected = await g().fishingAction("loot", { cards: [chosenCard], nodeId: "" });
        if (collected) {
          if (pendingCastRecord) mergeGains(pendingCastRecord.gains, collected.gameItemBalanceChanges);
          pendingCardsToAdd = null;
          // If the server opened a cast anyway, the energy is already gone and
          // the game is left mid-flight. Say so loudly — the next run's
          // pre-fish cleanup is what plays it out.
          const doc = collected.data?.doc;
          if (doc && !doc.COMPLETE_CID && doc.data?.hand) {
            log(
              "Collect started another cast despite an empty node — that energy is spent, and the next run will finish the cast.",
              "error"
            );
          }
        } else {
          log(
            `Final collect failed: ${g().lastErrorRef.current || "unknown"} — the catch stays on the server for the next run.`,
            "error"
          );
        }
      }

      // Nothing left to loot, so any still-open record is as complete as it gets.
      flushCastRecord();

      // 8. Sell fish
      if (stepList.find((s) => s.id === "sell-fish")) {
        if (cancelRef.current) { updateStep("sell-fish", { status: "skipped" }); }
        else {
          updateStep("sell-fish", { status: "running" });
          // Re-read fresh balances
          await g().refreshAll();
          const rates = g().fishingState?.exchangeRates || [];
          const balMap = g().itemBalances;
          const fishToSell = rates
            .map((r) => {
              const qty = balMap[String(r.id)] ?? 0;
              if (qty <= 0) return null;
              const pct = Math.round(((r.value - r.baseVal) / r.baseVal) * 100);
              return { id: r.id, qty, value: r.value, pct, pondId: r.pondId };
            })
            .filter((f): f is NonNullable<typeof f> => f !== null && f.pct >= 50);

          let totalSold = 0;
          const earnedByPond = new Map<number, number>();
          for (const f of fishToSell) {
            if (cancelRef.current) break;
            for (let i = 0; i < f.qty; i++) {
              if (cancelRef.current) break;
              try {
                const r = await g().sellFish(f.id, 1, f.value, f.pondId);
                if (r?.success) {
                  totalSold++;
                  const got = r.data?.value ?? f.value;
                  earnedByPond.set(f.pondId, (earnedByPond.get(f.pondId) ?? 0) + got);
                  addCurrency(f.pondId, got);
                } else {
                  log(`Sell failed: ${r?.message || "error"}`, "error");
                  break;
                }
              } catch { break; }
              await delay(150);
            }
          }
          const earnedText = Array.from(earnedByPond, ([pondId, amount]) => `${amount} ${pondCurrencyLabel(pondId)}`).join(" + ") || "nothing";
          updateStep("sell-fish", { status: "done", detail: `${totalSold} sold, ${earnedText}` });
          log(`Sold ${totalSold} fish for ${earnedText}`, "fishing");
        }
      }

      finishRun(cancelRef.current ? "cancelled" : "done", summaryStats);

    } catch (e) {
      const cancelled = (e as Error).message === "cancelled";
      if (!cancelled) {
        log(`Error: ${e instanceof Error ? e.message : "unknown"}`, "error");
      }
      // Steps the run never reached are "not-run" — a different fact from
      // "skipped", which means the plan had nothing to do for them.
      stepsRef.current = stepsRef.current.map((s) =>
        s.status === "pending" ? { ...s, status: "not-run" as const } : s
      );
      setSteps(stepsRef.current);
      finishRun(
        cancelled ? "cancelled" : "error",
        summaryStats,
        e instanceof Error ? e.message : "unknown error"
      );
    } finally {
      // A cast that finished before the run blew up still happened, and its
      // yield is what the advisor ranks ponds by. flushCastRecord clears the
      // record first, so reaching here after a normal flush is a no-op.
      flushCastRecord();
      gigaRef.current.autoBattleRef.current = false;
      setExecuting(false);
      setStopping(false);
      refreshRunStats();
      await gigaRef.current.refreshAll();
    }
  };

  const handleStop = () => {
    cancelRef.current = true;
    setStopping(true);
    addLog("[MC] stopping after current action...");
  };

  /* ─── Run ───────────────────────────────────────────────── */

  /**
   * Run Plan goes straight to running.
   *
   * There used to be a review modal in between, listing the same steps and the
   * same energy the plan card above the button already shows, behind a Confirm.
   * A confirmation that restates what you were looking at when you pressed the
   * button is a second click, not a second thought.
   */
  const startRun = () => {
    const preview = buildStepList();
    stepsRef.current = preview;
    setSteps(preview);
    setSummary(null);
    setShowModal(true);
    void execute();
  };

  const closeModal = () => {
    setShowModal(false);
  };
  const closeModalRef = useRef(closeModal);
  closeModalRef.current = closeModal;

  // Dialog behavior: focus the panel on open, Escape closes, Tab cycles inside
  // it rather than walking out behind the backdrop, focus returns to the
  // trigger on close.
  useEffect(() => {
    if (!showModal) return;
    return trapFocus(modalRef.current, () => closeModalRef.current());
  }, [showModal]);

  // Same dialog behavior for the Adjust Plan editor
  useEffect(() => {
    if (!adjusting) return;
    return trapFocus(adjustRef.current, () => setAdjusting(false));
  }, [adjusting]);

  /* ─── Render ─────────────────────────────────────────────── */

  // Steps and activity are separate blocks, not one, because the run modal
  // gives them separate scroll panes. Rolled together they shared a scroll
  // container, and a few hundred log lines pushed everything else off the
  // bottom — which is exactly how the haul ended up unreachable.
  const stepsContent = steps.length > 0 ? (
    <>
          <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
            <span className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--text-faint)" }}>
              Progress
            </span>
          </div>
          <div className="divide-y" style={{ borderColor: "var(--border)" }}>
            {steps.map((step) => (
              <div
                key={step.id}
                className="px-4 py-3"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="text-[14px] font-bold shrink-0 w-5 text-center"
                    style={{
                      color: statusColor(step.status),
                      animation: step.status === "running" ? "pulse 1.5s ease-in-out infinite" : "none",
                    }}
                  >
                    {statusIcon(step.status)}
                  </span>
                  <span className="sr-only">{statusLabel(step.status)}:</span>
                  <span
                    className="text-[13px] font-medium"
                    style={{ color: step.status === "pending" ? "var(--text-faint)" : "var(--text)" }}
                  >
                    {step.label}
                  </span>
                  {(step.status === "failed" || step.status === "not-run") && (
                    <span
                      aria-hidden="true"
                      className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                      style={{
                        color: statusColor(step.status),
                        background: step.status === "failed" ? "var(--red-glow)" : "var(--bg-inset)",
                        border: `1px solid ${step.status === "failed" ? "var(--red-border)" : "var(--border)"}`,
                      }}
                    >
                      {step.status === "failed" ? "Failed" : "Not run"}
                    </span>
                  )}
                </div>
                {step.detail && (
                  <div
                    className="text-[12px] mt-1 ml-8"
                    style={{ color: "var(--text-dim)", lineHeight: 1.5, whiteSpace: "pre-line" }}
                  >
                    {step.detail}
                  </div>
                )}
              </div>
            ))}
          </div>
    </>
  ) : null;

  const activityContent = mcLog.length > 0 ? (
    <>
          <div className="px-4 py-2.5 shrink-0">
            <span className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--text-faint)" }}>
              Activity
            </span>
          </div>
          {/* role="log" is polite by default, which would narrate every loot
              line of a ten-minute run. Steps and errors announce through the
              dedicated live region instead; this stays readable on demand. */}
          <div
            role="log"
            aria-label="Run activity, newest first"
            aria-live="off"
            className="px-4 pb-3 flex flex-col gap-1"
          >
            {[...mcLog].reverse().map((entry, i) => {
              const IconCmp = entry.type === "loot" ? Package
                : entry.type === "dungeon" ? Sword
                : entry.type === "fishing" ? Fish
                : entry.type === "error" ? AlertTriangle
                : Info;
              const color = i === 0
                ? (entry.type === "loot" ? "var(--gold)"
                  : entry.type === "fishing" ? "var(--blue)"
                  : entry.type === "error" ? "var(--red)"
                  : "var(--text)")
                : entry.type === "loot" ? "var(--gold)"
                : entry.type === "error" ? "var(--red)"
                : "var(--text-faint)";
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 py-[2px] text-[13px]"
                  style={{
                    color,
                    opacity: i === 0 ? 1 : Math.max(0.55, 1 - i * 0.04),
                    fontWeight: i === 0 ? 500 : 400,
                  }}
                >
                  <IconCmp size={i === 0 ? 15 : 13} className="shrink-0" aria-hidden="true" />
                  <span className="flex-1 leading-[20px]">{entry.msg}</span>
                </div>
              );
            })}
          </div>
    </>
  ) : null;

  // The run's verdict, and the first thing the outcome pane says. Full-bleed
  // rather than an inset pill: it is the pane's headline, not a notice tucked
  // inside one.
  const summaryContent = summary ? (
    <div
      className="px-4 py-3.5 text-[13px] font-medium shrink-0"
      style={{
        background: summaryFailed ? "var(--red-glow)" : "var(--green-glow)",
        borderBottom: `1px solid ${summaryFailed ? "var(--red-border)" : "var(--green-border)"}`,
        color: summaryFailed ? "var(--red)" : "var(--green)",
        lineHeight: 1.5,
      }}
    >
      {summary}
    </div>
  ) : null;

  // Everything the run actually put in your bags, itemised. Losses (fish sold,
  // ring spent on an offering) show as negatives rather than being hidden —
  // a net view is the honest one when the plan both earns and spends.
  //
  // No card wrapper: this sits inside the modal's own raised surface, and a
  // card within a card is a border for the sake of a border. The section
  // label carries the grouping instead.
  const gained = haul.filter((h) => h.amount > 0).length;
  const haulContent = haul.length > 0 ? (
    <>
      <div className="flex items-baseline justify-between px-4 pt-4 pb-2">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--text-faint)" }}>
          Haul
        </h3>
        <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
          {gained} item{gained === 1 ? "" : "s"} gained
        </span>
      </div>
      <div className="flex flex-col px-4 pb-4">
        {haul.map((h, i) => (
          <div
            key={h.id}
            className="flex items-center justify-between text-[12.5px] py-[5px]"
            // Rules separate rows; a rule under the last one is a rule under
            // nothing.
            style={{ borderBottom: i < haul.length - 1 ? "1px solid var(--border)" : undefined }}
          >
            <span className="truncate pr-3" style={{ color: RARITY_COLORS[h.rarity ?? 0] ?? "var(--text)" }}>
              {h.name}
            </span>
            <span
              className="tabular-nums shrink-0 font-semibold"
              style={{ color: h.amount > 0 ? "var(--green)" : "var(--red)" }}
            >
              {h.amount > 0 ? "+" : ""}{fmt(h.amount)}
            </span>
          </div>
        ))}
      </div>
    </>
  ) : null;

  // The left pane, open from the first moment of the run rather than appearing
  // at the end. During execution it is the haul filling up live; when the run
  // finishes the verdict lands above it. Either way this side answers "what am
  // I getting" and the right side answers "what is it doing".
  const outcomeContent = (
    <>
      {summaryContent}
      {haulContent ?? (
        <div className="px-4 pt-4">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] mb-2" style={{ color: "var(--text-faint)" }}>
            Haul
          </h3>
          <p className="text-[12.5px]" style={{ color: "var(--text-faint)", lineHeight: 1.5 }}>
            {executing
              ? "Nothing yet — items appear here as they drop."
              : "This run collected nothing."}
          </p>
        </div>
      )}
    </>
  );

  // Live status for the running header: which step is on, how far through the
  // plan, and what the energy pool is down to. "Settled" counts every step the
  // run is finished with, not just the successful ones — a failed step is
  // progress through the plan too, and a bar that stalls on failure would
  // report the run as stuck when it has moved on.
  const settledSteps = steps.filter(
    (s) => s.status === "done" || s.status === "failed" || s.status === "skipped" || s.status === "not-run"
  ).length;
  const runningStep = steps.find((s) => s.status === "running");
  const stepPct = steps.length > 0 ? Math.round((settledSteps / steps.length) * 100) : 0;

  // One phrasing for the plan's energy, used by every surface that shows it.
  // Mid-run the pre-run figure is stale, so it switches to the live pool.
  const energyLabel = executing
    ? `${fmt(currentEnergy)}E left of ${fmt(maxEnergy)}E`
    : `spends ${fmt(allocatedEnergy)}E of ${fmt(effectiveEnergy)}E`;
  const overBudget = allocatedEnergy > effectiveEnergy;

  return (
    <div className="anim-in space-y-6" style={{ maxWidth: 720 }}>

      {/* Single polite live region: step transitions, errors, and the final
          summary. The step list itself is not live — re-rendering it on every
          update would re-announce the whole plan. */}
      <div className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </div>

      {/* ── Advisor ── */}
      {recommendation && (recommendation.notes.length > 0 || recommendation.warnings.length > 0) && (
        <section
          className="p-4 rounded-lg"
          style={{ background: "var(--bg-raised)", border: "1px solid var(--border-accent)" }}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Lightbulb size={15} style={{ color: "var(--gold)" }} />
              <span className="text-[14px] font-bold">Advisor</span>
            </div>
            <span className="text-[11px] tabular-nums font-medium" style={{ color: "var(--text-dim)" }}>
              plan spends {fmt(Math.floor(recommendation.totalSpend))}E &middot; {fmt(recommendation.leftover)}E left
            </span>
          </div>

          {recommendation.warnings.length > 0 && (
            <div className="space-y-1.5 mb-2.5">
              {recommendation.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-[12px]" style={{ color: "var(--red)" }}>
                  <AlertTriangle size={13} className="shrink-0 mt-[2px]" />
                  <span style={{ lineHeight: 1.5 }}>{w}</span>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1.5 mb-3">
            {recommendation.notes.map((n, i) => (
              <div key={i} className="flex items-start gap-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
                <span className="shrink-0 mt-[1px]" style={{ color: "var(--gold)" }}>&bull;</span>
                <span style={{ lineHeight: 1.5 }}>{n}</span>
              </div>
            ))}
          </div>

          <button
            onClick={applyRecommendation}
            disabled={executing}
            className="btn-press text-[12px] font-bold px-4 py-2 rounded-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: "var(--orange-glow)",
              border: "1px solid var(--border-accent)",
              color: "var(--orange)",
            }}
          >
            Apply recommendation
          </button>
        </section>
      )}

      {/* ── Out of repairs: needs the restore flow, not repair ── */}
      {exhaustedGear.length > 0 && (
        <section
          className="p-3.5 rounded-lg"
          style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <AlertTriangle size={14} style={{ color: "var(--gold)" }} />
            <span className="text-[13px] font-bold" style={{ color: "var(--gold)" }}>
              Out of repairs
            </span>
          </div>
          <div className="text-[12px] mb-2" style={{ color: "var(--text-dim)", lineHeight: 1.5 }}>
            These have hit their repair limit, so the plan skips them. Restore resets that
            limit and re-rolls rarity. Not every piece has a restore: the game publishes the
            reset cost per item, and where it&apos;s empty the piece is simply finished.
          </div>
          <div className="space-y-1">
            {exhaustedGear.map((g) => {
              // The gear's own definition decides this. "Reset items not found"
              // from the server covers two opposite situations — no recipe at
              // all, or a recipe you can't afford — so the verdict is read here
              // rather than inferred from a failed request.
              const verdict = restoreVerdict(
                giga.gearDefs[g.gameItemId],
                giga.itemBalances,
                (id) => giga.itemInfo[String(id)]?.name || giga.itemNames[String(id)] || `#${id}`
              );
              const cost =
                verdict.kind === "ready" || verdict.kind === "short"
                  ? verdict.cost
                      .map((c) => `${c.amount}x ${giga.itemInfo[String(c.itemId)]?.name || `#${c.itemId}`}`)
                      .join(", ")
                  : null;
              return (
                <div key={g.docId} className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
                  <span className="flex-1">
                    <span className="font-semibold" style={{ color: "var(--text)" }}>{g.name}</span>
                    {" — "}
                    {g.durability <= 0 ? "broken" : "1 use left"}
                    {g.equipped && " (equipped)"}
                    {verdict.kind !== "ready" && (
                      <span
                        className="block"
                        style={{ color: verdict.kind === "not-restorable" ? "var(--red)" : "var(--text-faint)" }}
                      >
                        {verdict.reason}
                      </span>
                    )}
                    {cost && verdict.kind === "ready" && (
                      <span className="block" style={{ color: "var(--text-faint)" }}>costs {cost}</span>
                    )}
                  </span>
                  {verdict.kind !== "not-restorable" && (
                    <button
                      onClick={() => restoreOne(g)}
                      disabled={restoring !== null || executing || verdict.kind !== "ready"}
                      aria-label={`Restore ${g.name}`}
                      className="btn-press touch-target text-[11px] font-bold px-3 py-1.5 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                      style={{ background: "var(--bg-raised)", border: "1px solid var(--gold)", color: "var(--gold)" }}
                    >
                      {restoring === g.docId ? "Restoring..." : "Restore"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Loadout: what is on, and what is wrong with it ── */}
      {loadout.length > 0 && (
        <details
          className="rounded-lg"
          style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}
        >
          <summary className="disclosure p-3.5 cursor-pointer flex items-center gap-2">
            <ChevronRight size={13} className="disclosure-chevron shrink-0" style={{ color: "var(--text-faint)" }} />
            <Sword size={14} className="shrink-0" style={{ color: "var(--text-dim)" }} />
            <span className="text-[13px] font-bold shrink-0" style={{ color: "var(--text)" }}>
              Loadout
            </span>
            <span
              className="text-[12px] truncate"
              style={{ color: kitWarnings.length > 0 ? "var(--red)" : "var(--text-faint)" }}
            >
              {kitSummary}
            </span>
          </summary>

          <div className="px-3.5 pb-3.5">
          <div className="space-y-1.5 mb-2.5">
            {loadout.map((s) => (
              <div key={s.slot} className="flex items-baseline gap-2.5 text-[12px]">
                <span
                  className="shrink-0 text-[11px] font-bold uppercase tracking-[0.08em] text-right"
                  style={{ color: "var(--text-faint)", width: 96 }}
                >
                  {s.label}
                </span>
                <span className="flex-1 min-w-0">
                  {s.equipped.length === 0 ? (
                    <span style={{ color: s.benched.some((b) => b.durability > 0) ? "var(--red)" : "var(--text-faint)" }}>
                      empty
                    </span>
                  ) : (
                    s.equipped.map((e, i) => (
                      <span key={e.docId}>
                        {i > 0 && <span style={{ color: "var(--text-faint)" }}>, </span>}
                        <span style={{ color: e.dead ? "var(--red)" : "var(--text)" }}>{e.name}</span>
                        <span className="tabular-nums" style={{ color: "var(--text-faint)" }}>
                          {" "}
                          {e.durability}
                          {e.maxDurability != null && `/${e.maxDurability}`}
                          {e.dead && " · finished"}
                        </span>
                      </span>
                    ))
                  )}
                  {s.benched.length > 0 && (
                    <span style={{ color: "var(--text-faint)" }}>
                      {" · bench: "}
                      {s.benched.map((b) => `${b.name} (${b.durability})`).join(", ")}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>

          {kitWarnings.length > 0 && (
            <div className="space-y-1">
              {kitWarnings.map((w, i) => (
                <div
                  key={`${w.kind}-${w.slot}-${i}`}
                  className="text-[12px] px-2.5 py-1.5 rounded"
                  style={
                    w.kind === "equipped-low"
                      ? { background: "var(--gold-glow)", color: "var(--gold)", lineHeight: 1.5 }
                      : { background: "var(--red-glow)", border: "1px solid var(--red-border)", color: "var(--red)", lineHeight: 1.5 }
                  }
                >
                  {w.message}
                </div>
              ))}
            </div>
          )}
          </div>
        </details>
      )}

      {/* ── What to make next ── */}
      {(gearAdvice.dungeon.length > 0 || gearAdvice.fishing.length > 0 || gearAdvice.stranded.length > 0) && (
        <details
          className="rounded-lg"
          style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}
        >
          <summary className="disclosure p-3.5 cursor-pointer flex items-center gap-2">
            <ChevronRight size={13} className="disclosure-chevron shrink-0" style={{ color: "var(--text-faint)" }} />
            <Lightbulb size={14} className="shrink-0" style={{ color: "var(--orange)" }} />
            <span className="text-[13px] font-bold shrink-0" style={{ color: "var(--orange)" }}>
              Gear worth making
            </span>
            <span className="text-[12px] truncate" style={{ color: "var(--text-faint)" }}>
              {gearAdvice.summary}
            </span>
          </summary>

          <div className="px-3.5 pb-3.5">
          <div className="text-[12px] mb-2.5" style={{ color: "var(--text-dim)", lineHeight: 1.5 }}>
            Read from the game&apos;s recipes and your materials. Costs are what the craft
            consumes; nothing here is bought or made for you.
          </div>

          {([["dungeon", "Dungeons"], ["fishing", "Fishing"]] as const).map(([purpose, heading]) => {
            const rows = gearAdvice[purpose];
            if (rows.length === 0) return null;
            return (
              <div key={purpose} className="mb-2.5 last:mb-0">
                <h4 className="text-[11px] font-bold uppercase tracking-[0.1em] mb-1.5" style={{ color: "var(--text-faint)" }}>
                  {heading}
                </h4>
                <div className="space-y-1.5">
                  {rows.map((s) => (
                    <div key={`${s.recipeId}-${s.purpose}`} className="text-[12px]" style={{ color: "var(--text-dim)" }}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-semibold" style={{ color: "var(--text)" }}>
                          {s.outputName}
                        </span>
                        <span
                          className="text-[10px] font-bold uppercase tracking-wider shrink-0 px-1.5 py-0.5 rounded"
                          style={
                            s.affordable
                              ? { color: "var(--green)", background: "var(--green-glow)", border: "1px solid var(--green-border)" }
                              : { color: "var(--text-faint)", background: "var(--bg-inset)", border: "1px solid var(--border)" }
                          }
                        >
                          {s.affordable ? "Can make now" : "Short"}
                        </span>
                      </div>
                      <div style={{ lineHeight: 1.5 }}>
                        {s.effects.length > 0 ? describeEffects(s.effects) : "no bonuses — durability only"}
                        {" · "}
                        {s.reason}
                      </div>
                      <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                        {s.affordable
                          ? `costs ${s.cost.map((c) => `${c.amount}x ${gearAdvice.itemName(c.itemId)}`).join(", ")}`
                          : `needs ${s.missing.map((m) => `${m.amount} more ${gearAdvice.itemName(m.itemId)}`).join(", ")}`}
                        {s.energy > 0 && ` · ${s.energy}E to craft`}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {gearAdvice.stranded.length > 0 && (
            <div
              className="mt-2.5 text-[12px] px-2.5 py-2 rounded"
              style={{ background: "var(--red-glow)", border: "1px solid var(--red-border)", color: "var(--red)", lineHeight: 1.5 }}
            >
              {gearAdvice.stranded.map((d) => d.itemName).join(", ")}
              {gearAdvice.stranded.length === 1 ? " is" : " are"} finished, and no recipe you
              can reach replaces {gearAdvice.stranded.length === 1 ? "it" : "them"}. That slot
              stays empty until one drops or the materials show up.
            </div>
          )}
          </div>
        </details>
      )}

      {/* ── Gear durability warning ── */}
      {wornGear.length > 0 && (
        <section
          className="p-3.5 rounded-lg"
          style={{ background: "var(--red-glow)", border: "1px solid var(--red-border)" }}
        >
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} style={{ color: "var(--red)" }} />
              <span className="text-[13px] font-bold" style={{ color: "var(--red)" }}>
                Gear needs repair
              </span>
            </div>
            {/* When the plan already repairs gear, the banner reports rather
                than acts — repairing here left the plan step to fail later
                against gear that was already fine. */}
            {freeActions.repairGear ? (
              <span className="text-[11px] font-semibold" style={{ color: "var(--text-dim)" }}>
                Included in today&apos;s plan
              </span>
            ) : (
              wornGear.length > 1 && (
                <button
                  onClick={() => {
                    if (confirmRepairAll) {
                      setConfirmRepairAll(false);
                      void repairWorn(wornGear);
                    } else {
                      setConfirmRepairAll(true);
                    }
                  }}
                  disabled={repairing || executing}
                  className="btn-press touch-target text-[11px] font-bold px-3 py-1.5 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: confirmRepairAll ? "var(--red-glow)" : "var(--bg-raised)",
                    border: "1px solid var(--red-border)",
                    color: "var(--red)",
                  }}
                >
                  {repairing
                    ? "Repairing..."
                    : confirmRepairAll
                    ? `Repair all ${wornGear.length}?`
                    : "Repair all"}
                </button>
              )
            )}
          </div>
          <div className="space-y-1">
            {wornGear.map((g) => (
              <div key={g.docId} className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
                <span className="flex-1">
                  <span className="font-semibold" style={{ color: "var(--text)" }}>{g.name}</span>
                  {" — "}
                  {g.durability <= 0 ? "broken" : "1 use left"}
                  {g.equipped && " (equipped)"}
                </span>
                {!freeActions.repairGear && (
                  <button
                    onClick={() => repairWorn([g])}
                    disabled={repairing || executing}
                    aria-label={`Repair ${g.name}`}
                    className="btn-press touch-target text-[11px] font-bold px-3 py-1.5 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                    style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", color: "var(--text)" }}
                  >
                    Repair
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Today's Plan ── */}
      {(() => {
        const planPreview = buildStepList();
        const nothingToRun =
          allocatedEnergy > effectiveEnergy || planPreview.length === 0;
        return (
          <section
            className="p-4 rounded-lg"
            style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[14px] font-bold">Today&apos;s Plan</span>
              <span
                className="text-[12px] font-bold tabular-nums"
                style={{ color: overBudget ? "var(--red)" : "var(--orange)" }}
              >
                {energyLabel}
              </span>
            </div>

            {planPreview.length > 0 ? (
              <div className="space-y-1.5 mb-4">
                {planPreview.map((s) => (
                  <div key={s.id} className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span style={{ color: "var(--text)" }}>{s.label}</span>
                    {(s.brief ?? s.detail) && (
                      <span className="tabular-nums shrink-0 text-right" style={{ color: "var(--text-dim)" }}>
                        {s.brief ?? s.detail}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[12px] mb-4" style={{ color: "var(--text-dim)", lineHeight: 1.5 }}>
                Nothing planned yet. Press Adjust to build a plan by hand
                {recommendation && (recommendation.notes.length > 0 || recommendation.warnings.length > 0)
                  ? ", or apply the advisor's recommendation above."
                  : "."}
              </div>
            )}

            <div className="flex gap-2">
              {!executing ? (
                <button
                  onClick={startRun}
                  disabled={nothingToRun}
                  aria-describedby={nothingToRun ? "run-plan-blocked" : undefined}
                  className="btn-press cta-orange flex-1 text-[15px] font-bold py-3 rounded-xl cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    boxShadow: "0 3px 16px var(--orange-glow)",
                    letterSpacing: "0.02em",
                  }}
                >
                  Run Plan
                </button>
              ) : (
                <button
                  onClick={handleStop}
                  disabled={stopping}
                  className="btn-press cta-red flex-1 text-[15px] font-bold py-3 rounded-xl cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{
                    boxShadow: "0 3px 16px var(--red-border)",
                    letterSpacing: "0.02em",
                  }}
                >
                  {stopping ? "Stopping…" : "Stop"}
                </button>
              )}
              <button
                onClick={() => setAdjusting(true)}
                disabled={executing}
                className="btn-press px-5 py-3 rounded-xl text-[13px] font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  background: "var(--bg-inset)",
                  border: "1px solid var(--border)",
                  color: "var(--text-dim)",
                }}
              >
                Adjust
              </button>
            </div>
            {/* A disabled primary button with no explanation is its own defect —
                say which of the two reasons is blocking it. */}
            {nothingToRun && !executing && (
              <div id="run-plan-blocked" className="text-[12px] mt-2" style={{ color: overBudget ? "var(--red)" : "var(--text-dim)" }}>
                {overBudget
                  ? `Over budget by ${fmt(allocatedEnergy - effectiveEnergy)}E — reduce runs or casts in Adjust to enable Run Plan.`
                  : "Nothing to run yet — add runs, casts, or free actions in Adjust."}
              </div>
            )}
            {stopping && (
              <div className="text-[12px] mt-2" style={{ color: "var(--red)" }}>
                Stopping after the current action finishes&hellip;
              </div>
            )}
          </section>
        );
      })()}

      {adjusting && (
        <div className="fixed inset-0" style={{ zIndex: 50 }}>
          <div
            className="fixed inset-0"
            style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
            onClick={() => setAdjusting(false)}
          />
          <div
            ref={adjustRef}
            role="dialog"
            aria-modal="true"
            aria-label="Adjust plan"
            tabIndex={-1}
            className="fixed inset-x-4 top-[6%] bottom-[6%] mx-auto flex flex-col rounded-xl overflow-hidden"
            style={{
              maxWidth: 640,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              zIndex: 51,
              boxShadow: "0 24px 48px rgba(0,0,0,0.4)",
              outline: "none",
            }}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-5 py-3 shrink-0"
              style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-raised)" }}
            >
              <span className="text-[15px] font-bold">Adjust Plan</span>
              <span
                className="text-[12px] font-bold tabular-nums"
                style={{ color: overBudget ? "var(--red)" : "var(--orange)" }}
              >
                {energyLabel}
              </span>
            </div>

            {/* Section nav — four very different jobs used to share one
                30-target scroll with no way to tell them apart. */}
            <div
              role="tablist"
              aria-label="Plan sections"
              className="flex shrink-0 px-2 gap-1"
              style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-raised)" }}
            >
              {([
                { id: "energy" as const, label: "Energy", cost: true },
                { id: "free" as const, label: "Free", cost: false },
                ...(merchantDeals.length > 0 ? [{ id: "merchant" as const, label: "Merchant", cost: false }] : []),
                { id: "presets" as const, label: "Presets", cost: false },
              ]).map((t) => {
                const active = adjustSection === t.id;
                return (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setAdjustSection(t.id)}
                    className="touch-target text-[12px] font-bold px-3 py-2 cursor-pointer"
                    style={{
                      color: active ? (t.cost ? "var(--orange)" : "var(--text)") : "var(--text-faint)",
                      borderBottom: `2px solid ${active ? (t.cost ? "var(--orange)" : "var(--text-dim)") : "transparent"}`,
                      marginBottom: -1,
                      background: "transparent",
                    }}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            {/* Body — scrollable editor */}
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-6">
      {/* ── Section A: Energy Budget — the only section that spends anything ── */}
      <section hidden={adjustSection !== "energy"}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-[14px] font-bold">Energy Budget</div>
          <div className="text-[13px] font-bold tabular-nums" style={{ color: "var(--orange)" }}>
            {fmt(currentEnergy)} / {fmt(maxEnergy)}
          </div>
        </div>

        {/* Energy bar */}
        <div className="rounded-full overflow-hidden mb-5" style={{ height: 8, background: "var(--bg-inset)" }}>
          <div
            className="h-full w-full rounded-full"
            style={{
              transform: `scaleX(${maxEnergy > 0 ? Math.min(1, currentEnergy / maxEnergy) : 0})`,
              transformOrigin: "left",
              background: "linear-gradient(90deg, var(--orange-dim), var(--orange))",
              transition: "transform 0.3s ease",
            }}
          />
        </div>

        {/* Dungeon steppers */}
        <div className="space-y-2 mb-4">
          {dungeonAllocs.map((d, idx) => {
            const totalCost = d.runs * d.energyCost;
            const canIncrease = d.runs < remainingFor(d) && allocatedEnergy + d.energyCost <= effectiveEnergy;
            const info = findDungeonInfo(d.name);
            return (
              <div
                key={d.dungeonId}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
                style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold truncate">
                    {d.name}
                    {info?.exclusiveSource && (
                      <span
                        className="text-[10px] font-bold uppercase tracking-wider ml-2 px-1.5 py-0.5 rounded"
                        style={{ background: "var(--bg-inset)", color: "var(--gold)", border: "1px solid var(--border)" }}
                      >
                        only {info.currency} source
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                    {d.energyCost}E per run &middot; {remainingFor(d)} remaining
                    {info && <> &middot; {info.currency}</>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    disabled={d.runs <= 0 || executing}
                    onClick={() => adjustDungeon(idx, -1)}
                    aria-label={`One fewer ${d.name} run`}
                    className="btn-press touch-target w-8 h-8 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[15px] font-bold"
                    style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text)" }}
                  >
                    -
                  </button>
                  <span className="text-[14px] font-bold tabular-nums w-6 text-center" aria-label={`${d.runs} ${d.name} runs planned`}>{d.runs}</span>
                  <button
                    disabled={!canIncrease || executing}
                    onClick={() => adjustDungeon(idx, 1)}
                    aria-label={`One more ${d.name} run`}
                    className="btn-press touch-target w-8 h-8 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[15px] font-bold"
                    style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text)" }}
                  >
                    +
                  </button>
                  <button
                    disabled={!canIncrease || executing}
                    onClick={() => maxDungeon(idx)}
                    aria-label={`Fill remaining energy with ${d.name} runs`}
                    className="btn-press touch-target h-8 px-2.5 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[11px] font-bold uppercase tracking-wider"
                    style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
                  >
                    Max
                  </button>
                </div>
                {d.runs > 0 && (
                  <span className="text-[11px] tabular-nums font-medium shrink-0" style={{ color: "var(--orange)", minWidth: 56, textAlign: "right" }}>
                    {d.runs} = {fmt(totalCost)}E
                  </span>
                )}
              </div>
            );
          })}

          {/* Event dungeons (Void) — item entry, run from the Dungeon tab */}
          {eventDungeons.map((d) => (
            <div
              key={d.ID_CID}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
              style={{ background: "var(--bg-inset)", border: "1px dashed var(--border)" }}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold truncate" style={{ color: "var(--text-dim)" }}>
                  {d.NAME_CID}
                </div>
                <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                  Event dungeon &middot; item entry ({d.entryData!.length} tiers), no energy &middot; run it from the Dungeon tab
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Fishing steppers — one per node, all drawing on one cast pool */}
        <div className="mb-4">
          <div
            className="flex items-baseline justify-between px-3 py-2 rounded-t-lg"
            style={{ background: "var(--bg-raised)", borderTop: "1px solid var(--border)", borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)" }}
          >
            <span className="text-[13px] font-semibold">Fishing</span>
            <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
              {/* "0 of 0" would read as a spent allowance, which is a different
                  thing from one that hasn't loaded. */}
              {castsKnown ? (
                <>
                  {plannedCasts} of {remainingCasts} casts planned
                  {unplannedCasts > 0 && ` · ${unplannedCasts} unspent`}
                </>
              ) : (
                "checking today's cast allowance…"
              )}
            </span>
          </div>
          {CAST_NODES.map((node, i) => {
            const casts = castsForNode(node.nodeId);
            const canAdd =
              unplannedCasts > 0 && allocatedEnergy + node.cost <= effectiveEnergy && !executing;
            return (
              <div
                key={`${node.pondId}-${node.nodeId}`}
                className="flex items-center gap-3 px-3 py-2"
                style={{
                  background: "var(--bg-raised)",
                  border: "1px solid var(--border)",
                  borderTop: "none",
                  borderRadius: i === CAST_NODES.length - 1 ? "0 0 0.5rem 0.5rem" : undefined,
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium truncate">
                    {node.pondName} &middot; {node.label}
                  </div>
                  <div className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                    {node.cost}E per cast &middot; pays {pondCurrencyLabel(node.pondId)}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    disabled={casts <= 0 || executing}
                    onClick={() => adjustFishingNode(node.nodeId, -1)}
                    aria-label={`One fewer ${node.pondName} ${node.label} cast`}
                    className="btn-press touch-target w-8 h-8 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[15px] font-bold"
                    style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text)" }}
                  >
                    -
                  </button>
                  <span
                    className="text-[14px] font-bold tabular-nums w-6 text-center"
                    aria-label={`${casts} ${node.pondName} ${node.label} casts planned`}
                  >
                    {casts}
                  </span>
                  <button
                    disabled={!canAdd}
                    onClick={() => adjustFishingNode(node.nodeId, 1)}
                    aria-label={`One more ${node.pondName} ${node.label} cast`}
                    className="btn-press touch-target w-8 h-8 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[15px] font-bold"
                    style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text)" }}
                  >
                    +
                  </button>
                  <button
                    disabled={!canAdd}
                    onClick={() => maxFishingNode(node.nodeId)}
                    aria-label={`Fill remaining energy with ${node.pondName} ${node.label} casts`}
                    className="btn-press touch-target h-8 px-2.5 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[11px] font-bold uppercase tracking-wider"
                    style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
                  >
                    Max
                  </button>
                </div>
                <span
                  className="text-[11px] tabular-nums font-medium shrink-0"
                  style={{ color: casts > 0 ? "var(--orange)" : "transparent", minWidth: 44, textAlign: "right" }}
                >
                  {casts * node.cost}E
                </span>
              </div>
            );
          })}
        </div>

        {/* Allocation bar */}
        <div className="px-3 py-2.5 rounded-lg" style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-bold" style={{ color: "var(--text-faint)" }}>ALLOCATED</span>
            <span className="text-[13px] font-bold tabular-nums" style={{ color: allocatedEnergy > effectiveEnergy ? "var(--red)" : "var(--orange)" }}>
              {fmt(allocatedEnergy)}E / {fmt(effectiveEnergy)}E{freeActions.romEnergyMode === "claim" && totalRomE > 0 ? " (incl. ROM)" : ""}
            </span>
          </div>
          <div className="rounded-full overflow-hidden" style={{ height: 6, background: "var(--bg)" }}>
            <div
              className="h-full w-full rounded-full"
              style={{
                transform: `scaleX(${effectiveEnergy > 0 ? Math.min(1, allocatedEnergy / effectiveEnergy) : 0})`,
                transformOrigin: "left",
                background: allocatedEnergy > effectiveEnergy
                  ? "var(--red)"
                  : "linear-gradient(90deg, var(--orange-dim), var(--orange))",
                transition: "transform 0.3s ease",
              }}
            />
          </div>
        </div>
      </section>

      {/* ── Section B: Free Actions — cost no energy ── */}
      <section hidden={adjustSection !== "free"}>
        <div className="text-[14px] font-bold mb-1">Free Actions</div>
        <div className="text-[12px] mb-3" style={{ color: "var(--text-faint)" }}>
          None of these spend energy.
        </div>
        <div className="space-y-1.5">
          {/* ROM Resources (shards + dust) */}
          <label className="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", opacity: (totalRomS === 0 && totalRomD === 0) ? 0.5 : 1 }}>
            <input type="checkbox" checked={freeActions.claimRomResources} disabled={(totalRomS === 0 && totalRomD === 0) || executing} onChange={(e) => setFreeActions((prev) => ({ ...prev, claimRomResources: e.target.checked }))} className="accent-[var(--orange)]" style={{ width: 16, height: 16 }} />
            <div className="flex-1 text-[12px] font-semibold">Claim ROM shards & dust</div>
            <span className="text-[11px] tabular-nums" style={{ color: "var(--text-dim)" }}>{fmt(totalRomS)}S / {fmt(totalRomD)}D</span>
          </label>

          {/* ROM Energy — radio group: claim / convert / skip */}
          <div className="px-3 py-2 rounded-lg" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", opacity: totalRomE === 0 ? 0.5 : 1 }}>
            <div className="text-[12px] font-semibold mb-1.5">ROM Energy ({fmt(totalRomE)}E available)</div>
            <div className="flex gap-3">
              {([
                { value: "convert" as const, label: "Convert to dust" },
                { value: "claim" as const, label: "Claim as energy" },
                { value: "skip" as const, label: "Skip" },
              ]).map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="romEnergy"
                    checked={freeActions.romEnergyMode === opt.value}
                    disabled={totalRomE === 0 || executing}
                    onChange={() => setFreeActions((prev) => ({ ...prev, romEnergyMode: opt.value }))}
                    className="accent-[var(--orange)]"
                  />
                  <span className="text-[11px]" style={{ color: freeActions.romEnergyMode === opt.value ? "var(--text)" : "var(--text-faint)" }}>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Checkboxes for the rest */}
          {([
            {
              key: "openChests" as const,
              label: "Open chests",
              info: chestsReady
                ? [
                    !chestCd.onCooldown && "Chest ready",
                    juicedNow && !juiceChestCd.onCooldown && "Juice ready",
                    juicedNow && !juiceChestForestCd.onCooldown && "Forest ready",
                  ].filter(Boolean).join(" + ") || "Ready"
                : [
                    `Chest: ${chestCd.text}`,
                    juicedNow && `Juice: ${juiceChestCd.text}`,
                    juicedNow && `Forest: ${juiceChestForestCd.text}`,
                  ].filter(Boolean).join(", "),
              disabled: !chestsReady,
            },
            { key: "breakPots" as const, label: "Break pots", info: (() => { const p: string[] = []; if (!bluePotCd.onCooldown && paperHandsId) p.push("Blue ready"); else if (!bluePotCd.onCooldown) p.push("Blue: no Paper Hands"); else p.push(`Blue: ${bluePotCd.text}`); if (!tanPotCd.onCooldown && rockHandsId) p.push("Tan ready"); else if (!tanPotCd.onCooldown) p.push("Tan: no Rock Hands"); else p.push(`Tan: ${tanPotCd.text}`); return p.join(", "); })(), disabled: !potsActuallyReady },
            { key: "sellFish" as const, label: "Sell +50% fish", info: fishStallInfo.totalCount > 0 ? `${fmt(fishStallInfo.totalCount)} fish (~${fishStallInfo.proceeds.map((p) => `${fmt(p.amount)} ${p.label}`).join(" + ")})` : "None available", disabled: fishStallInfo.totalCount === 0 },
            { key: "repairGear" as const, label: "Repair worn gear", info: wornGear.length > 0 ? `${wornGear.length} item${wornGear.length === 1 ? "" : "s"} worn` : "All gear healthy", disabled: wornGear.length === 0 },
            {
              key: "spendEntryOfferings" as const,
              label: "Pay pond entry offerings",
              info: entryOfferings.length > 0
                ? `${entryOfferings.map((o) => `${o.pond.name} ${o.payable!.dropMultiplier}x`).join(", ")} — costs a faction ring per cast`
                : "No offering ring affordable",
              disabled: entryOfferings.length === 0,
            },
            { key: "vote" as const, label: "Vote on Abstract Portal", info: hasVoted ? "Voted" : "Not voted", disabled: hasVoted },
          ]).map((item) => (
            <label key={item.key} className="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", opacity: item.disabled ? 0.5 : 1 }}>
              <input type="checkbox" checked={freeActions[item.key]} disabled={item.disabled || executing} onChange={(e) => setFreeActions((prev) => ({ ...prev, [item.key]: e.target.checked }))} className="accent-[var(--orange)]" style={{ width: 16, height: 16 }} />
              <div className="flex-1 text-[12px] font-semibold">{item.label}</div>
              <span className="text-[11px] tabular-nums shrink-0" style={{ color: item.disabled ? "var(--text-faint)" : "var(--text-dim)" }}>{item.info}</span>
            </label>
          ))}
        </div>
      </section>

      {/* ── Traveling Merchant (Hugis/Munis) ── */}
      {merchantDeals.length > 0 && (
        <section hidden={adjustSection !== "merchant"}>
          <div className="flex items-center justify-between mb-3">
            <div className="text-[14px] font-bold">Traveling Merchant</div>
            <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
              deals refresh Fridays 6pm UTC
            </span>
          </div>
          {/* The auto-trade toggle lives with the deals it acts on rather than
              duplicated up in Free Actions. */}
          <label
            className="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer mb-3"
            style={{
              background: "var(--bg-raised)",
              border: "1px solid var(--border)",
              opacity: merchantDeals.filter((d) => d.recipeId && d.affordable && !d.capped).length === 0 ? 0.5 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={freeActions.tradeHugis}
              disabled={merchantDeals.filter((d) => d.recipeId && d.affordable && !d.capped).length === 0 || executing}
              onChange={(e) => setFreeActions((prev) => ({ ...prev, tradeHugis: e.target.checked }))}
              className="accent-[var(--orange)]"
              style={{ width: 16, height: 16 }}
            />
            <div className="flex-1 text-[12px] font-semibold">Trade every affordable deal in Run Plan</div>
            <span className="text-[11px] tabular-nums shrink-0" style={{ color: "var(--text-dim)" }}>
              {(() => {
                const n = merchantDeals.filter((d) => d.recipeId && d.affordable && !d.capped).length;
                return n > 0 ? `${n} affordable` : "None affordable";
              })()}
            </span>
          </label>
          <div className="space-y-1.5">
            {merchantDeals.map((d) => (
              <div
                key={d.key}
                className="px-3 py-2 rounded-lg"
                style={{
                  background: "var(--bg-raised)",
                  border: `1px solid ${d.affordable && !d.capped ? "var(--border-accent)" : "var(--border)"}`,
                  opacity: d.capped ? 0.5 : 1,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-semibold">{d.name}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    {d.max !== undefined && (
                      <span className="text-[11px] tabular-nums" style={{ color: d.capped ? "var(--text-faint)" : "var(--text-dim)" }}>
                        {d.done}/{d.max}
                      </span>
                    )}
                    {d.recipeId && !d.capped && (
                      <button
                        onClick={async () => {
                          // A trade permanently removes materials from
                          // inventory, so it takes two presses like a delete.
                          if (confirmTrade !== d.key) {
                            setConfirmTrade(d.key);
                            return;
                          }
                          setConfirmTrade(null);
                          addLog(`Trading ${d.name}...`);
                          const r = await giga.useRecipe(d.recipeId!);
                          if (r?.success !== false) {
                            const loot = formatRecipeLoot(r, giga.itemInfo, giga.itemNames);
                            addLog(loot.length > 0 ? `${d.name} — ${loot.join(", ")}` : `${d.name} traded`);
                          } else {
                            addLog(`${d.name}: ${(r as { message?: string })?.message || "failed"}`);
                          }
                          giga.refreshAll();
                        }}
                        disabled={!d.affordable || executing}
                        aria-label={
                          confirmTrade === d.key
                            ? `Confirm trading ${d.inputs.map((i) => `${i.amount} ${i.name}`).join(" and ")}`
                            : `Trade ${d.name}`
                        }
                        className="btn-press touch-target text-[11px] font-bold px-3 py-1.5 rounded cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                        style={{
                          background: confirmTrade === d.key ? "var(--orange-glow)" : "var(--bg-inset)",
                          border: "1px solid var(--border-accent)",
                          color: "var(--orange)",
                        }}
                      >
                        {confirmTrade === d.key ? "Confirm?" : "Trade"}
                      </button>
                    )}
                  </span>
                </div>
                {(d.inputs.length > 0 || d.outputs.length > 0) && (
                  <div className="text-[11px] mt-0.5" style={{ color: "var(--text-faint)" }}>
                    {d.inputs.map((inp) => `${inp.amount}x ${inp.name}`).join(" + ")}
                    {d.outputs.length > 0 && (
                      <> &rarr; {d.outputs.map((o) => `${o.amount}x ${o.name}`).join(" + ")}</>
                    )}
                    {d.affordable && !d.capped && (
                      <span className="font-semibold" style={{ color: "var(--green)" }}> &middot; tradeable now</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="text-[11px] mt-2" style={{ color: "var(--text-faint)" }}>
            Run Plan trades every affordable deal to its cap when the free action is checked.
          </div>
        </section>
      )}

      {/* ── Section C: Presets ── */}
      <section hidden={adjustSection !== "presets"}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[14px] font-bold">Presets</div>
          <button
            onClick={() => setShowPresetInput(!showPresetInput)}
            disabled={executing}
            className="btn-press text-[11px] font-semibold px-3 py-1.5 rounded cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
          >
            {showPresetInput ? "Cancel" : "Save as preset"}
          </button>
        </div>

        {showPresetInput && (
          <div className="flex items-center gap-2 mb-3">
            <input
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && savePreset()}
              placeholder="Preset name..."
              className="flex-1 text-[12px] px-3 py-2 rounded-lg"
              style={{
                background: "var(--bg-inset)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                outline: "none",
              }}
            />
            <button
              onClick={savePreset}
              disabled={!presetName.trim()}
              className="btn-press text-[11px] font-bold px-4 py-2 rounded-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: "var(--orange)", border: "none", color: "var(--on-orange)" }}
            >
              Save
            </button>
          </div>
        )}

        {presets.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <div key={p.name} className="flex items-center gap-1">
                <button
                  onClick={() => loadPreset(p)}
                  disabled={executing}
                  className="btn-press text-[11px] font-semibold px-3 py-1.5 rounded-l-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRight: "none", color: "var(--text)" }}
                >
                  {p.name}
                </button>
                <button
                  onClick={() => {
                    if (confirmDelete === p.name) {
                      deletePreset(p.name);
                      setConfirmDelete(null);
                    } else {
                      setConfirmDelete(p.name);
                    }
                  }}
                  disabled={executing}
                  aria-label={confirmDelete === p.name ? `Confirm deleting preset ${p.name}` : `Delete preset ${p.name}`}
                  className="btn-press touch-target text-[11px] font-semibold px-2.5 py-1.5 rounded-r-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{
                    background: confirmDelete === p.name ? "var(--red-glow)" : "var(--bg-raised)",
                    border: `1px solid ${confirmDelete === p.name ? "var(--red-border)" : "var(--border)"}`,
                    color: confirmDelete === p.name ? "var(--red)" : "var(--text-faint)",
                    minWidth: 28,
                  }}
                >
                  {confirmDelete === p.name ? "delete?" : "×"}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            No saved presets. Configure your plan and save it for quick reuse.
          </div>
        )}
      </section>
            </div>

            {/* Footer */}
            <div
              className="shrink-0 px-5 py-3"
              style={{ borderTop: "1px solid var(--border)", background: "var(--bg-raised)" }}
            >
              <button
                onClick={() => setAdjusting(false)}
                className="btn-press cta-orange w-full py-2.5 rounded-lg text-[13px] font-bold cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Progress + Activity ── */}
      <section>
        {/* Inline Progress + Activity Feed (visible when modal is closed) */}
        {!showModal && (steps.length > 0 || mcLog.length > 0) && (
          <div
            ref={progressRef}
            role="button"
            tabIndex={0}
            aria-label={executing ? "Reopen the run in progress" : "Reopen the last run"}
            className="mt-4 rounded-lg overflow-hidden cursor-pointer"
            style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}
            onClick={() => setShowModal(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setShowModal(true);
              }
            }}
          >
            {/* Outcome leads here too — the minimized card is a glance, and
                the glance should answer "what did I get", not "what scrolled
                past last". The log is capped so it can't run off the page. */}
            {outcomeContent}
            {stepsContent}
            <div className="log-area" style={{ maxHeight: 220, overflowY: "auto" }}>
              {activityContent}
            </div>
          </div>
        )}

        {!showModal && summary && !steps.length && !mcLog.length && (
          <div className="mt-4 rounded-lg overflow-hidden" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}>
            {outcomeContent}
          </div>
        )}
      </section>

      {/* Execution / Review Modal */}
      {showModal && (
        <div className="fixed inset-0" style={{ zIndex: 50 }}>
          <div
            className="fixed inset-0"
            style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
            onClick={closeModal}
          />
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label={summary ? "Run results" : "Run progress"}
            tabIndex={-1}
            className="run-modal fixed inset-x-4 mx-auto flex flex-col rounded-xl overflow-hidden"
            style={{
              background: "var(--bg-raised)",
              border: "1px solid var(--border)",
              zIndex: 51,
              boxShadow: "0 24px 48px rgba(0,0,0,0.4)",
              outline: "none",
            }}
          >
            {/* Modal header. While the run is going it carries the status:
                what step is on, how far through the plan, and what the energy
                pool is down to — the three things you reopen the modal to
                check, without having to read the log to infer them. */}
            <div className="shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-center justify-between px-5 py-3">
                <span className="text-[15px] font-bold" style={{ color: "var(--text)" }}>
                  {stopping ? "Stopping…" : executing ? "Running" : summary ? "Run Complete" : "Run"}
                </span>
                <button
                  onClick={closeModal}
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium cursor-pointer"
                  style={{ color: "var(--text-dim)", background: "var(--bg-inset)", border: "1px solid var(--border)" }}
                >
                  Minimize
                </button>
              </div>

              {executing && steps.length > 0 && (
                <div className="px-5 pb-3 flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="text-[12.5px] font-medium truncate" style={{ color: "var(--text-dim)" }}>
                      {stopping
                        ? "Finishing the current action, then stopping"
                        : runningStep?.label ?? "Starting…"}
                    </span>
                    <span className="text-[11.5px] tabular-nums shrink-0" style={{ color: "var(--text-faint)" }}>
                      {settledSteps}/{steps.length} steps · {fmt(currentEnergy)}E left
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuenow={settledSteps}
                    aria-valuemin={0}
                    aria-valuemax={steps.length}
                    aria-label="Plan progress"
                    className="rounded-full overflow-hidden"
                    style={{ height: 3, background: "var(--bg-inset)" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${stepPct}%`,
                        background: stopping ? "var(--red)" : "var(--orange)",
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Modal body.
                Two panes throughout: what the run is collecting on the left,
                what it is doing on the right, each with its own scroll. One
                shared scroll column was the original problem — a few hundred
                activity lines sat between you and your haul. Below 900px the
                panes stack, the haul still first. */}
            <div className="run-panes flex-1 min-h-0">
              <div className="run-pane log-area">{outcomeContent}</div>
              <div className="run-pane run-pane-detail log-area">
                {stepsContent}
                {activityContent}
              </div>
            </div>

            {/* Modal footer */}
            <div className="shrink-0 px-5 py-3 flex gap-3" style={{ borderTop: "1px solid var(--border)" }}>
              {
                // While the run is going the footer carries only Stop. The
                // header already offers Minimize, and the two used to sit here
                // under the same label firing the same handler — two buttons
                // for one action, which reads as a choice that isn't there.
                executing ? (
                  <button
                    onClick={handleStop}
                    disabled={stopping}
                    className="flex-1 py-2 rounded-lg text-[13px] font-semibold cursor-pointer disabled:cursor-not-allowed"
                    style={{
                      background: "var(--red-glow)",
                      border: "1px solid var(--red-border)",
                      color: "var(--red)",
                      opacity: stopping ? 0.7 : 1,
                    }}
                  >
                    {stopping ? "Stopping after current action…" : "Stop"}
                  </button>
                ) : (
                  <button
                    onClick={closeModal}
                    className="flex-1 py-2 rounded-lg text-[13px] font-medium cursor-pointer"
                    style={{
                      background: "var(--bg-inset)",
                      border: "1px solid var(--border)",
                      color: "var(--text-dim)",
                    }}
                  >
                    Close
                  </button>
                )
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
