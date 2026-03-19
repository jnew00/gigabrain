// Enemy move tracker — pure functions that operate on in-memory records
// Persistence is handled by SQLite via server actions

export interface EnemyMoveRecord {
  enemyId: number;      // ENEMY_CID from entity
  roomNum: number;      // ROOM_NUM_CID
  dungeonId: number;    // DUNGEON_ID_CID
  level: number;        // LEVEL_CID
  move: string;         // rock/paper/scissor
  round: number;        // which round of the fight (0-indexed)
  timestamp: number;
}

export interface EnemyProfile {
  enemyId: number;
  roomNum: number;
  totalMoves: number;
  moveCounts: { rock: number; paper: number; scissor: number };
  moveFreq: { rock: number; paper: number; scissor: number };
  roundMoves: Record<number, { rock: number; paper: number; scissor: number }>;
  predictedMove: string | null;
  confidence: number;
}

const LS_KEY = "giga-enemy-moves";

/** Load records from localStorage (for migration to SQLite) */
export function loadLocalStorageRecords(): EnemyMoveRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Clear localStorage after successful migration */
export function clearLocalStorageRecords() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(LS_KEY);
}

/**
 * Infer an enemy's preferred move from their base stats array.
 * Array layout (assumed): [rockATK, rockDEF, paperATK, paperDEF, scissorATK, scissorDEF, ...]
 * Returns the move with highest ATK as a weak prediction.
 */
export function predictFromBaseStats(
  baseStats: number[]
): { move: string | null; confidence: number } {
  if (!baseStats || baseStats.length < 6) return { move: null, confidence: 0 };

  const moves: { move: string; atk: number }[] = [
    { move: "rock", atk: baseStats[0] },
    { move: "paper", atk: baseStats[2] },
    { move: "scissor", atk: baseStats[4] },
  ];

  moves.sort((a, b) => b.atk - a.atk);

  // If one move clearly dominates (>= 2 ATK higher), predict it with low confidence
  if (moves[0].atk > moves[1].atk) {
    return { move: moves[0].move, confidence: 0.35 };
  }

  // Stats are equal — no useful prediction
  return { move: null, confidence: 0 };
}

/** Predict what an enemy will play on a given round */
export function predictEnemyMove(
  records: EnemyMoveRecord[],
  enemyId: number,
  roomNum: number,
  currentRound: number,
  dungeonId?: number,
  baseStats?: number[]
): { move: string | null; confidence: number } {
  // Filter by enemy + room; if dungeonId provided, prefer same-dungeon data
  let filtered = records.filter(
    (r) => r.enemyId === enemyId && (roomNum < 0 || r.roomNum === roomNum)
  );

  // If we have dungeon-specific data, use it; fall back to cross-dungeon if too few records
  if (dungeonId !== undefined) {
    const dungeonFiltered = filtered.filter((r) => r.dungeonId === dungeonId);
    if (dungeonFiltered.length >= 3) {
      filtered = dungeonFiltered;
    }
  }

  // No historical data — fall back to base stats prediction
  if (filtered.length === 0) {
    if (baseStats) return predictFromBaseStats(baseStats);
    return { move: null, confidence: 0 };
  }

  // First try: same enemy, same round number
  const roundRecords = filtered.filter((r) => r.round === currentRound);
  if (roundRecords.length >= 3) {
    const counts = { rock: 0, paper: 0, scissor: 0 };
    for (const r of roundRecords) {
      if (r.move in counts) counts[r.move as keyof typeof counts]++;
    }
    const total = roundRecords.length;
    const best = (Object.entries(counts) as [string, number][]).sort(
      (a, b) => b[1] - a[1]
    )[0];
    const confidence = best[1] / total;

    if (confidence > 0.5) {
      return { move: best[0], confidence };
    }
  }

  // Fallback: overall frequency for this enemy
  const counts = { rock: 0, paper: 0, scissor: 0 };
  for (const r of filtered) {
    if (r.move in counts) counts[r.move as keyof typeof counts]++;
  }
  const total = filtered.length;
  if (total === 0) return { move: null, confidence: 0 };

  const best = (Object.entries(counts) as [string, number][]).sort(
    (a, b) => b[1] - a[1]
  )[0];
  return { move: best[0], confidence: best[1] / total };
}

/** Get stats from in-memory records */
export function getTrackerStats(records: EnemyMoveRecord[]): { totalRecords: number; uniqueEnemies: number } {
  const uniqueEnemies = new Set(records.map((r) => r.enemyId)).size;
  return { totalRecords: records.length, uniqueEnemies };
}

/** Get all enemy profiles from in-memory records */
export function getAllEnemyProfiles(records: EnemyMoveRecord[]): EnemyProfile[] {
  const byEnemy = new Map<number, EnemyMoveRecord[]>();

  for (const r of records) {
    const existing = byEnemy.get(r.enemyId) || [];
    existing.push(r);
    byEnemy.set(r.enemyId, existing);
  }

  return Array.from(byEnemy.entries()).map(([enemyId, recs]) =>
    buildProfile(recs, enemyId, -1)
  );
}

function buildProfile(
  records: EnemyMoveRecord[],
  enemyId: number,
  roomNum: number
): EnemyProfile {
  const counts = { rock: 0, paper: 0, scissor: 0 };
  const roundMoves: Record<number, { rock: number; paper: number; scissor: number }> = {};

  for (const r of records) {
    if (r.move in counts) counts[r.move as keyof typeof counts]++;

    if (!roundMoves[r.round]) {
      roundMoves[r.round] = { rock: 0, paper: 0, scissor: 0 };
    }
    if (r.move in roundMoves[r.round]) {
      roundMoves[r.round][r.move as keyof typeof counts]++;
    }
  }

  const total = records.length || 1;
  const moveFreq = {
    rock: counts.rock / total,
    paper: counts.paper / total,
    scissor: counts.scissor / total,
  };

  const best = (Object.entries(counts) as [string, number][]).sort(
    (a, b) => b[1] - a[1]
  )[0];

  return {
    enemyId,
    roomNum,
    totalMoves: records.length,
    moveCounts: counts,
    moveFreq,
    roundMoves,
    predictedMove: records.length >= 3 ? best[0] : null,
    confidence: records.length >= 3 ? best[1] / total : 0,
  };
}
