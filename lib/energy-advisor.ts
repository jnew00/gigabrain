// Energy-spend advisor: turns current energy, daily caps, and run history
// into a recommended allocation with human-readable reasoning.
//
// Core principles (from docs.gigaverse.io, Aug 2026):
// - Daily run/cast caps are use-it-or-lose-it; energy regens continuously
//   (10/hr, 17.5/hr juiced) but is WASTED while sitting at the cap.
// - Bigger fishing casts give better fish for the same capped cast count.
// - Gigus (200E) is the only source of Gigus materials but is brutal —
//   only worth it when you clear deep rooms reliably.
//
// Casts are ONE pool shared by every pond. The advisor therefore allocates
// casts, then decides which pond each one is spent in — it never treats a pond
// as having an allowance of its own.

import { findDungeonInfo, isAwakeningActive, AWAKENING } from "./game-data";

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
  /**
   * Hard Cores per run, averaged over recorded runs. Null when never measured.
   * This is what decides whether the dungeon or the pond gets the energy.
   */
  coresPerRun?: number | null;
}

export interface AdvisorPond {
  pondId: number;
  name: string;
  /** Cast nodes on this pond, any order */
  nodes: { nodeId: string; label: string; cost: number }[];
  /** Pays the expiring event currency, so it competes for the same energy */
  eventPriority?: boolean;
  /** Hard Cores per cast, averaged over recorded casts. Null when unmeasured. */
  coresPerCast?: number | null;
}

export interface AdvisorInput {
  currentEnergy: number;
  maxEnergy: number;
  regenPerHour: number;
  isJuiced: boolean;
  /** Claimable energy sitting on ROMs */
  romEnergyAvailable: number;
  dungeons: AdvisorDungeon[];
  /**
   * Casts left in the single shared daily pool, across all ponds together.
   */
  fishingCastsLeft: number;
  /** Every pond castable right now. Order does not matter. */
  ponds: AdvisorPond[];
  /** Unix seconds, injectable so the event window can be tested */
  now?: number;
}

/** One pond's share of the shared cast pool. */
export interface AdvisorCastPlan {
  pondId: number;
  nodeId: string;
  casts: number;
}

