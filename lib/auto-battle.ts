import type {
  DungeonAction,
  DungeonActionResponse,
  Player,
  LootOption,
} from "./types";
import { predictEnemyMove } from "./enemy-tracker";
import type { EnemyMoveRecord } from "./enemy-tracker";

type CombatMove = "rock" | "paper" | "scissor";
type LootAction = "loot_one" | "loot_two" | "loot_three" | "loot_four";

const COMBAT_MOVES: CombatMove[] = ["rock", "paper", "scissor"];
const LOOT_ACTIONS: LootAction[] = ["loot_one", "loot_two", "loot_three", "loot_four"];

export const MOVE_LABELS: Record<string, string> = {
  rock: "Sword",
  paper: "Shield",
  scissor: "Spell",
};

/* ─── Scoring ──────────────────────────────────────────────── */

export function evaluateState(state: DungeonActionResponse): number {
  const run = state.data?.run;
  const entity = state.data?.entity;
  if (!run || !run.players?.[0]) return 0;

  const player = run.players[0];
  const enemiesDefeated = entity?.ROOM_NUM_CID ?? 0;
  const hpRatio = player.health.current / (player.health.currentMax || 1);
  const armorRatio = player.shield.current / (player.shield.currentMax || 1);

  const moveScores = COMBAT_MOVES.map(
    (m) => player[m].currentATK * 2 + player[m].currentDEF
  ).sort((a, b) => b - a);
  const top2Synergy = (moveScores[0] + moveScores[1]) * 0.01;

  const spamPenalties = COMBAT_MOVES.filter(
    (m) => player[m].currentCharges === -1
  ).length;

  return enemiesDefeated + hpRatio * 2 + armorRatio + top2Synergy - spamPenalties * 0.3;
}

/* ─── DP combat move selection (4-round lookahead) ───────── */

// Beats map: what move beats what (winner → loser)
const BEATS: Record<CombatMove, CombatMove> = {
  rock: "scissor",    // Sword beats Spell
  paper: "rock",      // Shield beats Sword
  scissor: "paper",   // Spell beats Shield
};

interface SimCharges {
  rock: number;
  paper: number;
  scissor: number;
}

function cloneCharges(player: Player): SimCharges {
  return {
    rock: player.rock.currentCharges,
    paper: player.paper.currentCharges,
    scissor: player.scissor.currentCharges,
  };
}

/** Simulate charge updates after playing a move */
function simUpdateCharges(charges: SimCharges, used: CombatMove): SimCharges {
  const next = { ...charges };

  // Used move loses a charge; if at 1, goes to -1 (spam)
  if (next[used] > 1) {
    next[used] -= 1;
  } else if (next[used] === 1) {
    next[used] = -1;
  }
  // charges <= 0: no change (already depleted/spammed)

  // Other moves gain +1 (if at -1 → 0, if 0-2 → +1, cap at 3)
  for (const m of COMBAT_MOVES) {
    if (m === used) continue;
    if (next[m] === -1) {
      next[m] = 0;
    } else if (next[m] >= 0 && next[m] < 3) {
      next[m] += 1;
    }
  }

  return next;
}

/** Score a single round outcome */
function scoreRound(
  playerMove: CombatMove,
  enemyMove: CombatMove | null,
  playerATK: number,
  playerDEF: number,
  enemyATK: number,
  confidence: number
): number {
  // No prediction — score based purely on player ATK (damage potential)
  if (!enemyMove) {
    return playerATK * 2 + playerDEF * 0.5;
  }

  const tie = playerMove === enemyMove;
  const playerWins = !tie && BEATS[playerMove] === enemyMove;

  if (playerWins) {
    // We deal ATK damage, gain DEF shield, enemy gains nothing
    // Weight by confidence — a high-confidence counter is very valuable
    return (playerATK * 3 + playerDEF) * (1 + confidence);
  } else if (tie) {
    // Both deal ATK, both gain DEF — net result depends on ATK difference
    return (playerATK - enemyATK) + playerDEF;
  } else {
    // We take enemyATK damage, gain nothing
    // Penalize hard, weighted by confidence
    return (-enemyATK * 2) * (1 + confidence);
  }
}

const LOOKAHEAD = 4;

/**
 * DP search: evaluate all possible move sequences up to LOOKAHEAD rounds.
 * Returns the best first move and an explanation.
 */
