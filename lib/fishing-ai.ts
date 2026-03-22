import type { FishingCard } from "./types";

/* ─── 3x3 Grid Layout ────────────────────────────────────────
   Cell IDs:
   1 2 3
   4 5 6
   7 8 9

   API coordinates are [col, row] where col=1-3, row=1-3
   row 1 = top, row 3 = bottom
   ──────────────────────────────────────────────────────────── */

/** Convert API [col, row] coordinate to cell ID (1-9) */
export function coordToCell(coord: number[]): number {
  if (coord.length !== 2) return 0;
  const [col, row] = coord;
  return (row - 1) * 3 + col;
}

const POS_ROW: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 2, 8: 2, 9: 2 };
const POS_COL: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 0, 5: 1, 6: 2, 7: 0, 8: 1, 9: 2 };

/* ─── Movement Pattern Detection ──────────────────────────── */

// Fish follow one of 3 deterministic patterns per encounter:
// 1. Orthogonal: moves 1 cell up/down/left/right (never diagonal)
// 2. Diagonal:   moves diagonally (like a chess bishop)
// 3. Plus/Cross: stays on the cross cells (2,4,5,6,8)

type MovementPattern = "orthogonal" | "diagonal" | "plus";

const CROSS_CELLS = new Set([2, 4, 5, 6, 8]);

/** Orthogonal neighbors (up/down/left/right, 1 step) */
function orthogonalNeighbors(pos: number): number[] {
  const r = POS_ROW[pos], c = POS_COL[pos];
  const result: number[] = [];
  for (let p = 1; p <= 9; p++) {
    const dr = Math.abs(POS_ROW[p] - r);
    const dc = Math.abs(POS_COL[p] - c);
    if ((dr + dc) === 1) result.push(p);
  }
  return result;
}

/** Diagonal neighbors (1 step diagonally) */
function diagonalNeighbors(pos: number): number[] {
  const r = POS_ROW[pos], c = POS_COL[pos];
  const result: number[] = [];
  for (let p = 1; p <= 9; p++) {
    const dr = Math.abs(POS_ROW[p] - r);
    const dc = Math.abs(POS_COL[p] - c);
    if (dr === 1 && dc === 1) result.push(p);
  }
  return result;
}

/** Plus/cross pattern neighbors: orthogonal moves but constrained to cross cells */
function plusNeighbors(pos: number): number[] {
  return orthogonalNeighbors(pos).filter((p) => CROSS_CELLS.has(p));
}

/** Get reachable positions for a given pattern */
function getReachableForPattern(cell: number, pattern: MovementPattern): number[] {
  const neighborFn =
    pattern === "orthogonal" ? orthogonalNeighbors :
    pattern === "diagonal" ? diagonalNeighbors :
    plusNeighbors;
  return neighborFn(cell).filter((n) => n !== cell);
}

/**
 * Detect which movement pattern the fish is likely following based on
 * observed movement from previousPosition → currentPosition.
 * Returns a weight map (higher = more likely).
 */
