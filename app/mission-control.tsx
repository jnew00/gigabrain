"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { useGigaverse } from "@/lib/use-gigaverse";
import { pickBestAction } from "@/lib/auto-battle";
import { probeEnemyMove } from "@/lib/enemy-probe";
import { pickBestCard, pickGroveMove, resolveGrid } from "@/lib/fishing-ai";
import { beginHaulCapture, endHaulCapture } from "@/lib/use-gigaverse";
import { probeFishMove } from "@/lib/fishing-probe";
import { Sword, Package, Fish, AlertTriangle, Info, Lightbulb } from "lucide-react";
import { recordRunAction, getDungeonPerformanceAction } from "./actions";
import { getMaxRunsPerDay, findDungeonInfo, isEventDungeon, isAwakeningActive, castTierForNode, castsUsedToday, pickEntryTier, CLAIM_RECIPES, CLAIM_RECIPE_IDS, AWAKENING, FISHING } from "@/lib/game-data";
import { buildRecommendation } from "@/lib/energy-advisor";
import type { AdvisorResult } from "@/lib/energy-advisor";


/* ─── Constants ────────────────────────────────────────────── */

// The Grove is a node like any other, so the stepper and every nodeId lookup
// need it in the list while the event is running.
const CAST_NODES = isAwakeningActive()
  ? [...FISHING.nodes, AWAKENING.pond]
  : [...FISHING.nodes];

// Recipe ids come from the shared claim table in game-data so this file and
// the Pots & Chests panel cannot drift apart again.
const RECIPE_ITEMS = CLAIM_RECIPE_IDS;

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

interface FishingAlloc {
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
}

interface Preset {
  name: string;
  dungeonAllocs: DungeonAlloc[];
  fishingAlloc: FishingAlloc;
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

function loadLastAlloc(): { dungeonAllocs?: DungeonAlloc[]; fishingAlloc?: FishingAlloc; freeActions?: FreeActions } | null {
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
    return data;
  } catch {
    return null;
  }
}

