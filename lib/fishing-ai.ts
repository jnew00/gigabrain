import type { FishingCard } from "./types";

/* ─── Grid Layout ─────────────────────────────────────────────
   Cells are numbered left-to-right, top-to-bottom, starting at 1.
   For the classic 3x3 pond:
   1 2 3
   4 5 6
   7 8 9

   API coordinates are [row, col], both 1-based, row 1 = top. Zones on a card
   use the same left-to-right, top-to-bottom numbering, confirmed against the
   game's own hover overlay.

   The Awakening's Dendren Grove pond is larger than 3x3, so every
   function here takes the grid dimensions rather than assuming 9 cells.
   The Grove also abandons board addressing entirely — see pickGroveMove.
   ──────────────────────────────────────────────────────────── */

export interface GridDims {
  cols: number;
  rows: number;
}

/** The original pond. Used when nothing better can be determined. */
export const DEFAULT_GRID: GridDims = { cols: 3, rows: 3 };

/**
 * The board the server says we're on.
 *
 * `gridSize` is authoritative and is what should be used — the Dendren Grove
 * reports 4 while its starting deck only reaches zone 9, so inferring the board
 * from the deck reads a 4x4 pond as 3x3 and mistargets every card. Inference is
 * kept only for states that arrive without the field.
 */
export function resolveGrid(data: {
  gridSize?: number;
  deckCardData: FishingCard[];
  fishPosition?: number[];
  previousFishPosition?: number[];
  nextPosition?: number[] | null;
}): GridDims {
  if (typeof data.gridSize === "number" && data.gridSize > 0) {
    return { cols: data.gridSize, rows: data.gridSize };
  }
  return inferGrid(
    data.deckCardData, data.fishPosition, data.previousFishPosition, data.nextPosition
  );
}

/**
 * Fallback for states with no `gridSize`. Prefer resolveGrid.
 *
 * Work out the pond's dimensions from the data the API already gives us.
 *
 * The largest zone ID any card in the deck can hit is the cell count, since
 * cards collectively cover the board. That leaves the split between columns
 * and rows, which is narrowed by any [col, row] coordinates seen this cast
 * and otherwise resolved to the most square shape.
 *
 * A single capture of a Grove cast would let us replace this with a constant.
 */
export function inferGrid(
  deckCardData: FishingCard[],
  ...coords: (number[] | null | undefined)[]
): GridDims {
  let cellCount = 0;
  for (const card of deckCardData) {
    for (const z of card.hitZones) if (z > cellCount) cellCount = z;
    for (const z of card.critZones) if (z > cellCount) cellCount = z;
  }
  if (cellCount < 2) return DEFAULT_GRID;

  // Observed positions are a floor on each dimension. Coordinates are
  // [row, col], so the first element bounds rows and the second bounds columns.
  let minCols = 1;
  let minRows = 1;
  for (const c of coords) {
    if (!c || c.length !== 2) continue;
    if (c[0] > minRows) minRows = c[0];
    if (c[1] > minCols) minCols = c[1];
  }

  let best: GridDims | null = null;
  for (let cols = 1; cols <= cellCount; cols++) {
    if (cellCount % cols !== 0) continue;
    const rows = cellCount / cols;
    if (cols < minCols || rows < minRows) continue;
    // <= rather than < so a tie resolves to the wider board. Ponds are drawn
    // landscape, and picking the portrait twin transposes every cell ID.
    if (!best || Math.abs(cols - rows) <= Math.abs(best.cols - best.rows)) {
      best = { cols, rows };
    }
  }
  if (best) return best;

  // No factorisation fits what we've actually seen. The observed coordinates
  // are hard facts and the cell count is only a lower bound, so trust the
  // coordinates — a board at least this big definitely exists.
  if (minCols > 1 || minRows > 1) {
    return { cols: Math.max(minCols, 1), rows: Math.max(minRows, 1) };
  }
  return DEFAULT_GRID;
}

