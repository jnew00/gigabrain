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
 * Takes cell IDs (1-9), returns cells with NORMALIZED probabilities
 * (sums to 1), most likely first.
 */
export function predictNextPositionsWeighted(
  currentCell: number,
  previousCell: number,
): { cell: number; p: number }[] {
  if (!currentCell) {
    return Array.from({ length: 9 }, (_, i) => ({ cell: i + 1, p: 1 / 9 }));
  }

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

  const total = Array.from(posScores.values()).reduce((s, v) => s + v, 0);
  if (total <= 0) {
    return Array.from({ length: 9 }, (_, i) => ({ cell: i + 1, p: 1 / 9 }));
  }
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
): number[] {
  return predictNextPositionsWeighted(currentCell, previousCell).map((e) => e.cell);
}

/* ─── Card Scoring ─────────────────────────────────────────── */

/** Mana is the cast's limiting resource — trade ~this much damage per mana */
const MANA_WEIGHT = 0.35;

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
  nextPosition?: number[] | null
): CardScore[] {
  const cardLookup = new Map<number, FishingCard>();
  for (const c of deckCardData) cardLookup.set(c.id, c);

  const currentCell = coordToCell(fishPosition);
  const prevCell = previousFishPosition ? coordToCell(previousFishPosition) : 0;

  const hasFintuition = nextPosition && nextPosition.length === 2;
  const targets: { cell: number; p: number }[] = hasFintuition
    ? [{ cell: coordToCell(nextPosition), p: 1 }]
    : predictNextPositionsWeighted(currentCell, prevCell);

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
  nextPosition?: number[] | null
): { handIndex: number; reason: string } {
  if (hand.length === 0) {
    return { handIndex: 0, reason: "No cards in hand" };
  }

  const scores = scoreHand(hand, deckCardData, fishPosition, previousFishPosition, nextPosition);
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
  nextPosition?: number[] | null
): boolean {
  const scores = scoreHand(hand, deckCardData, fishPosition, previousFishPosition, nextPosition);
  return scores.every((s) => s.pHit < 0.2);
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
