// Enemy move prediction from live combat state.
//
// This replaces a per-enemy move-frequency table. That approach had two
// defects: the round number it keyed on came from a charge sum that saturates
// after one round (so every record landed in the same bucket), and nothing
// supports the premise that enemy moves are a learnable pattern. The official
// docs never describe enemy move selection, the official agent skill makes no
// attempt to predict it, the most complete third-party engine models it as
// uniform random, and the game sells a Void skill that reveals one move the
// enemy will *not* play at 0.5% per point — a mechanic that only makes sense
// against a randomized opponent.
//
// What is knowable is mechanical rather than behavioral: the enemy draws from
// the same three moves under the same charge rules as the player. As their
// charges deplete their options narrow, and with one option left the move is
// forced. That needs no history and works on an enemy never seen before.

import type { Player } from "./types";

export type CombatMove = "rock" | "paper" | "scissor";

export const COMBAT_MOVES: CombatMove[] = ["rock", "paper", "scissor"];

/** Enemy charges as tracked through a lookahead simulation. */
export interface EnemyCharges {
  rock: number;
  paper: number;
  scissor: number;
}

export interface MovePrediction {
  /** Best guess, or null when the enemy is unconstrained and a guess would be noise. */
  move: CombatMove | null;
  /** P(correct) for the guess: 1.0 when forced, ~0.5 when two options, 1/3 when free. */
  confidence: number;
  /** Moves the enemy still has charges for. */
  available: CombatMove[];
  /** Human-readable basis, surfaced in the action explanation. */
  reason: string;
}

/** Index of a move's ATK inside MOVE_STATS_CID_array. */
const ATK_INDEX: Record<CombatMove, number> = { rock: 0, paper: 2, scissor: 4 };

/**
 * ATK the enemy would deal with a move. Prefers live combat stats (which
 * include in-run boons) and falls back to the static MOVE_STATS_CID_array
 * layout [rockATK, rockDEF, paperATK, paperDEF, scissorATK, scissorDEF, ...].
 */
export function enemyMoveAtk(
  enemy: Player | null | undefined,
  baseStats: number[] | undefined,
  move: CombatMove
): number {
  const live = enemy?.[move]?.currentATK;
  if (typeof live === "number" && live > 0) return live;
  if (baseStats && baseStats.length >= 6) return baseStats[ATK_INDEX[move]] ?? 0;
  return 0;
}

/** Read the enemy's charge state, or null when the field isn't populated. */
export function readEnemyCharges(enemy: Player | null | undefined): EnemyCharges | null {
  if (!enemy) return null;
  const out = { rock: 0, paper: 0, scissor: 0 };
  for (const m of COMBAT_MOVES) {
    const c = enemy[m]?.currentCharges;
    if (typeof c !== "number") return null;
    out[m] = c;
  }
  return out;
}

/**
 * Apply one move to a charge set using the game's charge rules: the used move
 * spends a charge and locks out at zero, every other move regains one, capped
 * at three. Shared by the player and the enemy.
 */
export function spendCharge(charges: EnemyCharges, used: CombatMove): EnemyCharges {
  const next = { ...charges };
  if (next[used] > 1) next[used] -= 1;
  else if (next[used] === 1) next[used] = -1;
  for (const m of COMBAT_MOVES) {
    if (m === used) continue;
    if (next[m] === -1) next[m] = 0;
    else if (next[m] >= 0 && next[m] < 3) next[m] += 1;
  }
  return next;
}

/**
 * Predict the enemy's next move from their charge state.
 *
 * Confidence is the honest probability of being right: 1.0 when only one move
 * is playable, ~0.5 with two, 1/3 with three. Among equally playable moves the
 * highest-ATK one is used as a tiebreak, but that only nudges confidence when
 * the enemy is already constrained — an unconstrained enemy stays below the
 * caller's usable threshold so a guess never masquerades as information.
 */
export function predictEnemyMove(
  charges: EnemyCharges | null,
  enemy: Player | null | undefined,
  baseStats: number[] | undefined
): MovePrediction {
  const all = COMBAT_MOVES;
  const available = charges ? all.filter((m) => charges[m] > 0) : all;

  // Charges unreadable, or every move locked out — no mechanical constraint.
  if (available.length === 0) {
    return { move: null, confidence: 0, available: all, reason: "no charge data" };
  }

  const ranked = available
    .map((m) => ({ move: m, atk: enemyMoveAtk(enemy, baseStats, m) }))
    .sort((a, b) => b.atk - a.atk);

  const top = ranked[0];
  const second = ranked[1];

  if (available.length === 1) {
    return {
      move: top.move,
      confidence: 1,
      available,
      reason: `forced (only ${top.move} has charges)`,
    };
  }

  const base = 1 / available.length;

  // ATK ordering is a tiebreak, not evidence that enemies prefer their
  // strongest move — nothing verified that. It is only allowed to move
  // confidence when charges already narrowed the field.
  let skew = 0;
  if (available.length < all.length && second) {
    const dominance = second.atk > 0 ? (top.atk - second.atk) / second.atk : top.atk > 0 ? 1 : 0;
    skew = Math.min(0.1, Math.max(0, dominance) * 0.1);
  }

  return {
    move: top.move,
    confidence: Math.min(1, base + skew),
    available,
    reason:
      available.length < all.length
        ? `${available.length} of 3 playable, ${top.move} highest ATK`
        : "unconstrained",
  };
}