/**
 * Convert an API [row, col] coordinate to a cell ID.
 *
 * This had the axes swapped until 2026-08-10, destructuring as [col, row] and
 * so returning the transposed cell. Two independent observations fixed it: on
 * the classic pond a fish reported at [2,3] renders in column 3 of row 2, and
 * the game's own card overlay projects card 31's zones [7,8,9,3,6] onto
 * column 3 of rows 1-2 plus all of row 3 — which is row-major numbering.
 *
 * The old bug was partly self-concealing because many card shapes are
 * symmetric under transposition: [2,4,6,8] and [3,6,7,8,9] both map to
 * themselves, so those cards scored correctly either way.
 */
export function coordToCell(coord: number[], grid: GridDims = DEFAULT_GRID): number {
  if (coord.length !== 2) return 0;
  const [row, col] = coord;
  return (row - 1) * grid.cols + col;
}

/** Inverse of coordToCell: a cell ID back to a 1-based [row, col]. */
export function cellToCoord(cell: number, grid: GridDims): number[] {
  return [Math.floor((cell - 1) / grid.cols) + 1, ((cell - 1) % grid.cols) + 1];
}

/** Zero-based row of a cell */
function cellRow(cell: number, grid: GridDims): number {
  return Math.floor((cell - 1) / grid.cols);
}

/** Zero-based column of a cell */
function cellCol(cell: number, grid: GridDims): number {
  return (cell - 1) % grid.cols;
}

/** Cell ID at a zero-based (row, col), or 0 when off the board */
function cellAt(r: number, c: number, grid: GridDims): number {
  if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols) return 0;
  return r * grid.cols + c + 1;
}

/**
 * Middle indices of a dimension. Odd lengths have one centre, even lengths
 * have two — so the cross pattern still means something on a 4-wide pond.
 */
function middles(n: number): number[] {
  return n % 2 === 1 ? [(n - 1) / 2] : [n / 2 - 1, n / 2];
}

/** Cells on the centre row or centre column — the "plus" pattern's board */
function isCrossCell(cell: number, grid: GridDims): boolean {
  const r = cellRow(cell, grid);
  const c = cellCol(cell, grid);
  return middles(grid.rows).includes(r) || middles(grid.cols).includes(c);
}

/* ─── Movement Pattern Detection ──────────────────────────── */

// Fish follow one of 3 deterministic patterns per encounter:
// 1. Orthogonal: moves 1 cell up/down/left/right (never diagonal)
// 2. Diagonal:   moves diagonally (like a chess bishop)
// 3. Plus/Cross: stays on the cross cells

type MovementPattern = "orthogonal" | "diagonal" | "plus";

/** Orthogonal neighbors (up/down/left/right, 1 step) */
function orthogonalNeighbors(pos: number, grid: GridDims): number[] {
  const r = cellRow(pos, grid);
  const c = cellCol(pos, grid);
  return [cellAt(r - 1, c, grid), cellAt(r + 1, c, grid), cellAt(r, c - 1, grid), cellAt(r, c + 1, grid)]
    .filter((p) => p > 0);
}

/** Diagonal neighbors (1 step diagonally) */
function diagonalNeighbors(pos: number, grid: GridDims): number[] {
  const r = cellRow(pos, grid);
  const c = cellCol(pos, grid);
  return [
    cellAt(r - 1, c - 1, grid),
    cellAt(r - 1, c + 1, grid),
    cellAt(r + 1, c - 1, grid),
    cellAt(r + 1, c + 1, grid),
  ].filter((p) => p > 0);
}

/** Plus/cross pattern neighbors: orthogonal moves but constrained to cross cells */
function plusNeighbors(pos: number, grid: GridDims): number[] {
  return orthogonalNeighbors(pos, grid).filter((p) => isCrossCell(p, grid));
}

/** Get reachable positions for a given pattern */
function getReachableForPattern(cell: number, pattern: MovementPattern, grid: GridDims): number[] {
  const neighborFn =
    pattern === "orthogonal" ? orthogonalNeighbors :
    pattern === "diagonal" ? diagonalNeighbors :
    plusNeighbors;
  return neighborFn(cell, grid).filter((n) => n !== cell);
}

/** Even odds over every cell — used when there is nothing to predict from */
function uniform(grid: GridDims): { cell: number; p: number }[] {
  const n = grid.cols * grid.rows;
  return Array.from({ length: n }, (_, i) => ({ cell: i + 1, p: 1 / n }));
}

/**
 * Detect which movement pattern the fish is likely following based on
 * observed movement from previousPosition → currentPosition.
 * Returns a weight map (higher = more likely).
 */
