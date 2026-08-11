// Skill-upgrade advisor: turns skill trees + progress + currency into an
// ordered upgrade queue with reasons, plus a respec flag when the current
// allocation fights the build.
//
// Build philosophy (tuned to the auto-battler, cross-checked against
// community guidance — games.gg Gigaverse guide, Aug 2026):
//
// Combat: the auto-battler ranks moves by ATK*2+DEF and leads with its
// highest-ATK move, so stacking ONE attack stat (Sword) compounds: it
// one-shots early rooms, ends fights faster, and takes fewer hits. Max Armor
// to 4 makes Shield's +4 armor land fully; Max HP absorbs floor-2 spikes.
// DEF stats are last — the bot wins by killing faster, not out-trading.
//
// Fishing: Fintuition reveals the fish's next cell — the card AI hits
// near-100% when it fires, so it's the single biggest catch-rate lever.
// Stamina = more plays per cast. Weed Dealer compounds sale income into
// further upgrades. Bait/crit skills are last.
//
// There is now more than one fishing tree, and they are NOT the same tree with
// a different name. Verified against /api/offchain/skills on 2026-08-11:
// "Fishing Skills" (currency 333, max level 100) and "Dendren Fishing"
// (currency 935, max level 80) carry identical stat names, but Fintuition pays
// 2.5%/upgrade in the first and 1.5% in the second, and the XP curves are not
// remotely comparable — level 5 costs 161 in one and 8 in the other. A ladder
// written as "Fintuition to 5" therefore means two completely different things
// depending on which tree it lands on. So the fishing ladder is built per tree
// from that tree's own published rates.

import type { SkillTree, SkillProgressEntity, SkillStat } from "./types";
import { pondForCurrencyItem, type PondDef } from "./ponds";

export interface SkillUpgradeRec {
  skillId: number;
  statId: number;
  treeName: string;
  statName: string;
  fromLevel: number;
  cost: number;
  currencyItemId: number;
  reason: string;
}

export interface RespecFlag {
  treeName: string;
  note: string;
}

export interface SkillAdvice {
  /** Affordable upgrades in priority order (apply top-to-bottom) */
  upgrades: SkillUpgradeRec[];
  /** What to save for once currency allows */
  nextGoals: string[];
  respec: RespecFlag[];
  totalCostByCurrency: Record<number, number>;
}

interface LadderStep {
  /** Substrings that must ALL appear in the stat name (lowercased) */
  match: string[];
  /** Level to reach before moving down the ladder */
  target: number;
  reason: string;
}

// Combat ladder when clearing decently (avg rooms >= 6)
const COMBAT_LADDER: LadderStep[] = [
  { match: ["sword", "atk"], target: 7, reason: "One-shot early rooms — the bot leads with its highest-ATK move" },
  { match: ["amr"], target: 4, reason: "Makes Shield's +4 armor land fully" },
  { match: ["hp"], target: 5, reason: "Survive floor-2 damage spikes" },
  { match: ["spell", "atk"], target: 4, reason: "Second damage type so counters still hurt" },
  { match: ["shield", "atk"], target: 4, reason: "Chip damage while turtling" },
  { match: ["sword", "atk"], target: 12, reason: "Keep stacking the primary damage stat" },
  { match: ["hp"], target: 10, reason: "Depth insurance for floors 3-4" },
  { match: ["spell", "atk"], target: 8, reason: "Round out damage breadth" },
];

// Combat ladder when dying early (avg rooms < 6): survive first, then hit
const COMBAT_LADDER_SURVIVAL: LadderStep[] = [
  { match: ["amr"], target: 4, reason: "You're dying early — armor first so Shield actually protects" },
  { match: ["hp"], target: 5, reason: "You're dying early — HP buffer before damage" },
  { match: ["sword", "atk"], target: 7, reason: "Now stack damage — one-shot early rooms" },
  { match: ["spell", "atk"], target: 4, reason: "Second damage type so counters still hurt" },
  { match: ["shield", "atk"], target: 4, reason: "Chip damage while turtling" },
  { match: ["sword", "atk"], target: 12, reason: "Keep stacking the primary damage stat" },
  { match: ["hp"], target: 10, reason: "Depth insurance for floors 3-4" },
];

