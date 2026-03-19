import type { FishingCard } from "./types";

/* ─── 3x3 Grid Adjacency ──────────────────────────────────── */

// Grid layout:
// 1 2 3
// 4 5 6
// 7 8 9

// Row/col for each position
const POS_ROW: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 2, 8: 2, 9: 2 };
const POS_COL: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 0, 5: 1, 6: 2, 7: 0, 8: 1, 9: 2 };

/** Get all positions reachable from `pos` within `distance` steps (Manhattan distance) */
function getReachable(pos: number, distance: number): number[] {
  const r = POS_ROW[pos], c = POS_COL[pos];
  const result: number[] = [];
  for (let p = 1; p <= 9; p++) {
    const dr = Math.abs(POS_ROW[p] - r);
    const dc = Math.abs(POS_COL[p] - c);
    // Manhattan distance, but fish likely moves in grid steps (adjacent including diagonal)
    // Chebyshev distance (king moves) is more appropriate for grid movement
    if (Math.max(dr, dc) <= distance && p !== pos) {
      result.push(p);
    }
  }
  return result;
}

/** Predict likely next positions based on current + previous position and move distance */
export function predictNextPositions(
  fishPosition: number[],
  previousFishPosition: number[],
  moveDistance: number = 1
): number[] {
  if (fishPosition.length === 0) return [1, 2, 3, 4, 5, 6, 7, 8, 9];

  // Get all reachable from each current fish position
  const reachable = new Set<number>();
  for (const pos of fishPosition) {
    for (const r of getReachable(pos, moveDistance)) {
      reachable.add(r);
    }
  }

  // If we have previous position, the fish tends to continue in the same direction
  // (momentum heuristic) — weight those positions higher
  if (previousFishPosition.length > 0 && fishPosition.length > 0) {
    const dr = POS_ROW[fishPosition[0]] - POS_ROW[previousFishPosition[0]];
    const dc = POS_COL[fishPosition[0]] - POS_COL[previousFishPosition[0]];
    if (dr !== 0 || dc !== 0) {
      // Project momentum: where would it go if continuing same direction?
      const nextR = POS_ROW[fishPosition[0]] + dr;
      const nextC = POS_COL[fishPosition[0]] + dc;
      // Find the position at that row/col
      for (let p = 1; p <= 9; p++) {
        if (POS_ROW[p] === nextR && POS_COL[p] === nextC) {
          // Return momentum position first (highest priority)
          const others = Array.from(reachable).filter((r) => r !== p);
          return [p, ...others];
        }
      }
    }
  }

  return Array.from(reachable);
}

/* ─── Card Scoring ─────────────────────────────────────────── */

function scoreCard(
  card: FishingCard,
  fishPosition: number[]
): { score: number; isHit: boolean; isCrit: boolean; hitDmg: number; missPenalty: number; critDmg: number } {
  const isHit = card.hitZones.some((z) => fishPosition.includes(z));
  const isCrit = isHit && card.critZones.some((z) => fishPosition.includes(z));

  const hitDmg = card.hitEffects.reduce((sum, e) => sum + e.amount, 0);
  const missPenalty = card.missEffects.reduce((sum, e) => sum + Math.abs(e.amount), 0);
  const critDmg = card.critEffects.reduce((sum, e) => sum + e.amount, 0);

  let score: number;
  if (isHit) {
    score = hitDmg + (isCrit ? critDmg : 0);
  } else {
    score = -missPenalty;
  }

  return { score, isHit, isCrit, hitDmg, missPenalty, critDmg };
}

/**
 * Score a card considering both current fish position AND predicted next positions.
 * When the card misses the current position, we factor in how likely it is to hit
 * the fish's next position (since the fish moves after we play).
 */
function scoreCardWithPrediction(
  card: FishingCard,
  fishPosition: number[],
  predictedPositions: number[]
): { score: number; isHit: boolean; isCrit: boolean; hitDmg: number; missPenalty: number; critDmg: number; futureHitChance: number } {
  const base = scoreCard(card, fishPosition);

  // If it's already a hit, no need for prediction
  if (base.isHit) {
    return { ...base, futureHitChance: 1 };
  }

  // Card misses current position — how well does it cover predicted next positions?
  // This matters because the fish moves AFTER we play, and our card resolves against
  // the NEW position. Wait — actually from the API, the card resolves against the
  // position AT TIME OF PLAY. The fish moves as a separate event.
  // So prediction helps us decide: if we must miss now, pick the card that's most
  // likely to hit NEXT round (since it'll be drawn again or similar cards remain).
  //
  // But more practically: when ALL cards miss, pick the one with:
  // 1. Lowest miss penalty (least damage to us)
  // 2. Best coverage of predicted positions (tiebreaker for future value)
  const futureHits = predictedPositions.filter((p) => card.hitZones.includes(p)).length;
  const futureHitChance = predictedPositions.length > 0 ? futureHits / predictedPositions.length : 0;

  // Adjust score: less penalty if card covers future positions well
  // (small bonus, doesn't override "lowest penalty" priority)
  return {
    ...base,
    score: base.score + futureHitChance * 0.5,
    futureHitChance,
  };
}