function detectPatternWeights(
  prevCell: number,
  currCell: number,
  grid: GridDims
): Record<MovementPattern, number> {
  const weights: Record<MovementPattern, number> = {
    orthogonal: 1,
    diagonal: 1,
    plus: 1,
  };

  if (!prevCell || !currCell || prevCell === currCell) {
    // No useful movement — equal weights, slight bias toward orthogonal
    weights.orthogonal = 1.2;
    return weights;
  }

  const dr = cellRow(currCell, grid) - cellRow(prevCell, grid);
  const dc = cellCol(currCell, grid) - cellCol(prevCell, grid);
  const absDr = Math.abs(dr);
  const absDc = Math.abs(dc);

  // Orthogonal move (exactly 1 step in cardinal direction)
  if ((absDr + absDc) === 1) {
    weights.orthogonal = 5;
    weights.diagonal = 0.1;
    // Plus pattern also moves orthogonally, but only on cross cells
    if (isCrossCell(prevCell, grid) && isCrossCell(currCell, grid)) {
      weights.plus = 3;
    } else {
      weights.plus = 0.1;
    }
  }
  // Diagonal move (1 step diagonally)
  else if (absDr === 1 && absDc === 1) {
    weights.diagonal = 5;
    weights.orthogonal = 0.1;
    weights.plus = 0.1;
  }

  return weights;
}

/**
 * Predict where the fish will move next, considering all 3 movement patterns
 * weighted by likelihood from observed movement history.
 *
 * Takes cell IDs, returns cells with NORMALIZED probabilities
 * (sums to 1), most likely first.
 */
export function predictNextPositionsWeighted(
  currentCell: number,
  previousCell: number,
  grid: GridDims = DEFAULT_GRID,
): { cell: number; p: number }[] {
  if (!currentCell) return uniform(grid);

  const weights = detectPatternWeights(previousCell, currentCell, grid);

  // Score each potential next position by summing pattern weights
  const posScores = new Map<number, number>();
  const patterns: MovementPattern[] = ["orthogonal", "diagonal", "plus"];

  for (const pattern of patterns) {
    const w = weights[pattern];
    if (w <= 0) continue;
    const reachable = getReachableForPattern(currentCell, pattern, grid);
    for (const pos of reachable) {
      posScores.set(pos, (posScores.get(pos) ?? 0) + w);
    }
  }

  // Apply momentum bonus
  if (previousCell && previousCell !== currentCell) {
    const dr = cellRow(currentCell, grid) - cellRow(previousCell, grid);
    const dc = cellCol(currentCell, grid) - cellCol(previousCell, grid);
    if (dr !== 0 || dc !== 0) {
      const ahead = cellAt(cellRow(currentCell, grid) + dr, cellCol(currentCell, grid) + dc, grid);
      if (ahead > 0) posScores.set(ahead, (posScores.get(ahead) ?? 0) + 2);
    }
  }

  const total = Array.from(posScores.values()).reduce((s, v) => s + v, 0);
  if (total <= 0) return uniform(grid);

  return Array.from(posScores.entries())
    .map(([cell, w]) => ({ cell, p: w / total }))
    .sort((a, b) => b.p - a.p);
}

/**
 * Back-compat wrapper: predicted cells sorted by likelihood (no weights).
 */
export function predictNextPositions(
  currentCell: number,
  previousCell: number,
  grid: GridDims = DEFAULT_GRID,
): number[] {
  return predictNextPositionsWeighted(currentCell, previousCell, grid).map((e) => e.cell);
}

/* ─── Card Scoring ─────────────────────────────────────────── */

/** Mana is the cast's limiting resource — trade ~this much damage per mana */
const MANA_WEIGHT = 0.35;

/** Below this chance of connecting, a hand is worth replacing rather than spending. */
const REDRAW_THRESHOLD = 0.2;

export interface CardScore {
  handIdx: number;
  cardId: number;
  card: FishingCard | null;
  /** Expected value: pHit*dmg + pCrit*critDmg - pMiss*penalty - mana cost */
  ev: number;
  /** Probability the card hits the fish's next cell (0-1) */
  pHit: number;
  /** Probability the hit is a crit (0-1) */
  pCrit: number;
  hitDmg: number;
  missPenalty: number;
  critDmg: number;
  reason: string;
}

