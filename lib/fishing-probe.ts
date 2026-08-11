// Opt-in instrumentation for the fish-movement predictor.
//
// WALK_CONFIDENCE in fishing-ai.ts is currently a guess. It is not a taste
// parameter — it has a true value, P(next cell = extrapolated cell), and this
// measures it. Three things it answers, all of which need live casts:
//   1. Is the walk deterministic? If extrapolation is right 100% of the time
//      for a patternIndex, the hedge is pure loss and should be dropped.
//   2. Does accuracy differ per patternIndex? One global constant is only
//      defensible if every route extrapolates equally well.
//   3. Is the route learnable? Recording (patternIndex, prev, curr) -> actual
//      builds the transition table that would replace prediction with a lookup.
//
// Enable in the browser console, fish, then read the summary:
//   localStorage.setItem("giga-probe-fishing", "1")
//   __gigaFishProbe.summary()
//   copy(JSON.stringify(__gigaFishProbe.rows))   // raw observations

import { predictGroveCoords } from "./fishing-ai";

const FLAG = "giga-probe-fishing";

export interface FishProbeRow {
  /** The route the server says the fish is following this cast. */
  patternIndex: number | null;
  gridSize: number;
  /** Which pond — the Grove plays by different rules. */
  focusMechanic: boolean;
  previous: number[] | null;
  current: number[];
  /** Top-ranked candidate. With an even spread this is an arbitrary tie-break. */
  predicted: number[] | null;
  predictedP: number;
  actual: number[];
  /**
   * Was the cell the fish actually moved to among the candidates at all?
   *
   * This is the sharp test now. The model claims the fish takes one orthogonal
   * step and never reverses; a single false here falsifies that outright,
   * whereas top-pick accuracy is capped by the size of the spread and mostly
   * measures luck.
   */
  inSet: boolean;
  /** Probability mass the model put on the cell that actually happened. */
  pForActual: number;
  /** Null when there was no prior step. Kept for continuity, but see inSet. */
  correct: boolean | null;
  /** Fintuition was active, so the server stated the answer and we cannot score ourselves. */
  hadFintuition: boolean;
  /**
   * The row spans more than one move, so it is not a real transition.
   *
   * Detected server-side rather than trusted from a client snapshot: after a
   * move, the response's previousFishPosition must equal the position we
   * decided from. When it does not, a move happened that the probe never saw,
   * and the recorded step is two moves fused — which shows up as a phantom
   * diagonal or two-cell jump. Gapped rows are excluded from every statistic.
   */
  gap: boolean;
}

interface FishProbeApi {
  rows: FishProbeRow[];
  summary: () => void;
  transitions: () => void;
  reset: () => void;
}

declare global {
  var __gigaFishProbe: FishProbeApi | undefined;
}

export function fishProbeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

const key = (p: number[] | null) => (p ? p.join(",") : "-");

function api(): FishProbeApi {
  if (!globalThis.__gigaFishProbe) {
    const rows: FishProbeRow[] = [];
    globalThis.__gigaFishProbe = {
      rows,
      reset: () => {
        rows.length = 0;
        console.log("[fishprobe] cleared");
      },
      summary: () => {
        if (rows.length === 0) {
          console.log("[fishprobe] no observations yet — fish with the flag set");
          return;
        }
        // Fintuition states the answer, so scoring those would flatter the model.
        const gaps = rows.filter((r) => r.gap).length;
        const scored = rows.filter((r) => r.correct !== null && !r.hadFintuition && !r.gap);
        const hits = scored.filter((r) => r.correct).length;
        const inSet = scored.filter((r) => r.inSet).length;
        const meanP = scored.length
          ? scored.reduce((s, r) => s + r.pForActual, 0) / scored.length
          : 0;
        const indices = Array.from(new Set(scored.map((r) => r.patternIndex)));
        const perIndex = indices.map((idx) => {
          const rs = scored.filter((r) => r.patternIndex === idx);
          const h = rs.filter((r) => r.correct).length;
          return `      patternIndex ${String(idx).padEnd(4)} n=${String(rs.length).padStart(4)}  accuracy ${pct(h, rs.length)}`;
        });

        console.log(
          [
            `[fishprobe] ${rows.length} fish moves observed, ${scored.length} scoreable`,
            `  dropped observations: ${gaps} (${pct(gaps, rows.length)})  <- rows spanning two moves, excluded`,
            `  actual cell in set : ${inSet}/${scored.length} (${pct(inSet, scored.length)})  <- must be 100%, or the movement model is wrong`,
            `  mean P on actual   : ${meanP.toFixed(3)}  <- the real score; 1/candidates when the spread is even`,
            `  top-pick accuracy  : ${hits}/${scored.length} (${pct(hits, scored.length)})  <- capped by spread size, mostly tie-break luck`,
            `  per pattern index  <- if these differ, one global constant is wrong:`,
            ...perIndex,
            `  run __gigaFishProbe.transitions() for the raw route table`,
          ].join("\n")
        );
      },
      transitions: () => {
        // The transition table is the real prize: if every (pattern, prev, curr)
        // maps to exactly one observed next cell, the route is deterministic and
        // prediction becomes a lookup with no confidence term at all.
        const table = new Map<string, Map<string, number>>();
        for (const r of rows) {
          if (!r.previous || r.gap) continue;
          const k = `p${r.patternIndex} ${key(r.previous)} -> ${key(r.current)}`;
          if (!table.has(k)) table.set(k, new Map());
          const outcomes = table.get(k)!;
          const a = key(r.actual);
          outcomes.set(a, (outcomes.get(a) ?? 0) + 1);
        }
        const lines: string[] = [];
        let ambiguous = 0;
        for (const [k, outcomes] of Array.from(table.entries()).sort()) {
          const parts = Array.from(outcomes.entries()).map(([a, n]) => `${a}x${n}`);
          if (outcomes.size > 1) ambiguous++;
          lines.push(`  ${k}  =>  ${parts.join(" | ")}${outcomes.size > 1 ? "   <- AMBIGUOUS" : ""}`);
        }
        console.log(
          [
            `[fishprobe] ${table.size} distinct (pattern, prev, curr) states, ${ambiguous} ambiguous`,
            ambiguous === 0
              ? "  every state has one outcome — the route is deterministic and learnable"
              : "  some states have multiple outcomes — either non-deterministic, or the state needs more history",
            ...lines,
          ].join("\n")
        );
      },
    };
  }
  return globalThis.__gigaFishProbe;
}

