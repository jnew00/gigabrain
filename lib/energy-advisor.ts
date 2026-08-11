// Energy-spend advisor: turns current energy, daily caps, and run history
// into a recommended allocation with human-readable reasoning.
//
// Core principles (from docs.gigaverse.io, Aug 2026):
// - Daily run/cast caps are use-it-or-lose-it; energy regens continuously
//   (10/hr, 17.5/hr juiced) but is WASTED while sitting at the cap.
// - Bigger fishing casts give better fish for the same capped cast count.
// - Gigus (200E) is the only source of Gigus materials but is brutal —
//   only worth it when you clear deep rooms reliably.

import { findDungeonInfo, isAwakeningActive, AWAKENING, FISHING } from "./game-data";

export interface AdvisorDungeon {
  dungeonId: number;
  name: string;
  energyCost: number;
  /** Runs still available today (cap minus runs done) */
  runsLeft: number;
  /** Win rate 0-1 from run history, null when no data */
  winRate: number | null;
  /** Average rooms cleared (out of 16), null when no data */
  avgRooms: number | null;
  totalRuns: number;
  /** Drops Hard Cores — funded before permanent currencies during the event */
  eventPriority?: boolean;
}

export interface AdvisorInput {
  currentEnergy: number;
  maxEnergy: number;
  regenPerHour: number;
  isJuiced: boolean;
  /** Claimable energy sitting on ROMs */
  romEnergyAvailable: number;
  dungeons: AdvisorDungeon[];
  fishingCastsLeft: number;
  /**
   * The Dendren Grove pond, when the event is running. The Grove draws from
   * the same daily cast pool as the classic ponds, so this is not an extra
   * budget — supplying it means those casts go to the Grove instead.
   */
  eventFishingNode?: { nodeId: string; label: string; cost: number };
  /** Unix seconds, injectable so the event window can be tested */
  now?: number;
}

export interface AdvisorResult {
  dungeonRuns: { dungeonId: number; runs: number }[];
  fishing: { nodeId: string; casts: number };
  /** Grove casts, when the caller supplied a pond to plan for */
  eventFishing?: { nodeId: string; casts: number };
  /** Advisor thinks ROM energy should be claimed into the pool (not dusted) */
  claimRomEnergy: boolean;
  notes: string[];
  warnings: string[];
  totalSpend: number;
  leftover: number;
}

/** Depth score 0-1: how much of the dungeon this player typically clears */
function depthScore(d: AdvisorDungeon): number {
  if (d.avgRooms == null || d.totalRuns < 3) return 0.5; // unknown — assume mid
  return Math.max(0.1, Math.min(1, d.avgRooms / 16));
}