/**
 * Score a card against a probability distribution over the fish's NEXT cell.
 * Cards resolve AFTER the fish moves, so we score against predicted/Fintuition
 * positions, not where the fish currently sits.
 */
function scoreCardWeighted(
  card: FishingCard,
  targets: { cell: number; p: number }[]
): { ev: number; pHit: number; pCrit: number; hitDmg: number; missPenalty: number; critDmg: number } {
  const hitDmg = card.hitEffects.reduce((sum, e) => sum + e.amount, 0);
  const missPenalty = card.missEffects.reduce((sum, e) => sum + Math.abs(e.amount), 0);
  const critDmg = card.critEffects.reduce((sum, e) => sum + e.amount, 0);

  let pHit = 0;
  let pCrit = 0;
  for (const t of targets) {
    if (card.hitZones.includes(t.cell)) {
      pHit += t.p;
      if (card.critZones.includes(t.cell)) pCrit += t.p;
    }
  }

  const ev =
    pHit * hitDmg +
    pCrit * critDmg -
    (1 - pHit) * missPenalty -
    card.manaCost * MANA_WEIGHT;

  return { ev, pHit, pCrit, hitDmg, missPenalty, critDmg };
}

/**
 * Score every card in hand against the fish's predicted next position.
 * Shared by the auto-player and the hand UI so "BEST" always matches
 * what auto-fish would play. Results keep hand order.
 */
export function scoreHand(
  hand: number[],
  deckCardData: FishingCard[],
  fishPosition: number[],
  previousFishPosition?: number[],
  nextPosition?: number[] | null,
  grid: GridDims = DEFAULT_GRID
): CardScore[] {
  const cardLookup = new Map<number, FishingCard>();
  for (const c of deckCardData) cardLookup.set(c.id, c);

  const currentCell = coordToCell(fishPosition, grid);
  const prevCell = previousFishPosition ? coordToCell(previousFishPosition, grid) : 0;

  const hasFintuition = nextPosition && nextPosition.length === 2;
  const targets: { cell: number; p: number }[] = hasFintuition
    ? [{ cell: coordToCell(nextPosition, grid), p: 1 }]
    : predictNextPositionsWeighted(currentCell, prevCell, grid);

  const source = hasFintuition ? "Fintuition" : "predicted";

  return hand.map((cardId, handIdx) => {
    const card = cardLookup.get(cardId);
    if (!card) {
      return {
        handIdx, cardId, card: null, ev: -Infinity,
        pHit: 0, pCrit: 0, hitDmg: 0, missPenalty: 0, critDmg: 0,
        reason: "unknown card",
      };
    }
    const s = scoreCardWeighted(card, targets);
    const pct = Math.round(s.pHit * 100);
    const reason =
      s.pHit <= 0
        ? `MISS #${cardId} (0% hit, -${s.missPenalty} penalty)`
        : s.pCrit > 0.3
        ? `${source} CRIT #${cardId} (${pct}% hit, ${s.hitDmg}+${s.critDmg} dmg)`
        : `${source} #${cardId} (${pct}% hit, ${s.hitDmg} dmg, EV ${s.ev.toFixed(1)})`;
    return { handIdx, cardId, card, ...s, reason };
  });
}

/* ─── Main Exports ─────────────────────────────────────────── */

/**
 * Pick the best card from hand to play.
 *
 * Key insight: the fish ALWAYS moves before the card resolves.
 * So we target where the fish is GOING, not where it IS.
 *
 * All position params are API [col, row] coordinates — converted to cell IDs internally.
 *
 * Strategy:
 * 1. With Fintuition (nextPosition) → score cards against exact next cell
 * 2. Without Fintuition → detect movement pattern, predict next cells
 * 3. Play the highest-scoring card (crit > hit > best coverage)
 * 4. If nothing covers predicted cells → lowest miss penalty
 */
