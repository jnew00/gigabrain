// Opt-in instrumentation for the enemy-move predictor.
//
// Two things it answers, both of which need live combat data to settle:
//   1. Do enemy charges actually deplete, or does the API always report 3/3/3?
//      The charge-constrained predictor is only worth anything if they move.
//   2. How often is the prediction right, against a 1/3 baseline?
//
// Enable in the browser console, run a dungeon, then read the summary:
//   localStorage.setItem("giga-probe-enemy", "1")
//   __gigaProbe.summary()
//   copy(JSON.stringify(__gigaProbe.rows))   // raw observations

import type { Player } from "./types";
import { COMBAT_MOVES, readEnemyCharges, predictEnemyMove, spendCharge } from "./enemy-predict";
import type { CombatMove, EnemyCharges } from "./enemy-predict";

const FLAG = "giga-probe-enemy";

export interface ProbeRow {
  enemyId: number;
  room: number;
  /** Enemy charges observed before the move, when readable. */
  chargesBefore: EnemyCharges | null;
  /** Moves the predictor believed were playable. */
  available: CombatMove[];
  predicted: CombatMove | null;
  confidence: number;
  actual: string;
  /**
   * What we played the same round. Historical data showed a strong enemy
   * opening skew, but couldn't rule out the server reacting to our move —
   * only a sample carrying both sides can.
   */
  ourMove: string;
  /** True on the first exchange of a fight (both sides at full charges). */
  opening: boolean;
  /** Did spendCharge(before, actual) reproduce the observed post-action charges? */
  chargeModelOk: boolean | null;
  /** Null when the predictor declined to guess. */
  correct: boolean | null;
  /** False when the enemy played a move the charge model said was locked out. */
  consistentWithCharges: boolean;
}

interface ProbeApi {
  rows: ProbeRow[];
  summary: () => void;
  reset: () => void;
}

declare global {
  var __gigaProbe: ProbeApi | undefined;
}

export function probeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

function api(): ProbeApi {
  if (!globalThis.__gigaProbe) {
    const rows: ProbeRow[] = [];
    globalThis.__gigaProbe = {
      rows,
      reset: () => {
        rows.length = 0;
        console.log("[probe] cleared");
      },
      summary: () => {
        if (rows.length === 0) {
          console.log("[probe] no observations yet — run a dungeon with the flag set");
          return;
        }
        const readable = rows.filter((r) => r.chargesBefore);
        const depleting = readable.filter((r) =>
          COMBAT_MOVES.some((m) => r.chargesBefore![m] !== 3)
        ).length;
        const modelled = rows.filter((r) => r.chargeModelOk !== null);
        const modelOk = modelled.filter((r) => r.chargeModelOk).length;
        const guessed = rows.filter((r) => r.correct !== null);
        const hits = guessed.filter((r) => r.correct).length;
        const constrained = rows.filter((r) => r.available.length < 3);
        const constrainedHits = constrained.filter((r) => r.correct).length;
        const violations = rows.filter((r) => !r.consistentWithCharges).length;

        const share = (rs: ProbeRow[], m: string) => pct(rs.filter((r) => r.actual === m).length, rs.length);
        const openers = rows.filter((r) => r.opening);
        // Does the enemy's move track ours? If the server were reacting to our
        // play, the opening distribution would shift with what we opened.
        const byOurs = COMBAT_MOVES.map((om) => {
          const rs = openers.filter((r) => r.ourMove === om);
          return rs.length === 0
            ? null
            : `      we opened ${om.padEnd(8)} (n=${String(rs.length).padStart(4)}): enemy Sw ${share(rs, "rock")} / Sh ${share(rs, "paper")} / Sp ${share(rs, "scissor")}`;
        }).filter(Boolean);

        console.log(
          [
            `[probe] ${rows.length} enemy moves observed (${readable.length} with readable charges)`,
            `  pre-move charges off 3/3/3 : ${depleting} (${pct(depleting, readable.length)})  <- if 0, charges never deplete`,
            `  charge rule reproduced     : ${modelOk}/${modelled.length} (${pct(modelOk, modelled.length)})  <- validates the whole model`,
            `  charge-rule violations     : ${violations}  <- enemy played a locked-out move`,
            `  predictions attempted  : ${guessed.length}`,
            `  prediction accuracy    : ${hits}/${guessed.length} (${pct(hits, guessed.length)}) vs 33% baseline`,
            `  when constrained (<3)  : ${constrainedHits}/${constrained.length} (${pct(constrainedHits, constrained.length)})`,
            `  openings (n=${openers.length}): enemy Sw ${share(openers, "rock")} / Sh ${share(openers, "paper")} / Sp ${share(openers, "scissor")}`,
            `    split by what we opened  <- near-identical rows mean the enemy is NOT reacting to us:`,
            ...byOurs,
          ].join("\n")
        );
      },
    };
  }
  return globalThis.__gigaProbe;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

/**
 * Record one observed enemy move.
 *
 * Takes the enemy snapshot from *before* the action and the one from after.
 * The pre-action charges cannot be recovered by inverting the post-action
 * state: the forward rule caps regained charges at 3, so a move that sat at 3
 * and stayed there is indistinguishable from one that went 2 -> 3.
 */
export function probeEnemyMove(
  enemyBefore: Player | null | undefined,
  enemyAfter: Player | null | undefined,
  enemyId: number,
  room: number,
  baseStats: number[] | undefined,
  selfAfter?: Player | null
) {
  if (!probeEnabled() || !enemyAfter?.lastMove) return;
  const actual = enemyAfter.lastMove;

  const before = readEnemyCharges(enemyBefore);
  const after = readEnemyCharges(enemyAfter);

  // Nothing spent yet on either side = the first exchange of the fight.
  const opening = !!before && COMBAT_MOVES.every((m) => before[m] === 3);

  // Does the charge rule actually predict the post-action state? If this holds
  // across a sample, both the mechanic and the lastMove alignment are confirmed.
  let chargeModelOk: boolean | null = null;
  if (before && after && COMBAT_MOVES.includes(actual as CombatMove)) {
    const expected = spendCharge(before, actual as CombatMove);
    chargeModelOk = COMBAT_MOVES.every((m) => expected[m] === after[m]);
  }

  const pred = predictEnemyMove(before, enemyBefore, baseStats);
  const row: ProbeRow = {
    enemyId,
    room,
    chargesBefore: before,
    available: pred.available,
    predicted: pred.move,
    confidence: Number(pred.confidence.toFixed(3)),
    actual,
    ourMove: selfAfter?.lastMove ?? "",
    opening,
    chargeModelOk,
    // Only score a guess the caller would actually have used.
    correct: pred.move && pred.confidence >= 0.4 ? pred.move === actual : null,
    consistentWithCharges:
      !before || !COMBAT_MOVES.includes(actual as CombatMove)
        ? true
        : pred.available.includes(actual as CombatMove),
  };

  api().rows.push(row);
  console.log(
    `[probe] enemy#${enemyId} r${room} played ${actual} | before ${
      before ? `${before.rock}/${before.paper}/${before.scissor}` : "?"
    } -> after ${after ? `${after.rock}/${after.paper}/${after.scissor}` : "?"}${
      opening ? " | OPENING" : ""
    } | guess ${pred.move ?? "-"} (${row.confidence})`
  );
}