function pickSmartCombatMove(
  player: Player,
  enemyId: number | null,
  roomNum: number | null,
  roundNum: number,
  records: EnemyMoveRecord[] = [],
  dungeonId?: number,
  enemyBaseStats?: number[]
): { move: CombatMove; reason: string } {
  // Get available moves
  const available = COMBAT_MOVES.filter((m) => player[m].currentCharges > 0);
  if (available.length === 0) {
    // All depleted — forced to play highest ATK
    const best = COMBAT_MOVES.slice().sort((a, b) => player[b].currentATK - player[a].currentATK)[0];
    return { move: best, reason: "forced (all depleted)" };
  }

  // If only one option, no need to search
  if (available.length === 1) {
    return { move: available[0], reason: `only option (${player[available[0]].currentATK} ATK)` };
  }

  // Pre-compute enemy predictions for each round in the lookahead window
  const enemyPredictions: { move: CombatMove | null; confidence: number; atk: number }[] = [];
  for (let r = 0; r < LOOKAHEAD; r++) {
    if (enemyId !== null && roomNum !== null) {
      const pred = predictEnemyMove(records, enemyId, roomNum, roundNum + r, dungeonId, enemyBaseStats);
      // Estimate enemy ATK from base stats if available, otherwise use a reasonable default
      let eATK = 10;
      if (pred.move && enemyBaseStats && enemyBaseStats.length >= 6) {
        const atkIdx = pred.move === "rock" ? 0 : pred.move === "paper" ? 2 : 4;
        eATK = enemyBaseStats[atkIdx] || 10;
      }
      enemyPredictions.push({
        move: pred.move && pred.confidence >= 0.4 ? pred.move as CombatMove : null,
        confidence: pred.confidence,
        atk: eATK,
      });
    } else {
      enemyPredictions.push({ move: null, confidence: 0, atk: 10 });
    }
  }

  // Recursive search
  let bestScore = -Infinity;
  let bestMove: CombatMove = available[0];
  let bestReason = "";

  function search(
    charges: SimCharges,
    depth: number,
    round: number
  ): number {
    if (depth >= LOOKAHEAD) return 0;

    const movesAvailable = COMBAT_MOVES.filter((m) => charges[m] > 0);
    if (movesAvailable.length === 0) return -50; // dead end penalty

    let best = -Infinity;
    for (const move of movesAvailable) {
      const pred = enemyPredictions[depth] ?? { move: null, confidence: 0, atk: 10 };
      const pATK = player[move].currentATK;
      const pDEF = player[move].currentDEF;

      // Score this round
      let roundScore = scoreRound(move, pred.move, pATK, pDEF, pred.atk, pred.confidence);

      // Spam penalty: using a move at 1 charge = -1 next turn, locked out
      if (charges[move] === 1) {
        roundScore -= 15; // significant penalty for going into spam
      }

      // Recurse into future rounds
      const nextCharges = simUpdateCharges(charges, move);
      const futureScore = search(nextCharges, depth + 1, round + 1);

      // Discount future slightly (present value > future value)
      const total = roundScore + futureScore * 0.85;

      if (depth === 0 && total > bestScore) {
        bestScore = total;
        bestMove = move;

        // Build reason string
        const pred0 = enemyPredictions[0];
        if (pred0?.move && pred0.confidence >= 0.6 && BEATS[move] === pred0.move) {
          bestReason = `DP counter ${MOVE_LABELS[pred0.move]} (${Math.round(pred0.confidence * 100)}%)`;
        } else if (pred0?.move && pred0.confidence >= 0.4 && pred0.confidence < 0.5) {
          bestReason = `DP ${MOVE_LABELS[move]} (${pATK} ATK, base-stats hint)`;
        } else if (pred0?.move && pred0.confidence >= 0.4) {
          bestReason = `DP ${MOVE_LABELS[move]} (${pATK} ATK, ${Math.round(bestScore)}pts)`;
        } else {
          bestReason = `DP ${MOVE_LABELS[move]} (${pATK} ATK, ${Math.round(bestScore)}pts)`;
        }
      }

      best = Math.max(best, total);
    }

    return best;
  }

  search(cloneCharges(player), 0, roundNum);

  return { move: bestMove, reason: bestReason };
}

/* ─── Loot scoring ────────────────────────────────────────── */

// Rarity multipliers: higher rarity boons give bigger stat values, so weight them
const RARITY_WEIGHT: Record<number, number> = {
  0: 1.0,  // common (gray)
  1: 1.5,  // uncommon (green)
  2: 2.0,  // rare (blue)
  3: 3.0,  // epic (gold)
  4: 4.0,  // legendary (orange)
};