/* ─── Main Exports ─────────────────────────────────────────── */

/**
 * Pick the best card from hand given fish position, movement history, and Fintuition data.
 *
 * Strategy:
 * 1. If any card CRITS current position → play it
 * 2. If any card HITS current position → play highest damage
 * 3. If ALL miss current position BUT Fintuition reveals nextPosition:
 *    → pick the card that HITS the next position (fish moves there after we play)
 * 4. If all miss and no Fintuition → lowest miss penalty, tiebreak by predicted coverage
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

  // Use Fintuition's nextPosition if available, otherwise predict from movement
  const fintuitionPos = nextPosition && nextPosition.length > 0 ? nextPosition : null;
  const predicted = fintuitionPos
    ?? (previousFishPosition ? predictNextPositions(fishPosition, previousFishPosition) : []);

  // First pass: score all cards against CURRENT fish position
  const scores = hand.map((cardId, i) => {
    const card = cardLookup.get(cardId);
    if (!card) return { index: i, cardId, score: -Infinity, reason: "unknown card", isHit: false };
    const result = scoreCardWithPrediction(card, fishPosition, predicted);
    let reason: string;
    if (result.isCrit) {
      reason = `CRIT #${cardId} (${result.hitDmg}+${result.critDmg} dmg)`;
    } else if (result.isHit) {
      reason = `HIT #${cardId} (${result.hitDmg} dmg)`;
    } else {
      reason = `MISS #${cardId} (-${result.missPenalty})`;
    }
    return { index: i, cardId, score: result.score, reason, isHit: result.isHit };
  });

  // Check if any card hits current position
  const anyHit = scores.some((s) => s.isHit);

  if (anyHit) {
    // Play the best hitting card
    const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
    return { handIndex: best.index, reason: best.reason };
  }

  // No card hits current position — use Fintuition if available
  if (fintuitionPos) {
    // Score cards against the NEXT position (Fintuition tells us exactly where fish goes)
    let bestFutureIndex = 0;
    let bestFutureScore = -Infinity;
    let bestFutureReason = "";

    for (let i = 0; i < hand.length; i++) {
      const card = cardLookup.get(hand[i]);
      if (!card) continue;
      const futureResult = scoreCard(card, fintuitionPos);
      if (futureResult.isHit && futureResult.score > bestFutureScore) {
        bestFutureScore = futureResult.score;
        bestFutureIndex = i;
        bestFutureReason = futureResult.isCrit
          ? `Fintuition CRIT #${hand[i]} → fish moving to [${fintuitionPos}] (${futureResult.hitDmg}+${futureResult.critDmg} dmg)`
          : `Fintuition HIT #${hand[i]} → fish moving to [${fintuitionPos}] (${futureResult.hitDmg} dmg)`;
      }
    }

    // If a card can hit the next position, that's a strategic miss now for a guaranteed hit next
    // But wait — the card resolves against current position, not next. So playing a card that
    // covers nextPosition means it will miss NOW but we're choosing the "best miss".
    // Actually, we should just pick lowest penalty miss since the card resolves against current pos.
    // The Fintuition value is: if we must miss, pick the miss card that also covers next pos,
    // so when fish moves there and we draw a similar card, we're set up.
    // More importantly: if ALL cards miss, just pick lowest penalty.
    // Fintuition's real value is knowing the next position for the NEXT card play.
    if (bestFutureScore > 0) {
      // There's a card that covers the next position — prefer it as tiebreaker
      // but still prioritize lowest miss penalty
      const lowestPenalty = scores.reduce((a, b) => (b.score > a.score ? b : a));
      // If the future-covering card has similar penalty, prefer it
      const futureCard = scores[bestFutureIndex];
      if (futureCard && Math.abs(futureCard.score - lowestPenalty.score) <= 1) {
        return { handIndex: bestFutureIndex, reason: bestFutureReason };
      }
    }
  }

  // All miss, no useful Fintuition — pick lowest penalty
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
  return { handIndex: best.index, reason: best.reason };
}

/**
 * Returns true if no card in hand can hit the fish at its current position.
 */
export function shouldRedraw(
  hand: number[],
  deckCardData: FishingCard[],
  fishPosition: number[]
): boolean {
  const cardLookup = new Map<number, FishingCard>();
  for (const c of deckCardData) cardLookup.set(c.id, c);

  for (const cardId of hand) {
    const card = cardLookup.get(cardId);
    if (!card) continue;
    if (card.hitZones.some((z) => fishPosition.includes(z))) return false;
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
