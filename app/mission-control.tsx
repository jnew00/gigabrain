"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { useGigaverse } from "@/lib/use-gigaverse";
import { pickBestAction, explainAction } from "@/lib/auto-battle";
import { pickBestCard } from "@/lib/fishing-ai";


/* ─── Constants ────────────────────────────────────────────── */

const CAST_NODES = [
  { nodeId: "0", label: "Small", cost: 12 },
  { nodeId: "1", label: "Normal", cost: 16 },
  { nodeId: "2", label: "Big", cost: 20 },
] as const;

const RECIPE_ITEMS = {
  chest: "Recipe#700000",
  juiceChest: "Recipe#700003",
  bluePot: "Recipe#700001",
  tanPot: "Recipe#700002",
} as const;

const PRESETS_KEY = "giga-daily-presets";
const LAST_ALLOC_KEY = "giga-daily-last";

/* ─── Types ────────────────────────────────────────────────── */

export interface MissionControlProps {
  giga: ReturnType<typeof useGigaverse>;
  addLog: (msg: string) => void;
  handleVote: () => Promise<void>;
  hasVoted: boolean;
  voting: boolean;
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
}

interface Preset {
  name: string;
  dungeonAllocs: DungeonAlloc[];
  fishingAlloc: FishingAlloc;
  freeActions: FreeActions;
}

type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

interface ExecutionStep {
  id: string;
  label: string;
  status: StepStatus;
  detail: string;
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

function statusIcon(status: StepStatus): string {
  switch (status) {
    case "pending": return "\u25CB";  // gray circle
    case "running": return "\u25CF";  // filled circle (pulsing via CSS)
    case "done": return "\u2713";     // checkmark
    case "failed": return "\u2717";   // x mark
    case "skipped": return "\u2013";  // dash
  }
}

function statusColor(status: StepStatus): string {
  switch (status) {
    case "pending": return "var(--text-faint)";
    case "running": return "var(--orange)";
    case "done": return "var(--green)";
    case "failed": return "var(--red)";
    case "skipped": return "var(--text-faint)";
  }
}

/* ─── Component ────────────────────────────────────────────── */

export function MissionControlPage({ giga, addLog, handleVote, hasVoted }: MissionControlProps) {
  const gigaRef = useRef(giga);
  gigaRef.current = giga;

  const cancelRef = useRef(false);
  const [executing, setExecuting] = useState(false);
  const [steps, setSteps] = useState<ExecutionStep[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [mcLog, setMcLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const mcLogRef = useRef<HTMLDivElement>(null);

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
  });

  // Initialize dungeon allocs when data arrives
  useEffect(() => {
    if (dungeons.length === 0) return;
    const last = loadLastAlloc();

    // Filter out item-cost dungeons (like Temporal Void) that don't use energy
    const currentEnergy = Math.floor(eng?.energy ?? 0);
    let energyBudget = currentEnergy;

    const allocs = dungeons.filter((d) => d.ENERGY_CID > 0).map((d) => {
      const progressEntry = dayProgress.find((p) => p.ID_CID === `Dungeon#${d.ID_CID}`);
      const runsToday = progressEntry?.UINT256_CID ?? 0;
      const maxRuns = (d.juicedMaxRunsPerDay || 10) - runsToday;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dungeons.length]);

  // Fishing state
  const fs = giga.fishingState;
  const castsToday = fs?.dayDoc?.UINT256_CID ?? 0;
  const maxCasts = fs?.maxPerDay ?? 50;
  const remainingCasts = Math.max(0, maxCasts - castsToday);

  // Recommended cast
  function recommendCast(energy: number, fishState: NonNullable<typeof fs>): string {
    const remaining = Math.max(0, (fishState.maxPerDay ?? 50) - (fishState.dayDoc?.UINT256_CID ?? 0));
    if (remaining <= 0) return "0";
    const bigCasts = Math.min(remaining, Math.floor(energy / (fishState.node2Energy || 20)));
    const normalCasts = Math.min(remaining, Math.floor(energy / (fishState.node1Energy || 16)));
    if (bigCasts >= remaining) return "2";
    if (normalCasts >= remaining) return "1";
    if (bigCasts >= remaining * 0.8) return "2";
    if (normalCasts >= remaining * 0.8) return "1";
    return "0";
  }

  // Allocated energy
  const dungeonEnergy = dungeonAllocs.reduce((s, d) => s + d.runs * d.energyCost, 0);
  const fishingEnergy = fishingAlloc.casts * fishingAlloc.castCost;
  const allocatedEnergy = dungeonEnergy + fishingEnergy;

  // ROM stats
  const roms = giga.roms?.entities ?? [];
  const totalRomE = roms.reduce((s, r) => s + Math.floor(r.factoryStats.energyCollectable), 0);
  const totalRomS = roms.reduce((s, r) => s + Math.floor(r.factoryStats.shardCollectable), 0);
  const totalRomD = roms.reduce((s, r) => s + Math.floor(r.factoryStats.dustCollectable), 0);

  // Recipe cooldowns
  const chestCd = getCooldownInfo(RECIPE_ITEMS.chest, giga.worldRecipes, giga.playerRecipes);
  const juiceChestCd = getCooldownInfo(RECIPE_ITEMS.juiceChest, giga.worldRecipes, giga.playerRecipes);
  const bluePotCd = getCooldownInfo(RECIPE_ITEMS.bluePot, giga.worldRecipes, giga.playerRecipes);
  const tanPotCd = getCooldownInfo(RECIPE_ITEMS.tanPot, giga.worldRecipes, giga.playerRecipes);
  const chestsReady = !chestCd.onCooldown || (!juiceChestCd.onCooldown && (eng?.isPlayerJuiced ?? false));

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

  /* ─── Stepper helpers ────────────────────────────────────── */

  const adjustDungeon = (idx: number, delta: number) => {
    setDungeonAllocs((prev) => {
      const next = [...prev];
      const d = next[idx];
      const newRuns = Math.max(0, Math.min(d.maxRuns, d.runs + delta));
      const energyDelta = (newRuns - d.runs) * d.energyCost;
      if (allocatedEnergy + energyDelta > currentEnergy && delta > 0) return prev;
      next[idx] = { ...d, runs: newRuns };
      return next;
    });
  };

  const adjustFishing = (delta: number) => {
    setFishingAlloc((prev) => {
      const newCasts = Math.max(0, Math.min(remainingCasts, prev.casts + delta));
      const energyDelta = (newCasts - prev.casts) * prev.castCost;
      if (allocatedEnergy + energyDelta > currentEnergy && delta > 0) return prev;
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
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...update } : s)));
  }, []);