function saveLastAlloc(data: { dungeonAllocs: DungeonAlloc[]; fishingAlloc: FishingAlloc; freeActions: FreeActions }) {
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
  const [reviewing, setReviewing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [adjustSection, setAdjustSection] = useState<"energy" | "free" | "merchant" | "presets">("energy");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmTrade, setConfirmTrade] = useState<string | null>(null);
  const [confirmRepairAll, setConfirmRepairAll] = useState(false);
  const restoredEmptyRef = useRef(false);
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

  // Dungeon data
  const dungeons = giga.dungeonToday?.dungeonDataEntities ?? [];
  const dayProgress = giga.dungeonToday?.dayProgressEntities ?? [];

  // Initialize dungeon allocations
  const [dungeonAllocs, setDungeonAllocs] = useState<DungeonAlloc[]>([]);
  const [fishingAlloc, setFishingAlloc] = useState<FishingAlloc>({
    castNodeId: "1", castCost: 16, castLabel: "Normal", casts: 0,
  });
  const [freeActions, setFreeActions] = useState<FreeActions>({
    claimRomResources: true,
    romEnergyMode: "convert",
    openChests: true,
    breakPots: true,
    sellFish: true,
    vote: true,
    tradeHugis: true,
    repairGear: true,
  });

  // Initialize dungeon allocs when data arrives
  useEffect(() => {
    if (dungeons.length === 0) return;
    const last = loadLastAlloc();

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

    if (last?.fishingAlloc) {
      // Clamp saved fishing casts by remaining energy
      const maxCasts = last.fishingAlloc.castCost > 0
        ? Math.floor(energyBudget / last.fishingAlloc.castCost)
        : 0;
      setFishingAlloc({ ...last.fishingAlloc, casts: Math.min(last.fishingAlloc.casts, maxCasts) });
    } else {
      // Auto-determine best cast type
      const fs = giga.fishingState;
      if (fs) {
        const castNode = recommendCast(currentEnergy, fs);
        const node = CAST_NODES.find((n) => n.nodeId === castNode) ?? CAST_NODES[1];
        setFishingAlloc({ castNodeId: node.nodeId, castCost: node.cost, castLabel: node.label, casts: 0 });
      }
    }

    if (last?.freeActions) {
      setFreeActions(last.freeActions);
    }

    // Plan-first: if nothing was restored, the advisor's plan fills in once it's ready
    restoredEmptyRef.current =
      allocs.every((a) => a.runs === 0) && !(last?.fishingAlloc && last.fishingAlloc.casts > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dungeons.length]);

  // Fishing state
  const fs = giga.fishingState;
  const isJuiced = eng?.isPlayerJuiced ?? false;
  const castsToday = castsUsedToday(fs);
  const maxCasts = isJuiced
    ? (fs?.maxPerDayJuiced ?? FISHING.juicedMaxCastsPerDay)
    : (fs?.maxPerDay ?? FISHING.maxCastsPerDay);
  const remainingCasts = Math.max(0, maxCasts - castsToday);

  // Recommended cast
  function recommendCast(energy: number, fishState: NonNullable<typeof fs>): string {
    const maxC = isJuiced
      ? (fishState.maxPerDayJuiced ?? FISHING.juicedMaxCastsPerDay)
      : (fishState.maxPerDay ?? FISHING.maxCastsPerDay);
    const remaining = Math.max(0, maxC - castsUsedToday(fishState));
    if (remaining <= 0) return "0";
    const bigCasts = Math.min(remaining, Math.floor(energy / (fishState.node2Energy || 20)));
    const normalCasts = Math.min(remaining, Math.floor(energy / (fishState.node1Energy || 16)));
    if (bigCasts >= remaining) return "2";
    if (normalCasts >= remaining) return "1";
    if (bigCasts >= remaining * 0.8) return "2";
    if (normalCasts >= remaining * 0.8) return "1";
    return "0";
  }

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
  const fishingEnergy = fishingAlloc.casts * fishingAlloc.castCost;
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

  // Find hands gear for pots
  const findHandsGear = (handsType: "Paper Hands" | "Rock Hands"): string => {
    if (!giga.gearInstances?.entities) return "";
    for (const g of giga.gearInstances.entities) {
      const name = giga.itemInfo[String(g.GAME_ITEM_ID_CID)]?.name || "";
      if (handsType === "Paper Hands" && name.toLowerCase().includes("paper")) return g.docId;
      if (handsType === "Rock Hands" && name.toLowerCase().includes("rock")) return g.docId;
    }
    return "";
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
        return { id: r.id, qty, value: r.value, pct };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null && f.pct >= 50);
    const totalCount = fish.reduce((s, f) => s + f.qty, 0);
    const totalSeaweed = fish.reduce((s, f) => s + f.value * f.qty, 0);
    return { fish, totalCount, totalSeaweed };
  }, [fs?.exchangeRates, giga.itemBalances]);

  // Save current allocation to localStorage when it changes
  useEffect(() => {
    if (dungeonAllocs.length > 0) {
      saveLastAlloc({ dungeonAllocs, fishingAlloc, freeActions });
    }
  }, [dungeonAllocs, fishingAlloc, freeActions]);

  /* ─── Energy Advisor ────────────────────────────────────── */

  // Per-dungeon run history (last 30 days) for performance-aware advice
  const [dungeonPerf, setDungeonPerf] = useState<
    Record<string, { total_runs: number; wins: number; avg_rooms: number }>
  >({});
  useEffect(() => {
    if (!giga.address) return;
    getDungeonPerformanceAction(giga.address)
      .then((rows) => {
        const map: Record<string, { total_runs: number; wins: number; avg_rooms: number }> = {};
        for (const r of rows) map[r.dungeon_name] = r;
        setDungeonPerf(map);
      })
      .catch(() => {});
  }, [giga.address]);

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
          runsLeft: d.maxRuns,
          winRate: perf && perf.total_runs > 0 ? perf.wins / perf.total_runs : null,
          avgRooms: perf?.avg_rooms ?? null,
          totalRuns: perf?.total_runs ?? 0,
          eventPriority: isEventDungeon(d.name),
        };
      }),
      fishingCastsLeft: remainingCasts,
      // The Grove shares the daily cast pool, so this redirects casts rather
      // than adding any. Gated on the event so it lapses on its own end date.
      eventFishingNode: isAwakeningActive() ? { ...AWAKENING.pond } : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dungeonAllocs, currentEnergy, maxEnergy, isJuiced, totalRomE, dungeonPerf, remainingCasts]);

  const applyRecommendation = () => {
    if (!recommendation) return;
    setDungeonAllocs((prev) =>
      prev.map((d) => {
        const rec = recommendation.dungeonRuns.find((r) => r.dungeonId === d.dungeonId);
        return { ...d, runs: rec ? Math.min(rec.runs, d.maxRuns) : 0 };
      })
    );
    const node = CAST_NODES.find((n) => n.nodeId === recommendation.fishing.nodeId) ?? CAST_NODES[1];
    setFishingAlloc({
      castNodeId: node.nodeId,
      castCost: node.cost,
      castLabel: node.label,
      casts: recommendation.fishing.casts,
    });
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
    const out: { docId: string; name: string; durability: number; equipped: boolean }[] = [];
    for (const g of giga.gearInstances?.entities ?? []) {
      const name = giga.itemInfo[String(g.GAME_ITEM_ID_CID)]?.name || `Gear #${g.GAME_ITEM_ID_CID}`;
      const lower = name.toLowerCase();
      const relevant =
        g.EQUIPPED_TO_SLOT_CID >= 0 ||
        ["hand", "rod", "lure"].some((k) => lower.includes(k));
      if (!relevant) continue;
      if (g.DURABILITY_CID <= 1) {
        out.push({ docId: g.docId, name, durability: g.DURABILITY_CID, equipped: g.EQUIPPED_TO_SLOT_CID >= 0 });
      }
    }
    return out;
  }, [giga.gearInstances, giga.itemInfo]);

  // Still worn, but repair will be refused — these need the restore flow, so
  // they stay visible as a warning and out of every repair attempt.
  const exhaustedGear = useMemo(
    () => allWornGear.filter((g) => unrepairable.has(g.docId)),
    [allWornGear, unrepairable]
  );
  const wornGear = useMemo(
    () => allWornGear.filter((g) => !unrepairable.has(g.docId)),
    [allWornGear, unrepairable]
  );

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
      const newRuns = Math.max(0, Math.min(d.maxRuns, d.runs + delta));
      const energyDelta = (newRuns - d.runs) * d.energyCost;
      if (allocatedEnergy + energyDelta > effectiveEnergy && delta > 0) return prev;
      next[idx] = { ...d, runs: newRuns };
      return next;
    });
  };

  const adjustFishing = (delta: number) => {
    setFishingAlloc((prev) => {
      const newCasts = Math.max(0, Math.min(remainingCasts, prev.casts + delta));
      const energyDelta = (newCasts - prev.casts) * prev.castCost;
      if (allocatedEnergy + energyDelta > effectiveEnergy && delta > 0) return prev;
      return { ...prev, casts: newCasts };
    });
  };

  const changeCastNode = (nodeId: string) => {
    const node = CAST_NODES.find((n) => n.nodeId === nodeId);
    if (!node) return;
    setFishingAlloc((prev) => ({
      ...prev,
      castNodeId: node.nodeId,
      castCost: node.cost,
      castLabel: node.label,
      casts: Math.min(prev.casts, Math.floor(currentEnergy / node.cost)),
    }));
  };

  const maxDungeon = (idx: number) => {
    setDungeonAllocs((prev) => {
      const next = [...prev];
      const d = next[idx];
      const spare = effectiveEnergy - allocatedEnergy;
      const affordable = d.runs + Math.floor(spare / d.energyCost);
      next[idx] = { ...d, runs: Math.max(0, Math.min(d.maxRuns, affordable)) };
      return next;
    });
  };

  const maxFishing = () => {
    setFishingAlloc((prev) => {
      const spare = effectiveEnergy - allocatedEnergy;
      const affordable = prev.casts + Math.floor(spare / prev.castCost);
      return { ...prev, casts: Math.max(0, Math.min(remainingCasts, affordable)) };
    });
  };

  /* ─── Preset handlers ───────────────────────────────────── */

  const savePreset = () => {
    if (!presetName.trim()) return;
    const preset: Preset = {
      name: presetName.trim(),
      dungeonAllocs,
      fishingAlloc,
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
      return { ...d, runs: saved ? Math.min(saved.runs, d.maxRuns) : 0 };
    });
    setDungeonAllocs(newAllocs);
    setFishingAlloc({
      ...preset.fishingAlloc,
      casts: Math.min(preset.fishingAlloc.casts, remainingCasts),
    });
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

  // The summary has to report what actually happened, including steps that
  // failed or never ran. Reading the live step list from a ref keeps that
  // honest without waiting for a state flush.
  const finishRun = useCallback(
    (
      outcome: "done" | "cancelled" | "error",
      stats: { dungeonRuns: number; dungeonWins: number; fishCasts: number; fishCaught: number; seaweedEarned: number },
      errorMessage?: string
    ) => {
      const parts: string[] = [];
      if (stats.dungeonRuns > 0) parts.push(`${stats.dungeonRuns} dungeon runs (${stats.dungeonWins}W)`);
      if (stats.fishCasts > 0) parts.push(`${stats.fishCasts} casts, ${stats.fishCaught} fish caught`);
      if (stats.seaweedEarned > 0) parts.push(`${fmt(stats.seaweedEarned)} seaweed earned`);

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
      const deltas = endHaulCapture();
      const info = gigaRef.current.itemInfo;
      const names = gigaRef.current.itemNames;
      setHaul(
        deltas
          .map((d) => ({
            id: d.id,
            name: info[String(d.id)]?.name || names[String(d.id)] || `Item #${d.id}`,
            amount: d.amount,
            rarity: info[String(d.id)]?.rarity,
          }))
          .sort((a, b) => b.amount - a.amount)
      );

      setSummary(text);
      setSummaryFailed(outcome !== "done" || failed > 0);
      setLiveMessage(text);
      try {
        localStorage.setItem(LAST_RUN_KEY, text);
      } catch { /* private mode / quota — the in-session summary still stands */ }
    },
    []
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
      stepList.push({ id: "claim-energy", label: "Claim ROM energy", status: "pending", detail: `${fmt(totalRomE)}E` });
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
    if (fishingAlloc.casts > 0) {
      stepList.push({ id: "fishing", label: `Fishing ${fishingAlloc.castLabel} x${fishingAlloc.casts}`, status: "pending", detail: `${fishingAlloc.casts * fishingAlloc.castCost}E` });
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
        detail: `${byFish}\n${fmt(fishStallInfo.totalCount)} fish → ~${fmt(fishStallInfo.totalSeaweed)} seaweed`,
        brief: `${fmt(fishStallInfo.totalCount)} fish → ~${fmt(fishStallInfo.totalSeaweed)} seaweed`,
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

    const summaryStats = { dungeonRuns: 0, dungeonWins: 0, fishCasts: 0, fishCaught: 0, seaweedEarned: 0 };

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
        let count = 0;
        for (const rom of g().roms?.entities ?? []) {
          if (cancelRef.current) break;
          const amt = Math.floor(rom.factoryStats.energyCollectable);
          if (amt <= 0) continue;
          try {
            const r = await g().claimRom(rom.docId, "energy");
            if (r?.success) { count++; log(`claimed energy #${rom.factoryStats.serialNumber}`); }
          } catch { /* already claimed or rate limited */ }
          await delay(200);
        }
        updateStep("claim-energy", { status: cancelRef.current ? "skipped" : "done", detail: `${count} ROMs` });
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
            const won = finalRoom >= 16;
            const player = battleState?.data?.run?.players?.[0];
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

        summaryStats.dungeonWins += runResults.filter((r) => Number(r) >= 16).length;
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

      // 7. Fishing casts
      if (fishingAlloc.casts > 0 && stepList.find((s) => s.id === "fishing")) {
        const stepId = "fishing";
        if (cancelRef.current) { updateStep(stepId, { status: "skipped" }); }
        else {
          updateStep(stepId, { status: "running", detail: "starting..." });
          let caught = 0;
          let escaped = 0;

          // Check if there's a completed game needing loot (card pick + collect)
          const preFish = await g().fetchFishingState();
          // Track pending cardsToAdd from completed games
          let pendingCardsToAdd: { id: number }[] | null = null;
          if (preFish?.gameState?.COMPLETE_CID && preFish.gameState.SUCCESS_CID) {
            pendingCardsToAdd = preFish.gameState.data?.cardsToAdd ?? null;
            log(`Previous catch pending, cards to pick: ${pendingCardsToAdd?.map(c => c.id).join(", ") ?? "none"}`, "fishing");
          } else if (preFish?.gameState?.data && !preFish.gameState.COMPLETE_CID) {
            // Active in-progress game — play through it first
            log(`Active fishing game found, finishing it...`, "fishing");
            for (let i = 0; i < 50; i++) {
              if (cancelRef.current) break;
              const fs = await g().fetchFishingState();
              if (!fs?.gameState?.data || fs.gameState.COMPLETE_CID) {
                if (fs?.gameState?.SUCCESS_CID) {
                  pendingCardsToAdd = fs.gameState.data?.cardsToAdd ?? null;
                }
                break;
              }
              const gd = fs.gameState.data;
              if (!gd.hand || gd.hand.length === 0) { await delay(300); continue; }
              // The Grove picks card and lure together; other ponds keep the
              // board-cell path.
              const grove = gd.focusMechanicEnabled ? pickGroveMove(gd) : null;
              if (gd.focusMechanicEnabled && !grove) break;
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
                if (cr.data.doc.SUCCESS_CID) {
                  pendingCardsToAdd = cr.data.doc.data?.cardsToAdd ?? null;
                }
                break;
              }
              await delay(300);
            }
          }

          let stoppedShort = "";
          for (let cast = 0; cast < fishingAlloc.casts; cast++) {
            if (cancelRef.current) break;

            // The plan's energy budget was computed before the run started;
            // dungeons may have spent more than projected. Both "start_run" and
            // "loot" begin a new cast, so an unaffordable one is rejected
            // outright — check against live energy first.
            const liveEnergy = Math.floor(
              g().energy?.entities?.[0]?.parsedData?.energyValue ?? 0
            );
            if (liveEnergy < fishingAlloc.castCost) {
              stoppedShort = `out of energy after ${cast} of ${fishingAlloc.casts} casts (${liveEnergy}E left, need ${fishingAlloc.castCost}E)`;
              log(`Fishing stopped: ${stoppedShort}`, "fishing");
              break;
            }

            updateStep(stepId, { detail: `cast ${cast + 1}/${fishingAlloc.casts}...` });
            log(`Fishing cast ${cast + 1}/${fishingAlloc.casts} (${fishingAlloc.castLabel})`, "fishing");

            try {
              let startResult;

              if (pendingCardsToAdd && pendingCardsToAdd.length > 0) {
                // Use "loot" action: collect fish + pick card + start next cast in one request
                // Pick the first earnable card (simple heuristic)
                const chosenCard = pendingCardsToAdd[0].id;
                log(`Collecting fish, picking card ${chosenCard}`, "fishing");
                startResult = await g().fishingAction("loot", { cards: [chosenCard], nodeId: fishingAlloc.castNodeId });
                pendingCardsToAdd = null; // consumed
              } else {
                // No pending card pick — normal start_run
                startResult = await g().fishingAction("start_run", { cards: [], nodeId: fishingAlloc.castNodeId, tierId: castTierForNode(fishingAlloc.castNodeId) });
                // If start fails, retry with recovered token
                if (!startResult) {
                  await delay(300);
                  startResult = await g().fishingAction("start_run", { cards: [], nodeId: fishingAlloc.castNodeId, tierId: castTierForNode(fishingAlloc.castNodeId) });
                }
              }

              if (!startResult) {
                log(`Fishing cast failed to start: ${g().lastErrorRef.current || "unknown"}`, "error");
                escaped++;
                continue;
              }

              summaryStats.fishCasts++;

              // Play cards loop
              let fishComplete = false;
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
                  const success = stateResult?.gameState?.SUCCESS_CID;
                  if (success) {
                    caught++;
                    const fish = gameData?.caughtFish;
                    const seaweed = fish?.seaweedEarned ?? 0;
                    summaryStats.seaweedEarned += seaweed;
                    pendingCardsToAdd = gameData?.cardsToAdd ?? null;
                    log(`Caught ${fish?.name ?? "fish"} (+${seaweed} seaweed)`, "fishing");
                  } else {
                    escaped++;
                    pendingCardsToAdd = null;
                    log(`Fish escaped`, "fishing");
                  }
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

                // Check if complete from card result
                const doc = cardResult.data.doc;
                if (doc.COMPLETE_CID) {
                  fishComplete = true;
                  if (doc.SUCCESS_CID) {
                    caught++;
                    const fish = doc.data?.caughtFish;
                    const seaweed = fish?.seaweedEarned ?? 0;
                    summaryStats.seaweedEarned += seaweed;
                    pendingCardsToAdd = doc.data?.cardsToAdd ?? null;
                    log(`Caught ${fish?.name ?? "fish"} (+${seaweed} seaweed)`, "fishing");
                  } else {
                    escaped++;
                    pendingCardsToAdd = null;
                    log(`Fish escaped`, "fishing");
                  }
                }

                await delay(300);
              }
            } catch (e) {
              log(`Fishing error: ${e instanceof Error ? e.message : "unknown"}`, "error");
              escaped++;
            }

            summaryStats.fishCaught += caught;

            if (cast < fishingAlloc.casts - 1) {
              await g().refreshAll();
              await delay(300);
            }
          }

          updateStep(stepId, {
            status: cancelRef.current ? "skipped" : "done",
            detail: stoppedShort
              ? `${caught} caught / ${escaped} escaped — ${stoppedShort}`
              : `${caught} caught / ${escaped} escaped`,
          });
          await g().refreshAll();
        }
      }

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
              return { id: r.id, qty, value: r.value, pct };
            })
            .filter((f): f is NonNullable<typeof f> => f !== null && f.pct >= 50);

          let totalSold = 0;
          let totalEarned = 0;
          for (const f of fishToSell) {
            if (cancelRef.current) break;
            for (let i = 0; i < f.qty; i++) {
              if (cancelRef.current) break;
              try {
                const r = await g().sellFish(f.id, 1, f.value);
                if (r?.success) {
                  totalSold++;
                  totalEarned += r.data?.value ?? f.value;
                } else {
                  log(`Sell failed: ${r?.message || "error"}`, "error");
                  break;
                }
              } catch { break; }
              await delay(150);
            }
          }
          summaryStats.seaweedEarned += totalEarned;
          updateStep("sell-fish", { status: "done", detail: `${totalSold} sold, ${totalEarned} seaweed` });
          log(`Sold ${totalSold} fish for ${totalEarned} seaweed`, "fishing");
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

  /* ─── Review-before-run ─────────────────────────────────── */

  const openReview = () => {
    const preview = buildStepList();
    stepsRef.current = preview;
    setSteps(preview);
    setSummary(null);
    setReviewing(true);
    setShowModal(true);
  };

  const confirmRun = () => {
    setReviewing(false);
    void execute();
  };

  const closeModal = () => {
    // Cancelling a review clears the previewed steps so the inline
    // progress card doesn't show a plan that never ran
    if (reviewing && !executing) { stepsRef.current = []; setSteps([]); }
    setReviewing(false);
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

  const progressContent = (steps.length > 0 || mcLog.length > 0) ? (
    <>
      {steps.length > 0 && (
        <>
          <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
            <span className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--text-faint)" }}>
              {reviewing ? "Plan" : "Progress"}
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
      )}

      {mcLog.length > 0 && (
        <>
          <div className="px-4 py-2.5" style={{ borderTop: steps.length > 0 ? "1px solid var(--border)" : undefined }}>
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
            className="overflow-y-auto px-4 pb-3 flex flex-col gap-1"
            style={{ scrollbarWidth: "none" }}
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
      )}
    </>
  ) : null;

  const summaryContent = summary ? (
    <div
      className="mt-3 px-4 py-3 rounded-lg text-[13px] font-medium"
      style={{
        background: summaryFailed ? "var(--red-glow)" : "var(--green-glow)",
        border: `1px solid ${summaryFailed ? "var(--red-border)" : "var(--green-border)"}`,
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
  const haulContent = haul.length > 0 ? (
    <div className="mt-3 card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
          Haul
        </h3>
        <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
          {haul.filter((h) => h.amount > 0).length} item{haul.filter((h) => h.amount > 0).length === 1 ? "" : "s"} gained
        </span>
      </div>
      <div className="flex flex-col gap-1" style={{ maxHeight: 320, overflowY: "auto" }}>
        {haul.map((h) => (
          <div key={h.id} className="flex items-center justify-between text-[12px]">
            <span className="truncate" style={{ color: RARITY_COLORS[h.rarity ?? 0] ?? "var(--text)" }}>
              {h.name}
            </span>
            <span
              className="tabular-nums shrink-0 ml-3 font-semibold"
              style={{ color: h.amount > 0 ? "var(--green)" : "var(--red)" }}
            >
              {h.amount > 0 ? "+" : ""}{fmt(h.amount)}
            </span>
          </div>
        ))}
      </div>
    </div>
  ) : null;

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
            These have hit their repair limit. Repairing them is refused, so the plan skips
            them — restore them in Gigaverse to keep using them.
          </div>
          <div className="space-y-1">
            {exhaustedGear.map((g) => (
              <div key={g.docId} className="text-[12px]" style={{ color: "var(--text-dim)" }}>
                <span className="font-semibold" style={{ color: "var(--text)" }}>{g.name}</span>
                {" — "}
                {g.durability <= 0 ? "broken" : "1 use left"}
                {g.equipped && " (equipped)"}
              </div>
            ))}
          </div>
        </section>
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
                  onClick={openReview}
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
            const canIncrease = d.runs < d.maxRuns && allocatedEnergy + d.energyCost <= effectiveEnergy;
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
                    {d.energyCost}E per run &middot; {d.maxRuns} remaining
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

        {/* Fishing stepper */}
        <div
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg mb-4"
          style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}
        >
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold">Fishing</div>
            <div className="flex items-center gap-2 mt-1">
              {CAST_NODES.map((node) => (
                <button
                  key={node.nodeId}
                  disabled={executing}
                  onClick={() => changeCastNode(node.nodeId)}
                  className="btn-press touch-target text-[11px] font-bold px-2.5 py-1 rounded cursor-pointer disabled:cursor-not-allowed"
                  style={{
                    background: fishingAlloc.castNodeId === node.nodeId ? "var(--orange-glow)" : "var(--bg-inset)",
                    border: fishingAlloc.castNodeId === node.nodeId ? "1px solid var(--border-accent)" : "1px solid var(--border)",
                    color: fishingAlloc.castNodeId === node.nodeId ? "var(--orange)" : "var(--text-faint)",
                  }}
                >
                  {node.label} ({node.cost}E)
                </button>
              ))}
            </div>
            <div className="text-[11px] tabular-nums mt-1" style={{ color: "var(--text-faint)" }}>
              {remainingCasts} casts remaining today
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              disabled={fishingAlloc.casts <= 0 || executing}
              onClick={() => adjustFishing(-1)}
              aria-label="One fewer fishing cast"
              className="btn-press touch-target w-8 h-8 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[15px] font-bold"
              style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text)" }}
            >
              -
            </button>
            <span className="text-[14px] font-bold tabular-nums w-6 text-center" aria-label={`${fishingAlloc.casts} fishing casts planned`}>{fishingAlloc.casts}</span>
            <button
              disabled={fishingAlloc.casts >= remainingCasts || allocatedEnergy + fishingAlloc.castCost > effectiveEnergy || executing}
              onClick={() => adjustFishing(1)}
              aria-label="One more fishing cast"
              className="btn-press touch-target w-8 h-8 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[15px] font-bold"
              style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text)" }}
            >
              +
            </button>
            <button
              disabled={fishingAlloc.casts >= remainingCasts || allocatedEnergy + fishingAlloc.castCost > effectiveEnergy || executing}
              onClick={maxFishing}
              aria-label="Fill remaining energy with fishing casts"
              className="btn-press touch-target h-8 px-2.5 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[11px] font-bold uppercase tracking-wider"
              style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
            >
              Max
            </button>
          </div>
          {fishingAlloc.casts > 0 && (
            <span className="text-[11px] tabular-nums font-medium shrink-0" style={{ color: "var(--orange)", minWidth: 56, textAlign: "right" }}>
              {fishingAlloc.casts} = {fishingAlloc.casts * fishingAlloc.castCost}E
            </span>
          )}
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
            { key: "sellFish" as const, label: "Sell +50% fish", info: fishStallInfo.totalCount > 0 ? `${fmt(fishStallInfo.totalCount)} fish (~${fmt(fishStallInfo.totalSeaweed)} seaweed)` : "None available", disabled: fishStallInfo.totalCount === 0 },
            { key: "repairGear" as const, label: "Repair worn gear", info: wornGear.length > 0 ? `${wornGear.length} item${wornGear.length === 1 ? "" : "s"} worn` : "All gear healthy", disabled: wornGear.length === 0 },
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
        {!showModal && !reviewing && (steps.length > 0 || mcLog.length > 0) && (
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
            {progressContent}
            {summaryContent}
            {haulContent}
          </div>
        )}

        {!showModal && summary && !steps.length && !mcLog.length && (
          <>
            {summaryContent}
            {haulContent}
          </>
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
            aria-label={reviewing ? "Review plan before running" : "Run progress"}
            tabIndex={-1}
            className="fixed inset-x-4 top-[10%] bottom-[10%] mx-auto flex flex-col rounded-xl overflow-hidden"
            style={{
              maxWidth: 520,
              background: "var(--bg-raised)",
              border: "1px solid var(--border)",
              zIndex: 51,
              boxShadow: "0 24px 48px rgba(0,0,0,0.4)",
              outline: "none",
            }}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
              <span className="text-[15px] font-bold" style={{ color: "var(--text)" }}>
                {reviewing ? "Review Plan" : stopping ? "Stopping…" : executing ? "Running..." : summary ? "Run Complete" : "Run"}
              </span>
              {!reviewing && (
                <button
                  onClick={closeModal}
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium cursor-pointer"
                  style={{ color: "var(--text-dim)", background: "var(--bg-inset)", border: "1px solid var(--border)" }}
                >
                  Minimize
                </button>
              )}
            </div>

            {/* Modal body — scrollable */}
            <div
              className="flex-1 min-h-0 overflow-y-auto"
              style={{ scrollbarWidth: "none" }}
            >
              {reviewing && (
                <div
                  className="px-4 pt-3 pb-1 text-[12px]"
                  style={{ color: "var(--text-dim)", lineHeight: 1.5 }}
                >
                  This run spends{" "}
                  <span className="font-bold tabular-nums" style={{ color: "var(--orange)" }}>
                    {fmt(allocatedEnergy)}E
                  </span>{" "}
                  and executes every step below on your account. Energy spent, items sold, and
                  trades made can&apos;t be undone.
                </div>
              )}
              {progressContent}
              {summaryContent && (
                <div className="px-4 pb-4">
                  {summaryContent}
                  {haulContent}
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="shrink-0 px-5 py-3 flex gap-3" style={{ borderTop: "1px solid var(--border)" }}>
              {reviewing ? (
                <>
                  <button
                    onClick={closeModal}
                    className="flex-1 py-2 rounded-lg text-[13px] font-medium cursor-pointer"
                    style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmRun}
                    className="btn-press cta-orange flex-1 py-2 rounded-lg text-[13px] font-bold cursor-pointer"
                  >
                    Confirm &amp; Run
                  </button>
                </>
              ) : (
                <>
                  {executing && (
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
                  )}
                  <button
                    onClick={closeModal}
                    className={`${executing ? "" : "flex-1 "}py-2 rounded-lg text-[13px] font-medium cursor-pointer`}
                    style={{
                      flex: executing ? 1 : undefined,
                      width: executing ? undefined : "100%",
                      background: "var(--bg-inset)",
                      border: "1px solid var(--border)",
                      color: "var(--text-dim)",
                    }}
                  >
                    {executing ? "Minimize" : "Close"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