export interface AdvisorResult {
  dungeonRuns: { dungeonId: number; runs: number }[];
  /**
   * Casts to spend, per pond. A list rather than one node because the pool is
   * shared: "6 Grove casts and 4 Big classic casts" is a thing the plan has to
   * be able to say, and a single {nodeId, casts} could not say it.
   */
  fishing: AdvisorCastPlan[];
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

/**
 * A candidate for event energy: either a dungeon run or a pond cast.
 *
 * Both yield Hard Cores and both are paid for in energy, so they are ranked
 * against each other on one number — Cores per energy — rather than by a rule
 * about which kind of activity comes first.
 */
interface EventSpend {
  kind: "dungeon" | "pond";
  id: number;
  name: string;
  energyPerUnit: number;
  unitsLeft: number;
  coresPerUnit: number | null;
  nodeId?: string;
  nodeLabel?: string;
}

function coresPerEnergy(s: EventSpend): number | null {
  if (s.coresPerUnit == null || s.energyPerUnit <= 0) return null;
  return s.coresPerUnit / s.energyPerUnit;
}

/**
 * Rank event spends by measured yield, cheapest-first among the unmeasured.
 *
 * Measured always outranks unmeasured. That is deliberately not the same as
 * "measured is better": it means the advisor spends where it can justify the
 * spend, and says out loud that the rest is unranked. Guessing an order between
 * two unmeasured sources and presenting it as advice is the thing to avoid.
 */
function rankEventSpends(spends: EventSpend[]): EventSpend[] {
  const measured = spends.filter((s) => coresPerEnergy(s) != null);
  const unmeasured = spends.filter((s) => coresPerEnergy(s) == null);
  measured.sort((a, b) => (coresPerEnergy(b) ?? 0) - (coresPerEnergy(a) ?? 0));
  unmeasured.sort((a, b) => a.energyPerUnit - b.energyPerUnit);
  return [...measured, ...unmeasured];
}

function rate(s: EventSpend): string {
  const r = coresPerEnergy(s);
  return r == null
    ? "yield never measured"
    : `${r.toFixed(1)} Cores/E measured`;
}

export function buildRecommendation(input: AdvisorInput): AdvisorResult {
  const notes: string[] = [];
  const warnings: string[] = [];
  const dungeonRuns: { dungeonId: number; runs: number }[] = [];
  const fishing: AdvisorCastPlan[] = [];

  let budget = input.currentEnergy;
  let castsLeft = input.fishingCastsLeft;
  let claimRomEnergy = false;

  const ponds = input.ponds ?? [];
  const cheapestNode = (p: AdvisorPond) =>
    [...p.nodes].sort((a, b) => a.cost - b.cost)[0];
  const cheapestCastCost = ponds.length
    ? Math.min(...ponds.map((p) => cheapestNode(p)?.cost ?? Infinity))
    : 0;

  // ── Regen waste check ──
  if (input.maxEnergy > 0 && input.currentEnergy >= input.maxEnergy * 0.9) {
    warnings.push(
      `Energy is at ${Math.round((input.currentEnergy / input.maxEnergy) * 100)}% of cap — regen (${input.regenPerHour}/hr) is being wasted. Spend now.`
    );
  }

  // ── What would it cost to fill every daily cap? ──
  // Casts are one pool, so their cost is the pool size times whatever node they
  // end up on. The cheapest node across all ponds is the floor on that.
  const capCost =
    castsLeft * (Number.isFinite(cheapestCastCost) ? cheapestCastCost : 0) +
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
  // Scrap and Giga Shards are farmable forever; Hard Cores stop existing on the
  // event's end date and pay out of a real prize pot. So for the duration every
  // Core-yielding action outranks the permanent grind, and event dungeons are
  // exempt from the depth ranking below (a dungeon nobody has run yet always
  // loses that comparison to one with history).
  const eventActive = isAwakeningActive(input.now);
  const eventDungeons = eventActive
    ? input.dungeons.filter((d) => d.eventPriority && d.runsLeft > 0)
    : [];
  const eventPonds = eventActive ? ponds.filter((p) => p.eventPriority) : [];

  if (eventActive && (eventDungeons.length > 0 || eventPonds.length > 0)) {
    notes.push(
      `${AWAKENING.name} is live — Hard Cores are funded before scrap and shards because they expire when the event ends.` +
        (input.isJuiced
          ? " Juice is active, so every Core counts 4x."
          : " Without Juice you earn 1x Cores; juiced players earn 4x for the same energy.")
    );
  }

  const eventSpends: EventSpend[] = [
    ...eventDungeons.map<EventSpend>((d) => ({
      kind: "dungeon",
      id: d.dungeonId,
      name: d.name,
      energyPerUnit: d.energyCost,
      unitsLeft: d.runsLeft,
      coresPerUnit: d.coresPerRun ?? null,
    })),
    ...eventPonds.flatMap<EventSpend>((p) => {
      const node = cheapestNode(p);
      if (!node) return [];
      return [
        {
          kind: "pond",
          id: p.pondId,
          name: p.name,
          energyPerUnit: node.cost,
          unitsLeft: castsLeft,
          coresPerUnit: p.coresPerCast ?? null,
          nodeId: node.nodeId,
          nodeLabel: node.label,
        },
      ];
    }),
  ];

  const ranked = rankEventSpends(eventSpends);
  const unmeasured = ranked.filter((s) => coresPerEnergy(s) == null);
  if (ranked.length > 1 && unmeasured.length > 0) {
    notes.push(
      unmeasured.length === ranked.length
        ? `No Core yields have been recorded yet, so the event spends below are ordered by cost, not by return. Run a few and the order will be measured instead.`
        : `${unmeasured.map((s) => s.name).join(" and ")} ${unmeasured.length === 1 ? "has" : "have"} no recorded Core yield, so ${unmeasured.length === 1 ? "it is" : "they are"} funded after the sources that do. That ordering is a placeholder until it's measured, not a judgement.`
    );
  }

  /**
   * Units of an unmeasured event source held back from a measured one.
   *
   * Without this the ranking eats itself: an unmeasured source is funded last,
   * a measured source spends the whole budget first, so the unmeasured one
   * never gets a single unit, never gets measured, and is funded last again
   * tomorrow. The note above calls the ordering "a placeholder until it's
   * measured" — a placeholder that nothing can ever lift is just a permanent
   * demotion dressed up as a temporary one.
   *
   * Three units, because one is noise. It is a probe, not a hedge: the point is
   * to learn the rate, and the cost of learning it is bounded and paid once.
   */
  const PROBE_UNITS = 3;

  const unitsAvailable = (s: EventSpend) =>
    s.kind === "pond" ? Math.min(s.unitsLeft, castsLeft) : s.unitsLeft;

  // Only worth reserving when something measured would otherwise take it all.
  let probeReserve = ranked.some((s) => coresPerEnergy(s) != null)
    ? ranked.reduce(
        (sum, s) =>
          coresPerEnergy(s) == null && s.energyPerUnit > 0
            ? sum + Math.min(PROBE_UNITS, unitsAvailable(s)) * s.energyPerUnit
            : sum,
        0
      )
    : 0;
  if (probeReserve > 0) {
    notes.push(
      `Holding ${probeReserve}E back so the unmeasured source above gets a few units — otherwise it never earns a rate and stays last forever.`
    );
  }

  for (const spend of ranked) {
    if (spend.energyPerUnit <= 0) {
      notes.push(
        `${spend.name}: item entry, no energy — run it from the Dungeon tab, it costs the plan nothing.`
      );
      continue;
    }
    // A pond's units are the shared pool as it stands now, not as it stood when
    // the list was built — an earlier pond may already have taken from it.
    const available = unitsAvailable(spend);
    const measured = coresPerEnergy(spend) != null;
    // A measured source spends everything except the probe; an unmeasured one
    // is what the probe was being held for, so it draws on the full budget.
    if (!measured) {
      probeReserve = Math.max(
        0,
        probeReserve - Math.min(PROBE_UNITS, available) * spend.energyPerUnit
      );
    }
    const spendable = measured ? Math.max(0, budget - probeReserve) : budget;
    const units = Math.min(available, Math.floor(spendable / spend.energyPerUnit));

    if (units <= 0) {
      if (available <= 0) continue;
      warnings.push(
        spend.kind === "dungeon"
          ? `${spend.name} drops Hard Cores and has ${available} runs left, but there isn't ${spend.energyPerUnit}E for a run. This is the spend that expires — consider skipping a regular dungeon.`
          : `${available} casts are available but there isn't ${spend.energyPerUnit}E for even one ${spend.name} cast.`
      );
      continue;
    }

    budget -= units * spend.energyPerUnit;
    const shortfall =
      units < available ? ` ${available - units} left unfunded.` : "";

    if (spend.kind === "dungeon") {
      dungeonRuns.push({ dungeonId: spend.id, runs: units });
      notes.push(
        `${spend.name}: ${units}x run for Hard Cores (${rate(spend)}) — funded ahead of scrap and shards.${shortfall}`
      );
    } else {
      castsLeft -= units;
      fishing.push({ pondId: spend.id, nodeId: spend.nodeId!, casts: units });
      notes.push(
        `${spend.name}: ${units}x ${spend.nodeLabel} cast (${spend.energyPerUnit}E, ${rate(spend)}) for Hard Cores. Casts are one shared pool — ${castsLeft} left for other ponds.${shortfall}`
      );
    }
  }

  // ── 2. Fishing: whatever casts the event didn't claim ──
  // The cast cap binds before energy does, so spend the remaining pool on the
  // biggest node the budget supports.
  const plainPonds = ponds.filter((p) => !(eventActive && p.eventPriority));
  for (const pond of plainPonds) {
    if (castsLeft <= 0) break;
    const byCost = [...pond.nodes].sort((a, b) => a.cost - b.cost);
    if (!byCost.length) continue;
    // Reserve nothing yet — fishing gets first claim, then dungeons
    const node =
      [...byCost].reverse().find((n) => n.cost * castsLeft <= budget * 0.6) ?? byCost[0];
    const casts = Math.min(castsLeft, Math.floor(budget / node.cost));
    if (casts <= 0) continue;
    fishing.push({ pondId: pond.pondId, nodeId: node.nodeId, casts });
    budget -= casts * node.cost;
    castsLeft -= casts;
    const biggest = byCost[byCost.length - 1];
    notes.push(
      `${pond.name}: ${casts}x ${node.label} cast (${node.cost}E). Casts expire daily — ${
        node.nodeId === biggest.nodeId
          ? `${node.label} casts give the best fish per capped cast.`
          : "bigger casts were skipped to leave energy for dungeon runs."
      }`
    );
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
      ) || castsLeft > 0;
    if (!anyCapLeft) {
      notes.push(
        `${Math.floor(budget)}E left with all daily caps filled — it banks toward tomorrow as long as you stay under the ${input.maxEnergy}E cap.`
      );
    }
  }

  return {
    dungeonRuns,
    fishing,
    claimRomEnergy,
    notes,
    warnings,
    totalSpend,
    leftover: Math.floor(budget),
  };
}