/**
 * Trees for the Void and Forbidden Woods dungeons. These have NO attack stats
 * — only Max HP, Max AMR, and the five proc chances — so the combat ladder's
 * whole damage-first premise silently no-ops against them and falls through to
 * armour by accident. Five of the seven stats matched no step at all.
 *
 * Ordering rationale, given how the auto-battler actually fights:
 * flat mitigation before proc chances, because armour and HP apply on every
 * exchange while a proc is a dice roll; and in these dungeons rooms cleared is
 * what pays, so not dying dominates. Per-level rates are the published Void
 * figures (Block and Tenacity 1%, Evasion and Intuition 0.5%, Luck 0.75%) and
 * have NOT been verified against live combat — the ordering follows them, so
 * it is worth revisiting if a probe ever measures them.
 */
const PROC_LADDER: LadderStep[] = [
  { match: ["amr"], target: 4, reason: "Flat armour applies every exchange — no roll to lose" },
  { match: ["hp"], target: 5, reason: "Rooms cleared is what pays here, and dying is what stops it" },
  { match: ["block"], target: 5, reason: "Best per-level rate of the defensive procs (1%/lvl)" },
  { match: ["tenacity"], target: 5, reason: "Same 1%/lvl rate, stacking a second damage reducer" },
  { match: ["amr"], target: 10, reason: "Raise the guaranteed floor before betting on dice" },
  { match: ["hp"], target: 10, reason: "Depth insurance for the later rooms" },
  { match: ["intuition"], target: 5, reason: "Feeds the move read the auto-battler already counters with" },
  { match: ["evasion"], target: 5, reason: "Half Block's rate per level, so it waits" },
  { match: ["luck"], target: 5, reason: "Crits only pay on exchanges you were winning anyway" },
];

/**
 * The fishing ladder, built from one tree's own numbers.
 *
 * Targets are expressed as the effect wanted, not as a level count, then
 * converted through the tree's published per-upgrade rate. Buying "Fintuition
 * to 5" in both trees would buy 12.5% in one and 7.5% in the other while
 * looking identical in the UI; buying "about 12.5% prediction" buys the same
 * thing in both and costs whatever that tree charges for it.
 *
 * The one genuine ordering difference between the ponds is mana. On a
 * lure-anchored pond a redraw costs one mana per card held, so mana is not just
 * how many cards get played — it is the only way out of a hand that cannot
 * reach the fish. On the classic board a dead hand still gets its swing. So
 * Stamana leads there and Fintuition leads on the classic pond.
 */
function buildFishingLadder(tree: SkillTree, pond: PondDef | undefined): LadderStep[] {
  const statFor = (parts: string[]): SkillStat | undefined =>
    tree.stats.find((s) => statMatches(s.name, parts));
  const rateOf = (parts: string[]): number => statFor(parts)?.increaseValue ?? 0;

  /** Upgrades this tree needs to reach `pct`, at its own rate. */
  const upgradesFor = (parts: string[], pct: number, fallback: number): number => {
    const r = rateOf(parts);
    return r > 0 ? Math.max(1, Math.ceil(pct / r)) : fallback;
  };

  const pctStep = (parts: string[], pct: number, why: string, fallback: number): LadderStep => {
    const r = rateOf(parts);
    const n = upgradesFor(parts, pct, fallback);
    return {
      match: parts,
      target: n,
      reason: r > 0 ? `${why} — ${r}%/upgrade here, so ${n} upgrades buys ~${pct}%` : why,
    };
  };

  // "stam" not "stamina": the game spells the stat "Stamana", so the longer
  // match silently never fired and this step was never recommended.
  const manaWhy = pond?.lureAnchored
    ? "Mana is both card plays and redraws on this pond — a dead hand costs mana to escape"
    : "More starting mana = more card plays per cast";
  const mana = (target: number): LadderStep => ({
    match: ["stam"],
    target,
    reason: `${manaWhy} (+${rateOf(["stam"]) || 1} per upgrade)`,
  });

  const fintuitionEarly = pctStep(
    ["fintuition"],
    12.5,
    "Reveals the fish's next cell — the card AI hits near-100% when it fires",
    5
  );
  const fintuitionLate = pctStep(["fintuition"], 25, "Keep the prediction rate climbing", 10);

  const rest: LadderStep[] = [
    pctStep(["weed"], 25, "Better sell prices compound into faster upgrades", 5),
    pctStep(["luck"], 4, "Rarity bumps pay more per catch", 3),
    pctStep(["taste"], 6, "Quality bumps are worth 40-60% more per star", 3),
    pctStep(["dual"], 6, "Two fish on one capped cast", 3),
  ];

  return pond?.lureAnchored
    ? [mana(5), fintuitionEarly, ...rest, mana(10), fintuitionLate]
    : [fintuitionEarly, mana(5), ...rest, fintuitionLate, mana(10)];
}