function scoreLoot(state: DungeonActionResponse, loot: LootOption): number {
  const run = state.data?.run;
  if (!run?.players?.[0]) return 0;

  const player = run.players[0];
  const rarity = RARITY_WEIGHT[loot.RARITY_CID] ?? 1.0;

  // Rank the player's moves by ATK to identify which they actually use
  const moveRanking = COMBAT_MOVES.map((m) => ({
    move: m,
    atk: player[m].currentATK,
  })).sort((a, b) => b.atk - a.atk);

  const primaryMove = moveRanking[0].move;   // strongest move
  const secondaryMove = moveRanking[1].move;  // second strongest
  // The third move (weakest ATK) is considered "unused"

  const v1 = loot.selectedVal1;
  const v2 = loot.selectedVal2;

  let score = 0;

  switch (loot.boonTypeString) {
    case "UpgradeRock":
    case "UpgradePaper":
    case "UpgradeScissor": {
      const upgradeTarget =
        loot.boonTypeString === "UpgradeRock" ? "rock" :
        loot.boonTypeString === "UpgradePaper" ? "paper" : "scissor";

      const atkValue = v1 * 3;
      const defValue = v2 * 1;

      if (upgradeTarget === primaryMove) {
        score = (atkValue + defValue) * 5;
      } else if (upgradeTarget === secondaryMove) {
        score = (atkValue + defValue) * 3;
      } else {
        score = (atkValue + defValue) * 0.5;
      }
      // Move upgrades scale linearly with rarity
      score *= rarity;
      break;
    }
    case "Heal": {
      const hpRatio = player.health.current / (player.health.currentMax || 1);
      if (hpRatio < 0.3) score = v1 * 8;
      else if (hpRatio < 0.5) score = v1 * 5;
      else if (hpRatio < 0.75) score = v1 * 2;
      else score = v1 * 0.3;
      // Heal scales linearly — rarity just means bigger heal value
      score *= rarity;
      break;
    }
    case "AddMaxHealth": {
      // Max HP is a PERMANENT upgrade for the entire run: raises ceiling + heals.
      // High-rarity Max HP is one of the best boons in the game.
      // Base value is high, and rarity scales quadratically (rarity^2)
      // so Epic/Legendary Max HP dominates over common ATK upgrades.
      const hpUrgency = player.health.current / (player.health.currentMax || 1) < 0.5 ? 1.5 : 1.0;
      score = v1 * 6 * hpUrgency * (rarity * rarity);
      break;
    }
    case "AddMaxArmor": {
      // Max Shield is permanent but weaker than Max HP (doesn't add current shield).
      // Still very valuable at high rarity — extra buffer every fight.
      score = v1 * 3 * (rarity * rarity);
      break;
    }
    default:
      score = v1 * rarity;
  }

  return score;
}

/* ─── Main exports ─────────────────────────────────────────── */

export function pickBestAction(
  state: DungeonActionResponse,
  records: EnemyMoveRecord[] = [],
  enemyNamesMap?: Record<string, { name: string; stats?: number[] }>
): DungeonAction | null {
  const run = state.data?.run;
  if (!run) return null;

  // Loot phase
  if (run.lootPhase && run.lootOptions?.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < run.lootOptions.length; i++) {
      const score = scoreLoot(state, run.lootOptions[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return LOOT_ACTIONS[bestIdx] ?? null;
  }

  // Combat phase
  const player = run.players?.[0];
  if (!player) return null;

  const entity = state.data?.entity;
  const enemyId = entity?.ENEMY_CID ?? null;
  const roomNum = entity?.ROOM_NUM_CID ?? null;
  const dungeonId = entity?.DUNGEON_ID_CID;

  // Look up enemy base stats
  const baseStats = enemyId !== null && enemyNamesMap
    ? (enemyNamesMap[String(enemyId)]?.stats ?? enemyNamesMap[`idx:${enemyId}`]?.stats)
    : undefined;

  // Estimate round number from charges used
  // At start, all charges are at max (3). Total charges lost = rounds played
  const totalMaxCharges = 9; // 3 moves * 3 max charges
  const currentCharges = COMBAT_MOVES.reduce(
    (sum, m) => sum + Math.max(0, player[m].currentCharges),
    0
  );
  const roundEstimate = Math.max(0, totalMaxCharges - currentCharges);

  const result = pickSmartCombatMove(player, enemyId, roomNum, roundEstimate, records, dungeonId, baseStats);
  return result.move;
}

/** Get the reason string for the last pick (for logging) */
export function explainAction(
  state: DungeonActionResponse,
  action: DungeonAction,
  records: EnemyMoveRecord[] = [],
  enemyNamesMap?: Record<string, { name: string; stats?: number[] }>
): string {
  const run = state.data?.run;
  if (!run) return "";

  if (action === "loot_one" || action === "loot_two" || action === "loot_three" || action === "loot_four") {
    const idx = LOOT_ACTIONS.indexOf(action as LootAction);
    const loot = run.lootOptions?.[idx];
    if (loot) {
      const score = scoreLoot(state, loot).toFixed(1);
      return `loot ${loot.boonTypeString} +${loot.selectedVal1}${loot.selectedVal2 ? `/+${loot.selectedVal2}` : ""} (${score})`;
    }
    return action;
  }

  const player = run.players?.[0];
  if (player && (action === "rock" || action === "paper" || action === "scissor")) {
    const entity = state.data?.entity;
    const enemyId = entity?.ENEMY_CID ?? null;
    const roomNum = entity?.ROOM_NUM_CID ?? null;
    const dungeonId = entity?.DUNGEON_ID_CID;

    const baseStats = enemyId !== null && enemyNamesMap
      ? (enemyNamesMap[String(enemyId)]?.stats ?? enemyNamesMap[`idx:${enemyId}`]?.stats)
      : undefined;

    const totalMaxCharges = 9;
    const currentCharges = COMBAT_MOVES.reduce(
      (sum, m) => sum + Math.max(0, player[m].currentCharges),
      0
    );
    const roundEstimate = Math.max(0, totalMaxCharges - currentCharges);

    const result = pickSmartCombatMove(player, enemyId, roomNum, roundEstimate, records, dungeonId, baseStats);
    const s = player[action];
    return `${MOVE_LABELS[action]} ${s.currentATK}atk ${s.currentCharges}ch — ${result.reason}`;
  }

  return action;
}