function detectPatternWeights(
  prevCell: number,
  currCell: number
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

  const dr = POS_ROW[currCell] - POS_ROW[prevCell];
  const dc = POS_COL[currCell] - POS_COL[prevCell];
  const absDr = Math.abs(dr);
  const absDc = Math.abs(dc);

  // Orthogonal move (exactly 1 step in cardinal direction)
  if ((absDr + absDc) === 1) {
    weights.orthogonal = 5;
    weights.diagonal = 0.1;
    // Plus pattern also moves orthogonally, but only on cross cells
    if (CROSS_CELLS.has(prevCell) && CROSS_CELLS.has(currCell)) {
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
 * Takes cell IDs (1-9), returns cell IDs sorted by likelihood (most likely first).
 */
export function predictNextPositions(
  currentCell: number,
  previousCell: number,
): number[] {
  if (!currentCell) return [1, 2, 3, 4, 5, 6, 7, 8, 9];

  const weights = detectPatternWeights(previousCell, currentCell);

  // Score each potential next position by summing pattern weights
  const posScores = new Map<number, number>();
  const patterns: MovementPattern[] = ["orthogonal", "diagonal", "plus"];

  for (const pattern of patterns) {
    const w = weights[pattern];
    if (w <= 0) continue;
    const reachable = getReachableForPattern(currentCell, pattern);
    for (const pos of reachable) {
      posScores.set(pos, (posScores.get(pos) ?? 0) + w);
    }
  }

  // Apply momentum bonus
  if (previousCell && previousCell !== currentCell) {
    const dr = POS_ROW[currentCell] - POS_ROW[previousCell];
    const dc = POS_COL[currentCell] - POS_COL[previousCell];
    if (dr !== 0 || dc !== 0) {
      const nextR = POS_ROW[currentCell] + dr;
      const nextC = POS_COL[currentCell] + dc;
      for (let p = 1; p <= 9; p++) {
        if (POS_ROW[p] === nextR && POS_COL[p] === nextC) {
          posScores.set(p, (posScores.get(p) ?? 0) + 2);
          break;
        }
      }
    }
  }

  // Sort by score descending
  return Array.from(posScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([pos]) => pos);
}

/* ─── Card Scoring ─────────────────────────────────────────── */

/**
 * Score a card against TARGET cell IDs (where the fish is expected to be).
 * Cards resolve AFTER the fish moves, so we score against predicted/Fintuition
 * positions, not where the fish currently sits.
 */
function scoreCard(
  card: FishingCard,
  targetCells: number[]
): { score: number; isHit: boolean; isCrit: boolean; hitDmg: number; missPenalty: number; critDmg: number; coverageCount: number } {
  const isHit = card.hitZones.some((z) => targetCells.includes(z));
  const isCrit = isHit && card.critZones.some((z) => targetCells.includes(z));

  const hitDmg = card.hitEffects.reduce((sum, e) => sum + e.amount, 0);
  const missPenalty = card.missEffects.reduce((sum, e) => sum + Math.abs(e.amount), 0);
  const critDmg = card.critEffects.reduce((sum, e) => sum + e.amount, 0);

  const coverageCount = card.hitZones.filter((z) => targetCells.includes(z)).length;
  const critCount = card.critZones.filter((z) => targetCells.includes(z)).length;

  let score: number;
  if (isHit) {
    score = hitDmg + (isCrit ? critDmg : 0) + coverageCount * 0.5 + critCount * 0.3;
  } else {
    score = -missPenalty;
  }

  return { score, isHit, isCrit, hitDmg, missPenalty, critDmg, coverageCount };
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
  nextPosition?: number[] | null
): { handIndex: number; reason: string } {
  if (hand.length === 0) {
    return { handIndex: 0, reason: "No cards in hand" };
  }

  const cardLookup = new Map<number, FishingCard>();
  for (const c of deckCardData) {
    cardLookup.set(c.id, c);
  }

  // Convert API coordinates to cell IDs
  const currentCell = coordToCell(fishPosition);
  const prevCell = previousFishPosition ? coordToCell(previousFishPosition) : 0;

  // Determine target cells — where the fish is GOING
  const hasFintuition = nextPosition && nextPosition.length === 2;
  const targetCells = hasFintuition
    ? [coordToCell(nextPosition)]
    : predictNextPositions(currentCell, prevCell);

  // Score all cards against target cells
  const scores = hand.map((cardId, i) => {
    const card = cardLookup.get(cardId);
    if (!card) return { index: i, cardId, score: -Infinity, reason: "unknown card", isHit: false };

    const result = scoreCard(card, targetCells);
    const source = hasFintuition ? "Fintuition" : "predicted";
    let reason: string;
    if (result.isCrit) {
      reason = `${source} CRIT #${cardId} (${result.hitDmg}+${result.critDmg} dmg)`;
    } else if (result.isHit) {
      reason = `${source} HIT #${cardId} (${result.hitDmg} dmg, covers ${result.coverageCount}/${targetCells.length})`;
    } else {
      reason = `MISS #${cardId} (-${result.missPenalty} mana)`;
    }
    return { index: i, cardId, score: result.score, reason, isHit: result.isHit };
  });

  // Play the highest-scoring card
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
  return { handIndex: best.index, reason: best.reason };
}

/**
 * Returns true if no card in hand can hit any of the predicted next cells.
 * This means we should redraw the hand (costs 1 mana per card).
 *
 * All position params are API [col, row] coordinates.
 */
export function shouldRedraw(
  hand: number[],
  deckCardData: FishingCard[],
  fishPosition: number[],
  previousFishPosition?: number[],
  nextPosition?: number[] | null
): boolean {
  const cardLookup = new Map<number, FishingCard>();
  for (const c of deckCardData) cardLookup.set(c.id, c);

  const currentCell = coordToCell(fishPosition);
  const prevCell = previousFishPosition ? coordToCell(previousFishPosition) : 0;
  const hasFintuition = nextPosition && nextPosition.length === 2;
  const targetCells = hasFintuition
    ? [coordToCell(nextPosition)]
    : predictNextPositions(currentCell, prevCell);

  for (const cardId of hand) {
    const card = cardLookup.get(cardId);
    if (!card) continue;
    if (card.hitZones.some((z) => targetCells.includes(z))) return false;
  }
  return true;
}

/**
 * Analyze what percentage of the 3x3 grid is covered by the current hand.
 */
export function handCoverage(
  hand: number[],
  deckCardData: FishingCard[]
): { coveredPositions: number[]; coverage: number } {
  const cardLookup = new Map<number, FishingCard>();
  for (const c of deckCardData) cardLookup.set(c.id, c);

  const covered = new Set<number>();
  for (const cardId of hand) {
    const card = cardLookup.get(cardId);
    if (!card) continue;
    for (const z of card.hitZones) covered.add(z);
  }

  const coveredPositions = Array.from(covered).sort();
  return { coveredPositions, coverage: coveredPositions.length / 9 };
}
