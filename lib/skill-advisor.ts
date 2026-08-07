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
// Stamina = more plays per cast. Weed Dealer compounds seaweed income into
// further upgrades. Bait/crit skills are last.

import type { SkillTree, SkillProgressEntity } from "./types";

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

const FISHING_LADDER: LadderStep[] = [
  { match: ["fintuition"], target: 5, reason: "Reveals the fish's next cell — card AI hits ~100% when it fires" },
  { match: ["stamina"], target: 5, reason: "More starting mana = more card plays per cast" },
  { match: ["weed"], target: 5, reason: "Better sell prices compound into faster upgrades" },
  { match: ["luck"], target: 3, reason: "Rarity bumps = more seaweed per catch" },
  { match: ["taste"], target: 3, reason: "Quality bumps = 40-60% bonus seaweed per star" },
  { match: ["dual"], target: 3, reason: "Two fish on one capped cast" },
  { match: ["fintuition"], target: 10, reason: "Keep the prediction rate climbing" },
  { match: ["stamina"], target: 10, reason: "Longer casts close out tanky fish" },
];

// Stats the ladders deliberately leave for last — used for respec detection
const COMBAT_LOW_TIER = [["sword", "def"], ["shield", "def"], ["spell", "def"]];
const FISHING_LOW_TIER = [["jebaitor"], ["rod control"]];

function statMatches(statName: string, parts: string[]): boolean {
  const lower = statName.toLowerCase();
  return parts.every((p) => lower.includes(p));
}

function isFishingTree(tree: SkillTree): boolean {
  const names = tree.stats.map((s) => s.name.toLowerCase()).join(" ");
  return names.includes("stamina") || names.includes("fintuition") || tree.name.toLowerCase().includes("fish");
}

export interface DungeonPerfEntry {
  name: string;
  avgRooms: number;
  totalRuns: number;
}

/**
 * Clear depth for the dungeon THIS tree's currency comes from. Normal and
 * Underhaul have separate, non-transferable skill trees, so each is judged
 * by its own dungeon's performance. Falls back to the global average.
 */
function avgRoomsForTree(
  tree: SkillTree,
  perf: DungeonPerfEntry[] | undefined,
  globalAvg: number | null
): number | null {
  if (!perf || perf.length === 0) return globalAvg;
  const isUnderhaulTree = tree.name.toLowerCase().includes("underhaul");
  const rows = perf.filter((p) => {
    const n = p.name.toLowerCase();
    if (n.includes("gigus") || n.includes("void")) return false; // no own trees
    return isUnderhaulTree ? n.includes("underhaul") : !n.includes("underhaul");
  });
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
    const treeAvgRooms = fishing ? null : avgRoomsForTree(tree, dungeonPerf, avgRooms);
    const ladder = fishing
      ? FISHING_LADDER
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
        const cost = tree.xpPerLvl?.[totalLvl + 1];
        if (cost === undefined) break;
        if (cost > budget) {
          if (!firstUnaffordable) {
            firstUnaffordable = `${tree.name}: save ${cost} for ${stat.name} → Lv${(statLevel.get(stat.id) ?? 0) + 1} (${step.reason})`;
          }
          break;
        }
        const fromLevel = statLevel.get(stat.id) ?? 0;
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
        totalLvl++;
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