  const execute = async () => {
    cancelRef.current = false;
    setExecuting(true);
    setSummary(null);
    setMcLog([]);
    setShowLog(true);
    gigaRef.current.autoBattleRef.current = true;

    const g = () => gigaRef.current;

    // Log to both parent log and local MC log panel
    const log = (msg: string) => {
      addLog(msg);
      setMcLog((prev) => [...prev, `${new Date().toLocaleTimeString("en", { hour12: false })} ${msg}`]);
    };

    // Build step list
    const stepList: ExecutionStep[] = [];
    if (freeActions.claimRomResources && (totalRomS > 0 || totalRomD > 0))
      stepList.push({ id: "claim-roms", label: "Claim ROM shards & dust", status: "pending", detail: `${totalRomS}S / ${totalRomD}D` });
    if (freeActions.romEnergyMode === "convert" && totalRomE > 0)
      stepList.push({ id: "convert-energy", label: "Convert ROM energy to dust", status: "pending", detail: `${totalRomE}E` });
    if (freeActions.romEnergyMode === "claim" && totalRomE > 0)
      stepList.push({ id: "claim-energy", label: "Claim ROM energy", status: "pending", detail: `${totalRomE}E` });
    if (freeActions.openChests && chestsReady)
      stepList.push({ id: "open-chests", label: "Open chests", status: "pending", detail: "" });
    if (freeActions.breakPots && potsActuallyReady)
      stepList.push({ id: "break-pots", label: "Break pots", status: "pending", detail: "" });
    if (freeActions.vote && !hasVoted)
      stepList.push({ id: "vote", label: "Vote on Abstract Portal", status: "pending", detail: "" });

    for (const d of dungeonAllocs) {
      if (d.runs > 0) {
        stepList.push({ id: `dungeon-${d.dungeonId}`, label: `${d.name} x${d.runs}`, status: "pending", detail: `${d.runs * d.energyCost}E` });
      }
    }
    if (fishingAlloc.casts > 0) {
      stepList.push({ id: "fishing", label: `Fishing ${fishingAlloc.castLabel} x${fishingAlloc.casts}`, status: "pending", detail: `${fishingAlloc.casts * fishingAlloc.castCost}E` });
    }
    if (freeActions.sellFish && fishStallInfo.totalCount > 0) {
      stepList.push({ id: "sell-fish", label: `Sell +50% fish`, status: "pending", detail: `${fishStallInfo.totalCount} fish` });
    }

    setSteps(stepList);

    const summaryStats = { dungeonRuns: 0, dungeonWins: 0, fishCasts: 0, fishCaught: 0, seaweedEarned: 0 };

    try {
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
            } catch { /* skip */ }
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
          } catch { /* skip */ }
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
          } catch { /* skip */ }
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
            results.push(r?.success !== false ? "Chest opened" : `Chest: ${(r as { message?: string })?.message || "failed"}`);
            log(results[results.length - 1]);
          } catch (e) { results.push(`Chest: ${e instanceof Error ? e.message : "error"}`); }
          await delay(200);
        }
        if (!juiceChestCd.onCooldown && (g().energy?.entities?.[0]?.parsedData?.isPlayerJuiced ?? false)) {
          try {
            const r = await g().useRecipe(RECIPE_ITEMS.juiceChest);
            results.push(r?.success !== false ? "Juice Chest opened" : `Juice Chest: ${(r as { message?: string })?.message || "failed"}`);
            log(results[results.length - 1]);
          } catch (e) { results.push(`Juice Chest: ${e instanceof Error ? e.message : "error"}`); }
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
            results.push(r?.success !== false ? "Blue Pot broken" : `Blue Pot: ${(r as { message?: string })?.message || "failed"}`);
            log(results[results.length - 1]);
          } catch (e) { results.push(`Blue Pot: ${e instanceof Error ? e.message : "error"}`); }
          await delay(200);
        }
        if (tanPotReady && rockHandsId) {
          try {
            const r = await g().useRecipe(RECIPE_ITEMS.tanPot, rockHandsId);
            results.push(r?.success !== false ? "Tan Pot broken" : `Tan Pot: ${(r as { message?: string })?.message || "failed"}`);
            log(results[results.length - 1]);
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

      // Refresh before energy-consuming steps
      await g().refreshAll();

      // Fetch fresh dungeon state + actionToken before dungeon runs.
      // Free actions above (ROM claims, recipes) rotated the server token.
      const preState = await g().fetchDungeonState();

      // If there's a stuck/active run, play through it (combat + loot)
      if (preState?.data?.run) {
        log(`[MC] found active run (${preState.message}, loot=${preState.data.run.lootPhase}), finishing it...`);
        let s = preState;
        for (let i = 0; i < 150 && s?.data?.run; i++) {
          if (cancelRef.current) break;
          // Run fully complete and no loot pending — done
          if (s.message === "Run Complete" && !s.data.run.lootPhase) break;

          let action = pickBestAction(s, g().enemyMoveRecords, g().enemyNames);
          // If in loot phase but pickBestAction can't see options, default to loot_one
          if (!action && s.data.run.lootPhase) {
            log(`[MC] loot phase with no visible options, picking loot_one`);
            action = "loot_one";
          }
          if (!action) {
            log(`[MC] no action available for stuck run, cannot advance`);
            break;
          }

          const result = await g().performAction(action);
          if (!result) {
            log(`[MC] action failed during stuck run clearing`);
            break;
          }
          s = result;
          await delay(150);
        }
        log(`[MC] active run finished (${s?.message})`);
        await g().fetchDungeonState();
        await delay(500);
      }

      // 6. Dungeon runs
      for (const alloc of dungeonAllocs) {
        if (alloc.runs <= 0) continue;
        const stepId = `dungeon-${alloc.dungeonId}`;
        if (cancelRef.current) { updateStep(stepId, { status: "skipped" }); continue; }
        updateStep(stepId, { status: "running", detail: "starting..." });

        const runResults: string[] = [];
        const lootTotals = new Map<number, number>();

        for (let run = 0; run < alloc.runs; run++) {
          if (cancelRef.current) break;
          updateStep(stepId, { detail: `run ${run + 1}/${alloc.runs}...` });
          log(`[MC] starting ${alloc.name} run ${run + 1}/${alloc.runs}`);

          try {
            const juiced = g().energy?.entities?.[0]?.parsedData?.isPlayerJuiced ?? false;
            log(`[MC] isJuiced=${juiced}`);
            let startResult = await g().startRun(alloc.dungeonId, juiced);

            // If start fails (possibly stuck run), try to clear it and retry
            if (!startResult || startResult.success === false) {
              const errMsg = startResult?.message || g().lastErrorRef.current || "null response";
              log(`[MC] start failed (${errMsg}), checking for stuck run...`);
              const stuckState = await g().fetchDungeonState();
              log(`[MC] dungeon state: run=${!!stuckState?.data?.run}, msg=${stuckState?.message}`);

              if (stuckState?.data?.run) {
                log(`[MC] finishing stuck run (loot=${stuckState.data.run.lootPhase})...`);
                let s = stuckState;
                for (let i = 0; i < 150 && s?.data?.run; i++) {
                  if (cancelRef.current) break;
                  if (s.message === "Run Complete" && !s.data.run.lootPhase) break;
                  let act = pickBestAction(s, g().enemyMoveRecords, g().enemyNames);
                  if (!act && s.data.run.lootPhase) {
                    log(`[MC] loot phase, no visible options — picking loot_one`);
                    act = "loot_one";
                  }
                  if (!act) { log(`[MC] no action for stuck run`); break; }
                  const r = await g().performAction(act);
                  if (!r) break;
                  s = r;
                  await delay(150);
                }
                log(`[MC] stuck run finished (${s?.message})`);
                await g().fetchDungeonState();
                await delay(500);
              }

              // Retry start after clearing
              startResult = await g().startRun(alloc.dungeonId, juiced);
              if (!startResult || startResult.success === false) {
                log(`[MC] still can't start: ${startResult?.message || g().lastErrorRef.current || "unknown"} — skipping dungeon`);
                runResults.push(...Array(alloc.runs - run).fill("err"));
                break; // skip remaining runs for this dungeon
              }
            }

            // Battle loop — track state locally from performAction responses
            let battleState = startResult;
            let complete = false;
            let iterations = 0;
            const MAX_ITERATIONS = 100;

            // Track loot from this run
            const trackLoot = (resp: typeof battleState) => {
              if (resp?.gameItemBalanceChanges) {
                for (const c of resp.gameItemBalanceChanges) {
                  lootTotals.set(c.id, (lootTotals.get(c.id) ?? 0) + c.amount);
                }
              }
            };
            trackLoot(battleState);

            let consecutiveFailures = 0;
            const MAX_CONSECUTIVE_FAILURES = 3;

            while (!complete && iterations < MAX_ITERATIONS) {
              if (cancelRef.current) break;
              iterations++;

              if (!battleState) break;

              if (battleState.message === "Run Complete") {
                complete = true;
                const entity = battleState.data?.entity;
                const room = entity?.ROOM_NUM_CID ?? 0;
                runResults.push(String(room));
                log(`[MC] ${alloc.name} run ${run + 1}: room ${room}`);
                break;
              }

              const action = pickBestAction(battleState, g().enemyMoveRecords, g().enemyNames);
              if (!action) {
                log(`[MC] no action available`);
                break;
              }

              const reason = explainAction(battleState, action, g().enemyMoveRecords, g().enemyNames);
              log(`[MC] ${reason}`);

              const result = await g().performAction(action);
              if (!result) {
                // Action failed — check if the run is actually over (player died, etc.)
                const fresh = await g().fetchDungeonState();
                if (!fresh?.data?.run || fresh.message === "Run Complete") {
                  // Run ended — record result
                  const room = fresh?.data?.entity?.ROOM_NUM_CID ?? 0;
                  runResults.push(String(room));
                  log(`[MC] ${alloc.name} run ${run + 1}: room ${room} (run ended)`);
                  trackLoot(fresh!);
                  complete = true;
                  break;
                }
                // Run still active — retry with fresh state
                consecutiveFailures++;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                  log(`[MC] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, giving up`);
                  break;
                }
                log(`[MC] action failed but run still active, retrying (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})...`);
                battleState = fresh;
                await delay(500);
                continue;
              }
              consecutiveFailures = 0;

              // Update local state from response
              battleState = result;
              trackLoot(result);

              // Record enemy move if in combat
              const enemy = result.data?.run?.players?.[1];
              const entity = result.data?.entity;
              if (enemy?.lastMove && entity && entity.ENEMY_CID >= 0) {
                const totalMaxCharges = 9;
                const curCharges = (["rock", "paper", "scissor"] as const).reduce(
                  (sum, m) => sum + Math.max(0, enemy[m].currentCharges), 0
                );
                const roundEst = Math.max(0, totalMaxCharges - curCharges - 1);
                g().recordEnemyMove(entity.ENEMY_CID, entity.ROOM_NUM_CID, entity.DUNGEON_ID_CID, entity.LEVEL_CID, enemy.lastMove, roundEst);
              }

              if (result.message === "Run Complete") {
                complete = true;
                const ent = result.data?.entity;
                const room = ent?.ROOM_NUM_CID ?? 0;
                runResults.push(String(room));
                log(`[MC] ${alloc.name} run ${run + 1}: room ${room}`);
              }

              await delay(150);
            }
          } catch (e) {
            log(`[MC] error: ${e instanceof Error ? e.message : "unknown"}`);
            runResults.push("err");
          }

          summaryStats.dungeonRuns++;
          if (run < alloc.runs - 1) {
            // Fetch fresh dungeon state to confirm run finalized + get current token
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
        await g().fetchDungeonState();
      }

      // 7. Fishing casts
      if (fishingAlloc.casts > 0 && stepList.find((s) => s.id === "fishing")) {
        const stepId = "fishing";
        if (cancelRef.current) { updateStep(stepId, { status: "skipped" }); }
        else {
          // Refresh token before fishing — use fetchDungeonState which returns the
          // authoritative server token. Do NOT call fetchFishingState here — its
          // GET endpoint returns a stale token that would clobber the fresh one.
          await g().fetchDungeonState();
          updateStep(stepId, { status: "running", detail: "starting..." });
          let caught = 0;
          let escaped = 0;

          for (let cast = 0; cast < fishingAlloc.casts; cast++) {
            if (cancelRef.current) break;
            updateStep(stepId, { detail: `cast ${cast + 1}/${fishingAlloc.casts}...` });
            log(`[MC] fishing cast ${cast + 1}/${fishingAlloc.casts} (${fishingAlloc.castLabel})`);

            try {
              // Start cast — don't fetchFishingState here as it overwrites the
              // shared actionToken with a stale fishing-specific value
              const startResult = await g().fishingAction("start_run", { cards: [], nodeId: fishingAlloc.castNodeId });
              if (!startResult) {
                log(`[MC] fishing cast failed to start: ${g().lastErrorRef.current || "unknown"}`);
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
                    log(`[MC] caught ${fish?.name ?? "fish"} (+${seaweed} seaweed)`);
                  } else {
                    escaped++;
                    log(`[MC] fish escaped`);
                  }
                  break;
                }

                if (gameData.hand.length === 0) {
                  await delay(300);
                  continue;
                }

                const best = pickBestCard(
                  gameData.hand,
                  gameData.deckCardData,
                  gameData.fishPosition,
                  gameData.previousFishPosition,
                  gameData.nextPosition
                );

                const cardResult = await g().fishingAction("play_cards", { cards: [best.handIndex], nodeId: "" });
                if (!cardResult) {
                  log(`[MC] card play failed`);
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
                    log(`[MC] caught ${fish?.name ?? "fish"} (+${seaweed} seaweed)`);
                  } else {
                    escaped++;
                    log(`[MC] fish escaped`);
                  }
                }

                await delay(300);
              }
            } catch (e) {
              log(`[MC] fishing error: ${e instanceof Error ? e.message : "unknown"}`);
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
            detail: `${caught} caught / ${escaped} escaped`,
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
                  log(`[MC] sell failed: ${r?.message || "error"}`);
                  break;
                }
              } catch { break; }
              await delay(150);
            }
          }
          summaryStats.seaweedEarned += totalEarned;
          updateStep("sell-fish", { status: "done", detail: `${totalSold} sold, ${totalEarned} seaweed` });
          log(`[MC] sold ${totalSold} fish for ${totalEarned} seaweed`);
        }
      }

      // Build summary
      const parts: string[] = [];
      if (summaryStats.dungeonRuns > 0) parts.push(`${summaryStats.dungeonRuns} dungeon runs (${summaryStats.dungeonWins}W)`);
      if (summaryStats.fishCasts > 0) parts.push(`${summaryStats.fishCasts} casts, ${summaryStats.fishCaught} fish caught`);
      if (summaryStats.seaweedEarned > 0) parts.push(`${summaryStats.seaweedEarned} seaweed earned`);
      setSummary(cancelRef.current ? `Cancelled. ${parts.join(", ")}` : `Done! ${parts.join(", ")}`);

    } catch (e) {
      if ((e as Error).message !== "cancelled") {
        log(`[MC] execution error: ${e instanceof Error ? e.message : "unknown"}`);
      }
      // Mark remaining steps as skipped
      setSteps((prev) => prev.map((s) => (s.status === "pending" ? { ...s, status: "skipped" as const } : s)));
      setSummary("Execution cancelled.");
    } finally {
      gigaRef.current.autoBattleRef.current = false;
      setExecuting(false);
      await gigaRef.current.refreshAll();
    }
  };

  const handleStop = () => {
    cancelRef.current = true;
    addLog("[MC] stopping...");
  };

  /* ─── Render ─────────────────────────────────────────────── */

  return (
    <div className="anim-in space-y-6" style={{ maxWidth: 720 }}>

      {/* ── Section A: Energy Budget ── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="text-[14px] font-bold">Energy Budget</div>
          <div className="text-[13px] font-bold tabular-nums" style={{ color: "var(--orange)" }}>
            {currentEnergy} / {maxEnergy}
          </div>
        </div>

        {/* Energy bar */}
        <div className="rounded-full overflow-hidden mb-5" style={{ height: 8, background: "var(--bg-inset)" }}>
          <div
            className="h-full rounded-full"
            style={{
              width: `${maxEnergy > 0 ? Math.min(100, (currentEnergy / maxEnergy) * 100) : 0}%`,
              background: "linear-gradient(90deg, #b45309, #e8863a)",
              transition: "width 0.3s ease",
            }}
          />
        </div>

        {/* Dungeon steppers */}
        <div className="space-y-2 mb-4">
          {dungeonAllocs.map((d, idx) => {
            const totalCost = d.runs * d.energyCost;
            const canIncrease = d.runs < d.maxRuns && allocatedEnergy + d.energyCost <= currentEnergy;
            return (
              <div
                key={d.dungeonId}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
                style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold truncate">{d.name}</div>
                  <div className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                    {d.energyCost}E per run &middot; {d.maxRuns} remaining
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    disabled={d.runs <= 0 || executing}
                    onClick={() => adjustDungeon(idx, -1)}
                    className="btn-press w-7 h-7 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[14px] font-bold"
                    style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text)" }}
                  >
                    -
                  </button>
                  <span className="text-[14px] font-bold tabular-nums w-6 text-center">{d.runs}</span>
                  <button
                    disabled={!canIncrease || executing}
                    onClick={() => adjustDungeon(idx, 1)}
                    className="btn-press w-7 h-7 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[14px] font-bold"
                    style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text)" }}
                  >
                    +
                  </button>
                </div>
                {d.runs > 0 && (
                  <span className="text-[11px] tabular-nums font-medium shrink-0" style={{ color: "var(--orange)", minWidth: 56, textAlign: "right" }}>
                    {d.runs} = {totalCost}E
                  </span>
                )}
              </div>
            );
          })}
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
                  className="btn-press text-[10px] font-bold px-2 py-0.5 rounded cursor-pointer disabled:cursor-not-allowed"
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
              className="btn-press w-7 h-7 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[14px] font-bold"
              style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text)" }}
            >
              -
            </button>
            <span className="text-[14px] font-bold tabular-nums w-6 text-center">{fishingAlloc.casts}</span>
            <button
              disabled={fishingAlloc.casts >= remainingCasts || allocatedEnergy + fishingAlloc.castCost > currentEnergy || executing}
              onClick={() => adjustFishing(1)}
              className="btn-press w-7 h-7 rounded flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-[14px] font-bold"
              style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text)" }}
            >
              +
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
            <span className="text-[13px] font-bold tabular-nums" style={{ color: allocatedEnergy > currentEnergy ? "var(--red)" : "var(--orange)" }}>
              {allocatedEnergy}E / {currentEnergy}E
            </span>
          </div>
          <div className="rounded-full overflow-hidden" style={{ height: 6, background: "var(--bg)" }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${currentEnergy > 0 ? Math.min(100, (allocatedEnergy / currentEnergy) * 100) : 0}%`,
                background: allocatedEnergy > currentEnergy
                  ? "var(--red)"
                  : "linear-gradient(90deg, #b45309, #e8863a)",
                transition: "width 0.3s ease",
              }}
            />
          </div>
        </div>
      </section>

      {/* ── Section B: Free Actions ── */}
      <section>
        <div className="text-[14px] font-bold mb-3">Free Actions</div>
        <div className="space-y-1.5">
          {/* ROM Resources (shards + dust) */}
          <label className="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", opacity: (totalRomS === 0 && totalRomD === 0) ? 0.5 : 1 }}>
            <input type="checkbox" checked={freeActions.claimRomResources} disabled={(totalRomS === 0 && totalRomD === 0) || executing} onChange={(e) => setFreeActions((prev) => ({ ...prev, claimRomResources: e.target.checked }))} className="accent-[var(--orange)]" style={{ width: 16, height: 16 }} />
            <div className="flex-1 text-[12px] font-semibold">Claim ROM shards & dust</div>
            <span className="text-[11px] tabular-nums" style={{ color: "var(--text-dim)" }}>{totalRomS}S / {totalRomD}D</span>
          </label>

          {/* ROM Energy — radio group: claim / convert / skip */}
          <div className="px-3 py-2 rounded-lg" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", opacity: totalRomE === 0 ? 0.5 : 1 }}>
            <div className="text-[12px] font-semibold mb-1.5">ROM Energy ({totalRomE}E available)</div>
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
            { key: "openChests" as const, label: "Open chests", info: chestsReady ? [!chestCd.onCooldown && "Chest ready", !juiceChestCd.onCooldown && (eng?.isPlayerJuiced ?? false) && "Juice ready"].filter(Boolean).join(" + ") || "Ready" : `Chest: ${chestCd.text}${(eng?.isPlayerJuiced ?? false) ? `, Juice: ${juiceChestCd.text}` : ""}`, disabled: !chestsReady },
            { key: "breakPots" as const, label: "Break pots", info: (() => { const p: string[] = []; if (!bluePotCd.onCooldown && paperHandsId) p.push("Blue ready"); else if (!bluePotCd.onCooldown) p.push("Blue: no Paper Hands"); else p.push(`Blue: ${bluePotCd.text}`); if (!tanPotCd.onCooldown && rockHandsId) p.push("Tan ready"); else if (!tanPotCd.onCooldown) p.push("Tan: no Rock Hands"); else p.push(`Tan: ${tanPotCd.text}`); return p.join(", "); })(), disabled: !potsActuallyReady },
            { key: "sellFish" as const, label: "Sell +50% fish", info: fishStallInfo.totalCount > 0 ? `${fishStallInfo.totalCount} fish (~${fishStallInfo.totalSeaweed} seaweed)` : "None available", disabled: fishStallInfo.totalCount === 0 },
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

      {/* ── Section C: Presets ── */}
      <section>
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
              style={{ background: "var(--orange)", border: "none", color: "#fff" }}
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
                  onClick={() => deletePreset(p.name)}
                  disabled={executing}
                  className="btn-press text-[11px] px-1.5 py-1.5 rounded-r-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", color: "var(--text-faint)" }}
                >
                  x
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

      {/* ── Section D: Execute Button + Progress ── */}
      <section>
        {!executing ? (
          <button
            onClick={execute}
            disabled={
              executing ||
              allocatedEnergy > currentEnergy ||
              (allocatedEnergy === 0 &&
                !freeActions.claimRomResources &&
                freeActions.romEnergyMode === "skip" &&
                !freeActions.openChests &&
                !freeActions.breakPots &&
                !freeActions.sellFish &&
                !freeActions.vote)
            }
            className="btn-press w-full text-[16px] font-bold py-4 rounded-xl cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: "linear-gradient(135deg, var(--orange), var(--orange-dim))",
              border: "none",
              color: "#fff",
              boxShadow: "0 3px 16px var(--orange-glow)",
              letterSpacing: "0.02em",
            }}
          >
            Execute Daily Plan
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="btn-press w-full text-[16px] font-bold py-4 rounded-xl cursor-pointer"
            style={{
              background: "linear-gradient(135deg, var(--red), #7f1d1d)",
              border: "none",
              color: "#fff",
              boxShadow: "0 3px 16px rgba(239,68,68,0.25)",
              letterSpacing: "0.02em",
            }}
          >
            Stop Execution
          </button>
        )}

        {/* Progress tracker */}
        {steps.length > 0 && (
          <div className="mt-4 rounded-lg overflow-hidden" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}>
            <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
              <span className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--text-faint)" }}>
                Progress
              </span>
            </div>
            <div className="divide-y" style={{ borderColor: "var(--border)" }}>
              {steps.map((step) => (
                <div
                  key={step.id}
                  className="flex items-center gap-3 px-4 py-2.5"
                  style={{ borderColor: "var(--border)" }}
                >
                  <span
                    className="text-[14px] font-bold shrink-0 w-5 text-center"
                    style={{
                      color: statusColor(step.status),
                      animation: step.status === "running" ? "pulse 1.5s ease-in-out infinite" : "none",
                    }}
                  >
                    {statusIcon(step.status)}
                  </span>
                  <span
                    className="text-[12px] font-medium flex-1 min-w-0 truncate"
                    style={{ color: step.status === "pending" ? "var(--text-faint)" : "var(--text)" }}
                  >
                    {step.label}
                  </span>
                  <span className="text-[11px] tabular-nums shrink-0" style={{ color: "var(--text-faint)" }}>
                    {step.detail}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Activity Log */}
        {mcLog.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setShowLog((v) => !v)}
              className="text-[11px] font-bold uppercase tracking-[0.1em] mb-2 cursor-pointer"
              style={{ color: "var(--text-faint)", background: "none", border: "none", padding: 0 }}
            >
              {showLog ? "Hide" : "Show"} Log ({mcLog.length})
            </button>
            {showLog && (
              <div
                ref={mcLogRef}
                className="rounded-lg overflow-y-auto"
                style={{
                  maxHeight: 200,
                  background: "var(--bg-inset)",
                  border: "1px solid var(--border)",
                  padding: "8px 12px",
                  fontSize: 11,
                  fontFamily: "monospace",
                  lineHeight: 1.6,
                }}
              >
                {mcLog.map((entry, i) => (
                  <div key={i} style={{ color: "var(--text-faint)" }}>{entry}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Summary */}
        {summary && (
          <div
            className="mt-3 px-4 py-3 rounded-lg text-[13px] font-medium"
            style={{
              background: summary.startsWith("Done") ? "var(--green-glow)" : "var(--bg-raised)",
              border: `1px solid ${summary.startsWith("Done") ? "rgba(74,222,128,0.25)" : "var(--border)"}`,
              color: summary.startsWith("Done") ? "var(--green)" : "var(--text)",
            }}
          >
            {summary}
          </div>
        )}
      </section>
    </div>
  );
}