// Stats the ladders deliberately leave for last — used for respec detection
const COMBAT_LOW_TIER = [["sword", "def"], ["shield", "def"], ["spell", "def"]];
const FISHING_LOW_TIER = [["jebaitor"], ["rod control"]];

function statMatches(statName: string, parts: string[]): boolean {
  const lower = statName.toLowerCase();
  return parts.every((p) => lower.includes(p));
}

function isFishingTree(tree: SkillTree): boolean {
  const names = tree.stats.map((s) => s.name.toLowerCase()).join(" ");
  return names.includes("stam") || names.includes("fintuition") || tree.name.toLowerCase().includes("fish");
}

/**
 * The pond a fishing tree belongs to, matched on the currency it spends.
 *
 * Currency rather than name: the tree's `GAME_ITEM_ID_CID` is the same number
 * the pond's stall pays out, so the pairing comes from data both sides already
 * agree on. Matching "dendren" in the tree name would pair the right tree today
 * and quietly pair nothing the day a pond ships with an unrelated name.
 */
function pondForTree(tree: SkillTree): PondDef | undefined {
  return pondForCurrencyItem(tree.GAME_ITEM_ID_CID);
}

/**
 * Currency cost of raising one stat by a single upgrade, and how many tree
 * levels it consumes.
 *
 * An upgrade is not one tree level. `levelsPerPoint` says how many levels the
 * next upgrade of that stat costs, and it climbs — Stamana runs 1,2,2,2,3,3,…
 * so the ninth upgrade costs four levels, each priced separately off
 * `xpPerLvl`. Charging one level per upgrade under-priced every ladder past the
 * third step, which mattered far more once a second fishing tree existed with a
 * completely different curve.
 */
function upgradeCost(
  tree: SkillTree,
  stat: SkillStat,
  statLevel: number,
  totalLvl: number
): { cost: number; levels: number } | null {
  const levels = stat.levelsPerPoint?.[statLevel] ?? 1;
  let cost = 0;
  for (let i = 1; i <= levels; i++) {
    const step = tree.xpPerLvl?.[totalLvl + i];
    if (step === undefined) return null;
    cost += step;
  }
  return { cost, levels };
}

/**
 * A tree with no attack stats at all — the Void and Forbidden Woods shape.
 * Detected from the stats themselves rather than the name, so a future event
 * tree of the same shape is handled without a code change.
 */
function isProcTree(tree: SkillTree): boolean {
  const names = tree.stats.map((s) => s.name.toLowerCase());
  if (names.some((n) => n.includes("atk"))) return false;
  return names.some((n) => n.includes("tenacity") || n.includes("block") || n.includes("evasion"));
}

export interface DungeonPerfEntry {
  name: string;
  avgRooms: number;
  totalRuns: number;
}

/** Words shared by several names, so useless for telling trees apart */
const GENERIC_NAME_WORDS = new Set(["dungetron", "dungeon", "skills", "skill", "temporal"]);

function distinctiveWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !GENERIC_NAME_WORDS.has(w));
}

/**
 * Clear depth for the dungeon THIS tree's currency comes from. Each dungeon has
 * its own non-transferable tree, so each is judged on its own record.
 *
 * Paired by distinctive name word rather than the old "Underhaul or not" split,
 * which lumped every non-Underhaul dungeon together. Once Forbidden Woods
 * existed that pooled it with Dungetron 5000, and a deep Dungetron record hid
 * the fact that Woods runs were dying in room 2 — picking the thriving ladder
 * when the survival one applied.
 */
function avgRoomsForTree(
  tree: SkillTree,
  perf: DungeonPerfEntry[] | undefined,
  globalAvg: number | null
): number | null {
  if (!perf || perf.length === 0) return globalAvg;
  const treeWords = distinctiveWords(tree.name);
  const rows = perf.filter((p) =>
    distinctiveWords(p.name).some((w) => treeWords.includes(w))
  );
  const total = rows.reduce((s, r) => s + r.totalRuns, 0);
  if (total < 3) return globalAvg;
  return rows.reduce((s, r) => s + r.avgRooms * r.totalRuns, 0) / total;
}

/**
 * Build the upgrade queue for every tree.
 *
 * @param avgRooms global average rooms cleared (fallback when no per-dungeon data)
 * @param dungeonPerf per-dungeon run history for tree-specific ladder choice
 */