export function buildRecommendation(input: AdvisorInput): AdvisorResult {
  const notes: string[] = [];
  const warnings: string[] = [];
  const dungeonRuns: { dungeonId: number; runs: number }[] = [];

  let budget = input.currentEnergy;
  let claimRomEnergy = false;

  // ── Regen waste check ──
  if (input.maxEnergy > 0 && input.currentEnergy >= input.maxEnergy * 0.9) {
    warnings.push(
      `Energy is at ${Math.round((input.currentEnergy / input.maxEnergy) * 100)}% of cap — regen (${input.regenPerHour}/hr) is being wasted. Spend now.`
    );
  }

  // ── What would it cost to fill every daily cap? ──
  const fishNodes = FISHING.nodes;
  const eventNode = input.eventFishingNode;
  // Casts are a single shared pool, so the cap costs whatever node they land on
  const castCost = eventNode ? eventNode.cost : fishNodes[2].cost;
  const capCost =
    input.fishingCastsLeft * castCost +
    input.dungeons
      .filter((d) => d.energyCost > 0)
      .reduce((s, d) => s + d.runsLeft * d.energyCost, 0);

  // ── ROM energy: claim it if we can't otherwise fill the cheap caps ──
  // Only what fits under the cap can actually land in the pool. Budgeting the
  // full ROM balance while the pool is near max plans a run that can't be paid
  // for, and the shortfall lands on whatever executes last.
  const headroom = Math.max(0, input.maxEnergy - input.currentEnergy);
  let claimedRomEnergy = 0;
  if (input.romEnergyAvailable > 0 && budget < capCost) {
    claimedRomEnergy = Math.min(input.romEnergyAvailable, headroom);
    if (claimedRomEnergy > 0) {
      claimRomEnergy = true;
      budget += claimedRomEnergy;
      const spare = Math.floor(input.romEnergyAvailable - claimedRomEnergy);
      notes.push(
        `Claim ${Math.floor(claimedRomEnergy)}E from ROMs as energy (not dust) — you have more daily caps than energy today.` +
          (spare > 0
            ? ` The other ${spare}E won't fit under the ${input.maxEnergy}E cap; spend some energy first, then claim again.`
            : "")
      );
    } else if (input.romEnergyAvailable > 0) {
      notes.push(
        `${Math.floor(input.romEnergyAvailable)}E is sitting on ROMs but your pool is full — spend energy first or it can't be claimed.`
      );
    }
  }

  // ── 1. The Awakening: Hard Cores first while the window is open ──
  // Scrap and Giga Shards are farmable forever; Hard Cores stop existing on
  // the event's end date and pay out of a real prize pot. So for the duration
  // every Core-yielding action outranks the permanent grind, and event
  // dungeons are exempt from the depth ranking below (a dungeon nobody has
  // run yet always loses that comparison to one with history).
  const eventActive = isAwakeningActive(input.now);
  const eventDungeons = eventActive
    ? input.dungeons.filter((d) => d.eventPriority && d.runsLeft > 0)
    : [];
  let eventFishing: { nodeId: string; casts: number } | undefined;
  const groveActive = eventActive && !!eventNode && input.fishingCastsLeft > 0;

  if (eventActive && (eventDungeons.length > 0 || groveActive)) {
    notes.push(
      `${AWAKENING.name} is live — Hard Cores are funded before scrap and shards because they expire when the event ends.` +
        (input.isJuiced
          ? " Juice is active, so every Core counts 4x."
          : " Without Juice you earn 1x Cores; juiced players earn 4x for the same energy.")
    );
  }

  if (groveActive && eventNode) {
    // Every cast goes to the Grove during the event. It shares the daily cast
    // pool with the classic ponds, and at 12E it is both the cheapest node and
    // the only one paying a currency that expires — so there is nothing to
    // trade off. Seaweed keeps; Cores don't.
    const casts = Math.min(input.fishingCastsLeft, Math.floor(budget / eventNode.cost));
    if (casts > 0) {
      eventFishing = { nodeId: eventNode.nodeId, casts };
      budget -= casts * eventNode.cost;
      notes.push(
        `Dendren Grove: ${casts}x ${eventNode.label} cast (${eventNode.cost}E) for Hard Cores — the classic ponds share this cast pool and are skipped while the event runs.` +
          (casts < input.fishingCastsLeft
            ? ` ${input.fishingCastsLeft - casts} casts left unfunded.`
            : "")
      );
    } else {
      warnings.push(
        `${input.fishingCastsLeft} casts are available but there isn't ${eventNode.cost}E for even one Grove cast.`
      );
    }
  }

  // Cheapest first so the most Core-yielding runs get funded
  for (const d of [...eventDungeons].sort((a, b) => a.energyCost - b.energyCost)) {
    if (d.energyCost <= 0) {
      notes.push(`${d.name}: item entry, no energy — run it from the Dungeon tab, it costs the plan nothing.`);
      continue;
    }
    const runs = Math.min(d.runsLeft, Math.floor(budget / d.energyCost));
    if (runs <= 0) {
      warnings.push(
        `${d.name} drops Hard Cores and has ${d.runsLeft} runs left, but there isn't ${d.energyCost}E for a run. This is the spend that expires — consider skipping a regular dungeon.`
      );
      continue;
    }
    dungeonRuns.push({ dungeonId: d.dungeonId, runs });
    budget -= runs * d.energyCost;
    notes.push(
      `${d.name}: ${runs}x run for Hard Cores — funded ahead of scrap and shards.` +
        (runs < d.runsLeft ? ` ${d.runsLeft - runs} capped runs left unfunded.` : "")
    );
  }

  // ── 2. Fishing: cheapest capped action, fill first ──
  // Pick the biggest cast size the budget supports across ALL remaining casts;
  // the cast cap binds before energy does, so maximize reward per cast.
  let fishing = { nodeId: "0", casts: 0 };
  if (input.fishingCastsLeft > 0 && !eventFishing) {
    // Reserve nothing yet — fishing gets first claim, then dungeons
    const node =
      [...fishNodes].reverse().find((n) => n.cost * input.fishingCastsLeft <= budget * 0.6) ??
      fishNodes[0];
    const casts = Math.min(input.fishingCastsLeft, Math.floor(budget / node.cost));
    if (casts > 0) {
      fishing = { nodeId: node.nodeId, casts };
      budget -= casts * node.cost;
      notes.push(
        `Fishing: ${casts}x ${node.label} cast (${node.cost}E). Casts expire daily — ${
          node.nodeId === "2"
            ? "Big casts give the best fish per capped cast."
            : "bigger casts were skipped to leave energy for dungeon runs."
        }`
      );
    }
  }

  // ── 3. Dungeons: rank by performance-adjusted value per energy ──
  const alreadyPlanned = new Set(dungeonRuns.map((r) => r.dungeonId));
  const standard = input.dungeons.filter(
    (d) =>
      d.energyCost > 0 &&
      d.runsLeft > 0 &&
      !findDungeonInfo(d.name)?.eventOnly &&
      !alreadyPlanned.has(d.dungeonId) &&
      !(eventActive && d.eventPriority)
  );
  const gigusLike = standard.filter((d) => findDungeonInfo(d.name)?.exclusiveSource);
  const regular = standard.filter((d) => !findDungeonInfo(d.name)?.exclusiveSource);

  // Regular dungeons (Normal, Underhaul): depth per energy, ties → win rate
  regular.sort((a, b) => {
    const sa = depthScore(a) / a.energyCost;
    const sb = depthScore(b) / b.energyCost;
    if (Math.abs(sa - sb) > 1e-6) return sb - sa;
    return (b.winRate ?? 0.5) - (a.winRate ?? 0.5);
  });

  for (const d of regular) {
    const runs = Math.min(d.runsLeft, Math.floor(budget / d.energyCost));
    if (runs <= 0) {
      notes.push(
        `${d.name}: skipped — ${d.runsLeft} runs still capped today but no energy left for its ${d.energyCost}E cost.`
      );
      continue;
    }
    dungeonRuns.push({ dungeonId: d.dungeonId, runs });
    budget -= runs * d.energyCost;
    const info = findDungeonInfo(d.name);
    const perf =
      d.totalRuns >= 3 && d.avgRooms != null
        ? ` (you average room ${d.avgRooms.toFixed(1)}/16${d.winRate != null ? `, ${Math.round(d.winRate * 100)}% wins` : ""})`
        : "";
    notes.push(
      `${d.name}: ${runs}x run for ${info?.currency ?? "rewards"}${perf}.${
        runs < d.runsLeft ? ` ${d.runsLeft - runs} capped runs left unfunded.` : ""
      }`
    );
  }

  // Gigus: only when cheaper caps are handled and the player clears deep
  for (const d of gigusLike) {
    const readyForGigus =
      d.totalRuns < 3 || (d.avgRooms ?? 0) >= 10 || (d.winRate ?? 0) >= 0.5;
    // Also gate on overall dungeon skill from regular history
    const bestRegular = regular.reduce<AdvisorDungeon | null>(
      (best, r) => (best == null || (r.avgRooms ?? 0) > (best.avgRooms ?? 0) ? r : best),
      null
    );
    const provenDeep =
      bestRegular != null && bestRegular.totalRuns >= 3 && (bestRegular.avgRooms ?? 0) >= 10;

    const runs = Math.min(d.runsLeft, Math.floor(budget / d.energyCost));
    if (runs <= 0) {
      if (budget < d.energyCost && d.runsLeft > 0) {
        notes.push(
          `${d.name}: skipped — needs ${d.energyCost}E/run, only ${Math.floor(budget)}E left after cheaper caps.`
        );
      }
      continue;
    }
    if (!readyForGigus || (d.totalRuns < 3 && !provenDeep)) {
      warnings.push(
        `${d.name} costs ${d.energyCost}E/run and drops no scrap — it's the only Gigus-material source, but your history doesn't show deep clears yet. Build depth in cheaper dungeons first.`
      );
      continue;
    }
    dungeonRuns.push({ dungeonId: d.dungeonId, runs });
    budget -= runs * d.energyCost;
    notes.push(
      `${d.name}: ${runs}x run — only source of Gigus materials, and your clear depth supports the ${d.energyCost}E cost.`
    );
  }

  // ── Leftover guidance ──
  const totalSpend = input.currentEnergy + claimedRomEnergy - budget;
  if (budget >= 40) {
    const anyCapLeft =
      input.dungeons.some(
        (d) =>
          d.energyCost > 0 &&
          d.runsLeft > (dungeonRuns.find((r) => r.dungeonId === d.dungeonId)?.runs ?? 0)
      ) ||
      // One shared cast pool, so whichever pond claimed it answers for it
      (fishing.casts + (eventFishing?.casts ?? 0)) < input.fishingCastsLeft;
    if (!anyCapLeft) {
      notes.push(
        `${Math.floor(budget)}E left with all daily caps filled — it banks toward tomorrow as long as you stay under the ${input.maxEnergy}E cap.`
      );
    }
  }

  return {
    dungeonRuns,
    fishing,
    eventFishing,
    claimRomEnergy,
    notes,
    warnings,
    totalSpend,
    leftover: Math.floor(budget),
  };
}