export function pickBestCard(
  hand: number[],
  deckCardData: FishingCard[],
  fishPosition: number[],
  previousFishPosition?: number[],
  nextPosition?: number[] | null,
  grid: GridDims = DEFAULT_GRID
): { handIndex: number; reason: string } {
  if (hand.length === 0) {
    return { handIndex: 0, reason: "No cards in hand" };
  }

  const scores = scoreHand(hand, deckCardData, fishPosition, previousFishPosition, nextPosition, grid);
  const best = scores.reduce((a, b) => (b.ev > a.ev ? b : a));
  return { handIndex: best.handIdx, reason: best.reason };
}

/**
 * Returns true when the hand has no realistic hit — every card's chance of
 * hitting the fish's next cell is below 20%. Signals a redraw would help
 * (costs 1 mana per remaining card).
 *
 * All position params are API [col, row] coordinates.
 */
export function shouldRedraw(
  hand: number[],
  deckCardData: FishingCard[],
  fishPosition: number[],
  previousFishPosition?: number[],
  nextPosition?: number[] | null,
  grid: GridDims = DEFAULT_GRID
): boolean {
  const scores = scoreHand(hand, deckCardData, fishPosition, previousFishPosition, nextPosition, grid);
  return scores.every((s) => s.pHit < 0.2);
}

/**
 * Analyze what fraction of the pond is covered by the current hand.
 */
export function handCoverage(
  hand: number[],
  deckCardData: FishingCard[],
  grid: GridDims = DEFAULT_GRID
): { coveredPositions: number[]; coverage: number } {
  const cardLookup = new Map<number, FishingCard>();
  for (const c of deckCardData) cardLookup.set(c.id, c);

  const covered = new Set<number>();
  for (const cardId of hand) {
    const card = cardLookup.get(cardId);
    if (!card) continue;
    for (const z of card.hitZones) covered.add(z);
  }

  const coveredPositions = Array.from(covered).sort((a, b) => a - b);
  return { coveredPositions, coverage: coveredPositions.length / (grid.cols * grid.rows) };
}

/* ─── Dendren Grove: lure-anchored play ───────────────────────
   The Grove is a different game from the classic ponds and does not share
   their coordinate model. Verified from live casts on 2026-08-10:

   - Positions are [row, col], both 1-based.
   - Cards are 3x3 stamps centred on the lure, NOT board addresses. Zone 5 is
     the lure itself; zone = (dRow + 1) * 3 + (dCol + 1) + 1. A fish further
     than one cell from the lure in either axis cannot be hit by any card.
   - The lure move is committed by `play_cards` through its focusPoint field,
     and costs one focus per cell of Manhattan distance out of a 3-point budget.
   - Movement is one orthogonal step per card and never reverses, but is
     otherwise unpredictable: patternIndex reads 0 always and selects nothing.

   Everything here is gated on focusMechanicEnabled so the classic ponds keep
   their existing board-cell path untouched.
   ──────────────────────────────────────────────────────────── */

/** Offset from the lure to a 1-9 card zone, or null when out of reach. */
export function focusZone(pos: number[], focus: number[]): number | null {
  if (pos.length !== 2 || focus.length !== 2) return null;
  const dRow = pos[0] - focus[0];
  const dCol = pos[1] - focus[1];
  if (Math.abs(dRow) > 1 || Math.abs(dCol) > 1) return null;
  return (dRow + 1) * 3 + (dCol + 1) + 1;
}

function onBoard(pos: number[], gridSize: number): boolean {
  return pos[0] >= 1 && pos[0] <= gridSize && pos[1] >= 1 && pos[1] <= gridSize;
}

function orthogonalCoords(pos: number[], gridSize: number): number[][] {
  return [
    [pos[0] - 1, pos[1]], [pos[0] + 1, pos[1]],
    [pos[0], pos[1] - 1], [pos[0], pos[1] + 1],
  ].filter((p) => onBoard(p, gridSize));
}

/**
 * Where the fish will be when the card resolves, in [row, col] space.
 *
 * Cards land after the fish moves, so this is what matters — never the cell it
 * currently occupies. Fintuition states the answer outright.
 *
 * Otherwise it is an even spread over the adjacent cells, minus the one the
 * fish came from. That is the whole model, and it is deliberately this dumb:
 * across 21 probe transitions on 2026-08-10, every single move went to an
 * orthogonal neighbour, and not one of eighteen opportunities was a reversal.
 *
 * An earlier version extrapolated the current direction at 85% confidence. The
 * probe scored that at 20% — the fish continued straight only 3 times in 15 —
 * against roughly 33% for guessing evenly among neighbours. Momentum was worse
 * than no opinion at all, so it is gone, along with the patternIndex it keyed
 * off: that field read 0 on all 27 observations and selects nothing.
 *
 * The same sample leaned clockwise (11) over counterclockwise (7). That is well
 * inside noise at this size, so it is deliberately not encoded.
 */