/**
 * Record one observed fish move.
 *
 * Called with the game data from *before* a card was played and from after.
 * The prediction is recomputed from the pre-move snapshot so the row scores
 * what the AI would actually have believed at decision time, not a hindsight
 * reconstruction.
 */
export function probeFishMove(
  before:
    | {
        fishPosition: number[];
        previousFishPosition?: number[];
        gridSize?: number;
        patternIndex?: number;
        focusMechanicEnabled?: boolean;
        nextPosition?: number[] | null;
      }
    | null
    | undefined,
  after: { fishPosition: number[]; previousFishPosition?: number[] } | null | undefined
) {
  if (!fishProbeEnabled() || !before || !after) return;
  if (!Array.isArray(before.fishPosition) || !Array.isArray(after.fishPosition)) return;

  // The board has to come from the state being scored. Defaulting to 3 meant a
  // Grove observation was scored against a 3x3, so neighbours in row or column
  // 4 were "off the board" and the actual move landed out-of-set — the one
  // statistic the probe exists to keep at 100%.
  const gridSize = before.gridSize;
  if (typeof gridSize !== "number" || gridSize < 1) {
    console.warn("[fishprobe] skipped an observation with no gridSize — nothing to score against");
    return;
  }
  const hadFintuition = !!(before.nextPosition && before.nextPosition.length === 2);

  // Score the walk model itself, so pass no Fintuition hint even when one was
  // available — otherwise the rows measure the server, not the predictor.
  const predictions = predictGroveCoords(
    before.fishPosition,
    before.previousFishPosition,
    gridSize
  );
  const top = predictions[0] ?? null;

  const hasPrev =
    Array.isArray(before.previousFishPosition) &&
    before.previousFishPosition.length === 2 &&
    key(before.previousFishPosition) !== key(before.fishPosition);

  // The server says where the fish was immediately before this move. If that
  // disagrees with the state we decided from, we missed a move.
  const gap =
    Array.isArray(after.previousFishPosition) &&
    after.previousFishPosition.length === 2 &&
    key(after.previousFishPosition) !== key(before.fishPosition);

  const match = predictions.find((t) => key(t.coord) === key(after.fishPosition));
  const row: FishProbeRow = {
    patternIndex: before.patternIndex ?? null,
    gridSize,
    focusMechanic: !!before.focusMechanicEnabled,
    previous: before.previousFishPosition ?? null,
    current: before.fishPosition,
    predicted: top ? top.coord : null,
    predictedP: top ? Number(top.p.toFixed(3)) : 0,
    actual: after.fishPosition,
    inSet: !!match,
    pForActual: match ? Number(match.p.toFixed(3)) : 0,
    correct: hasPrev && top && !gap ? key(top.coord) === key(after.fishPosition) : null,
    gap,
    hadFintuition,
  };

  api().rows.push(row);
  console.log(
    `[fishprobe] p${row.patternIndex} ${key(row.previous)} -> ${key(row.current)} => ${key(
      row.actual
    )} | P(actual) ${row.pForActual}${row.inSet ? "" : "  OUT-OF-SET"}${row.gap ? "  GAP" : ""}`
  );
}