export function buildSkillAdvice(
  trees: SkillTree[],
  progress: SkillProgressEntity[],
  balances: Record<string, number>,
  avgRooms: number | null,
  dungeonPerf?: DungeonPerfEntry[]
): SkillAdvice {
  const upgrades: SkillUpgradeRec[] = [];
  const nextGoals: string[] = [];
  const respec: RespecFlag[] = [];
  const totalCostByCurrency: Record<number, number> = {};

  for (const tree of trees) {
    const skillId = Number(tree.docId);
    const prog = progress.find((p) => p.SKILL_CID === skillId);
    const maxLvl = tree.LEVEL_CID || 100;

    // Current level per stat (LEVEL_CID_array indexed by stat id)
    const statLevel = new Map<number, number>();
    for (const stat of tree.stats) {
      statLevel.set(stat.id, prog?.LEVEL_CID_array?.[stat.id] ?? 0);
    }
    let totalLvl = prog?.LEVEL_CID ?? 0;
    const currentTotalLvl = totalLvl;

    const fishing = isFishingTree(tree);
    const pond = fishing ? pondForTree(tree) : undefined;
    if (fishing && !pond) {
      // A fishing tree whose currency is in no pond means a pond shipped that
      // lib/ponds.ts has not been told about. The ladder still works off the
      // tree's own rates, but nothing pond-specific can be applied — say so
      // rather than silently treating it as the classic pond.
      nextGoals.push(
        `${tree.name}: spends item ${tree.GAME_ITEM_ID_CID}, which belongs to no pond in lib/ponds.ts. ` +
          `Advice is generic until that pond is declared.`
      );
    }
    const proc = !fishing && isProcTree(tree);
    const treeAvgRooms = fishing ? null : avgRoomsForTree(tree, dungeonPerf, avgRooms);
    const ladder = fishing
      ? buildFishingLadder(tree, pond)
      : proc
      ? PROC_LADDER
      : treeAvgRooms != null && treeAvgRooms < 6
      ? COMBAT_LADDER_SURVIVAL
      : COMBAT_LADDER;

    // Walk the ladder, queueing affordable upgrades against a simulated budget
    let budget = balances[String(tree.GAME_ITEM_ID_CID)] ?? 0;
    let queued = 0;
    let firstUnaffordable: string | null = null;

    for (const step of ladder) {
      const stat = tree.stats.find((s) => statMatches(s.name, step.match));
      if (!stat) continue;

      while ((statLevel.get(stat.id) ?? 0) < step.target && totalLvl < maxLvl && queued < 12) {
        const fromLevel = statLevel.get(stat.id) ?? 0;
        const next = upgradeCost(tree, stat, fromLevel, totalLvl);
        if (!next) break;
        const { cost, levels } = next;
        if (totalLvl + levels > maxLvl) break;
        if (cost > budget) {
          if (!firstUnaffordable) {
            firstUnaffordable = `${tree.name}: save ${cost} for ${stat.name} → Lv${fromLevel + 1} (${step.reason})`;
          }
          break;
        }
        upgrades.push({
          skillId,
          statId: stat.id,
          treeName: tree.name,
          statName: stat.name,
          fromLevel,
          cost,
          currencyItemId: tree.GAME_ITEM_ID_CID,
          reason: step.reason,
        });
        totalCostByCurrency[tree.GAME_ITEM_ID_CID] = (totalCostByCurrency[tree.GAME_ITEM_ID_CID] ?? 0) + cost;
        budget -= cost;
        statLevel.set(stat.id, fromLevel + 1);
        totalLvl += levels;
        queued++;
      }
      if (firstUnaffordable || queued >= 12) break;
    }
    if (firstUnaffordable) nextGoals.push(firstUnaffordable);

    // Respec check: too many points parked in stats the ladder puts last
    // (uses CURRENT allocation, not the simulated post-upgrade state)
    if (currentTotalLvl >= 10) {
      const lowTier = fishing ? FISHING_LOW_TIER : COMBAT_LOW_TIER;
      let lowTierLevels = 0;
      for (const stat of tree.stats) {
        if (lowTier.some((parts) => statMatches(stat.name, parts))) {
          lowTierLevels += prog?.LEVEL_CID_array?.[stat.id] ?? 0;
        }
      }
      const share = lowTierLevels / currentTotalLvl;
      if (share > 0.35) {
        respec.push({
          treeName: tree.name,
          note: `${lowTierLevels} of ${currentTotalLvl} points sit in low-value stats (${Math.round(share * 100)}%). A respec refunds 75% of spent currency (costs Temporal Hourglasses) — worth it if you're pushing deeper. Recommend-only: do it in-game.`,
        });
      }
    }
  }

  return { upgrades, nextGoals, respec, totalCostByCurrency };
}