export function predictGroveCoords(
  fish: number[],
  previous: number[] | undefined,
  gridSize: number,
  nextPosition?: number[] | null
): { coord: number[]; p: number }[] {
  if (nextPosition && nextPosition.length === 2) return [{ coord: nextPosition, p: 1 }];
  if (!fish || fish.length !== 2) return [];

  const neighbours = orthogonalCoords(fish, gridSize);
  if (!neighbours.length) return [];

  const forward =
    previous && previous.length === 2
      ? neighbours.filter((p) => !(p[0] === previous[0] && p[1] === previous[1]))
      : neighbours;
  // At the very start of a cast previous equals current, which would strip
  // nothing; if a filter ever empties the pool, fall back to all neighbours.
  const pool = forward.length ? forward : neighbours;
  const even = 1 / pool.length;
  return pool.map((coord) => ({ coord, p: even }));
}

export interface GroveMove {
  /** Index into the hand — the wire field is positional, not a card ID */
  handIndex: number;
  /** Lure position to send with the play; may be where it already is */
  focusPoint: number[];
  focusCost: number;
  /** Expected value of the chosen play, for logging and redraw comparison */
  ev: number;
  pHit: number;
  /** True when every reachable play is a guaranteed miss and mana allows a redraw */
  redraw: boolean;
  reason: string;
}

export interface GroveCardScore {
  handIndex: number;
  cardId: number;
  card: FishingCard | null;
  /** Best lure position for this card, of the ones the focus meter can reach */
  focusPoint: number[];
  focusCost: number;
  ev: number;
  pHit: number;
  pCrit: number;
  /** False when the card costs more mana than is left */
  playable: boolean;
  reason: string;
}

export interface GroveState {
  hand: number[];
  deckCardData: FishingCard[];
  fishPosition: number[];
  previousFishPosition?: number[];
  nextPosition?: number[] | null;
  focusPoint?: number[];
  focusMeter?: number;
  gridSize?: number;
  playerHp?: number;
}

/**
 * Score every card in hand the way the Grove actually resolves them.
 *
 * Shared by the auto-player and the hand UI, so the "BEST" badge names the card
 * auto-fish would play. It previously used the classic board-address scorer
 * here, which reads a card's hitZones as cells on the pond — in the Grove they
 * are offsets from the lure, so the badge and the bot disagreed on every hand.
 *
 * Each card is scored at its own best affordable lure position, because the
 * lure can only be in one place and which place is best depends on the card.
 */
export function scoreGroveHand(gd: GroveState): GroveCardScore[] {
  const gridSize = gd.gridSize;
  const focus = gd.focusPoint;
  if (typeof gridSize !== "number" || gridSize < 1) return [];
  if (!Array.isArray(focus) || focus.length !== 2) return [];

  const budget = gd.focusMeter ?? 0;
  const mana = gd.playerHp ?? 0;
  const targets = predictGroveCoords(
    gd.fishPosition, gd.previousFishPosition, gridSize, gd.nextPosition
  );
  const cards = new Map(gd.deckCardData.map((c) => [c.id, c]));

  return (gd.hand ?? []).map((cardId, handIndex) => {
    const card = cards.get(cardId);
    if (!card) {
      return {
        handIndex, cardId, card: null, focusPoint: focus, focusCost: 0,
        ev: -Infinity, pHit: 0, pCrit: 0, playable: false, reason: "unknown card",
      };
    }

    const hitDmg = card.hitEffects.reduce((s, e) => s + e.amount, 0);
    const critDmg = card.critEffects.reduce((s, e) => s + e.amount, 0);
    const missPenalty = card.missEffects.reduce((s, e) => s + Math.abs(e.amount), 0);

    let best: { ev: number; pHit: number; pCrit: number; lure: number[]; cost: number } | null = null;
    for (let row = 1; row <= gridSize; row++) {
      for (let col = 1; col <= gridSize; col++) {
        const cost = Math.abs(row - focus[0]) + Math.abs(col - focus[1]);
        if (cost > budget) continue;
        const lure = [row, col];

        let pHit = 0;
        let pCrit = 0;
        for (const t of targets) {
          const zone = focusZone(t.coord, lure);
          if (zone === null) continue;
          if (card.hitZones.includes(zone)) {
            pHit += t.p;
            if (card.critZones.includes(zone)) pCrit += t.p;
          }
        }
        const ev =
          pHit * hitDmg + pCrit * critDmg - (1 - pHit) * missPenalty - card.manaCost * MANA_WEIGHT;

        // Focus is a budget for the whole cast, not this play. Two options that
        // score the same are not equal: the cheaper one leaves the lure able to
        // chase the fish later, and the fish moves every single turn. Without
        // this the first-found option won and quietly burned the meter.
        const better =
          !best || ev > best.ev + 1e-9 || (Math.abs(ev - best.ev) <= 1e-9 && cost < best.cost);
        if (better) best = { ev, pHit, pCrit, lure, cost };
      }
    }

    if (!best) {
      return {
        handIndex, cardId, card, focusPoint: focus, focusCost: 0,
        ev: -Infinity, pHit: 0, pCrit: 0, playable: false, reason: "no reachable lure position",
      };
    }

    const playable = card.manaCost <= mana;
    const moved =
      best.cost > 0 ? `lure ${focus.join(",")}->${best.lure.join(",")} (-${best.cost} focus), ` : "";
    return {
      handIndex,
      cardId,
      card,
      focusPoint: best.lure,
      focusCost: best.cost,
      ev: best.ev,
      pHit: best.pHit,
      pCrit: best.pCrit,
      playable,
      reason: playable
        ? `${moved}card #${card.id} ${Math.round(best.pHit * 100)}% hit, EV ${best.ev.toFixed(1)}`
        : `card #${card.id} needs ${card.manaCost} mana, ${mana} left`,
    };
  });
}

/**
 * Choose a card and a lure position together.
 *
 * They cannot be decided separately: a card is only worth playing if the lure
 * puts the fish inside its stamp, and the lure is only worth moving if a card
 * covers where the fish is going. So every affordable lure position is scored
 * against every card in hand.
 */
export function pickGroveMove(gd: GroveState): GroveMove | null {
  if (!gd.hand?.length) return null;

  // No board, no move. This used to default to 4, which is the Grove's size and
  // nothing else's — on any other lure-anchored pond it would silently score
  // every card against the wrong board and still return a confident answer.
  // gridSize is on every live game state, so an absent one means the caller
  // passed the wrong object, not that the pond is 4x4. Likewise the lure:
  // [2,2] is the centre of a 3x3 and off-centre on a 4x4, and the server always
  // states where the lure is. scoreGroveHand returns nothing without both.
  const scores = scoreGroveHand(gd).filter((s) => s.playable && s.card);
  if (!scores.length) return null;

  const mana = gd.playerHp ?? 0;
  const top = scores.reduce((a, b) =>
    b.ev > a.ev + 1e-9 || (Math.abs(b.ev - a.ev) <= 1e-9 && b.focusCost < a.focusCost) ? b : a
  );
  const best: GroveMove = {
    handIndex: top.handIndex,
    focusPoint: top.focusPoint,
    focusCost: top.focusCost,
    ev: top.ev,
    pHit: top.pHit,
    redraw: false,
    reason: top.reason,
  };

  // The best available play is barely better than a coin toss on the fish
  // deviating. Since the prediction is hedged rather than absolute, a "dead"
  // position still scores a few percent, so this compares against the same 20%
  // bar shouldRedraw uses rather than against zero — which a hedged
  // distribution would essentially never reach.
  //
  // Redrawing costs one mana per card held, so it only pays with enough mana
  // left over to actually swing afterwards.
  if (best.pHit < REDRAW_THRESHOLD && mana >= gd.hand.length + 1) {
    return {
      ...best,
      redraw: true,
      reason: `best shot is only ${Math.round(best.pHit * 100)}% from any affordable lure spot — redraw (${gd.hand.length} mana)`,
    };
  }

  return best;
}
