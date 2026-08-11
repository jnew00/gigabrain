import { Pool } from "@neondatabase/serverless";

let pool: Pool | null = null;

function hasDatabase(): boolean {
  return !!process.env.DATABASE_URL;
}

function getPool(): Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

let initialized = false;

async function ensureTables() {
  if (initialized) return;
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS run_history (
      id SERIAL PRIMARY KEY,
      dungeon_name TEXT NOT NULL,
      won INTEGER NOT NULL,
      rooms_cleared INTEGER NOT NULL,
      final_hp INTEGER NOT NULL,
      max_hp INTEGER NOT NULL,
      items_json TEXT NOT NULL DEFAULT '[]',
      boons_json TEXT NOT NULL DEFAULT '[]',
      timestamp BIGINT NOT NULL,
      user_address TEXT NOT NULL DEFAULT ''
    )
  `);
  await p.query(`ALTER TABLE run_history ADD COLUMN IF NOT EXISTS user_address TEXT NOT NULL DEFAULT ''`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_run_timestamp ON run_history(timestamp)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_run_user ON run_history(user_address)`);
  initialized = true;
}

/* ─── Run History ─────────────────────────────────────── */

export interface RunHistoryRow {
  id: number;
  dungeon_name: string;
  won: number;
  rooms_cleared: number;
  final_hp: number;
  max_hp: number;
  items_json: string;
  boons_json: string;
  timestamp: number;
  user_address: string;
}

export async function insertRun(
  dungeonName: string,
  won: boolean,
  roomsCleared: number,
  finalHp: number,
  maxHp: number,
  items: { id: number; amount: number; name: string }[],
  boons: string[],
  userAddress: string
) {
  if (!hasDatabase()) return;
  await ensureTables();
  await getPool().query(
    `INSERT INTO run_history (dungeon_name, won, rooms_cleared, final_hp, max_hp, items_json, boons_json, timestamp, user_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [dungeonName, won ? 1 : 0, roomsCleared, finalHp, maxHp, JSON.stringify(items), JSON.stringify(boons), Date.now(), userAddress]
  );
}

export interface DungeonPerformanceRow {
  dungeon_name: string;
  total_runs: number;
  wins: number;
  avg_rooms: number;
}

/** Per-dungeon aggregates for the energy advisor (last 30 days) */
export async function getDungeonPerformance(userAddress: string): Promise<DungeonPerformanceRow[]> {
  if (!hasDatabase()) return [];
  await ensureTables();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const { rows } = await getPool().query(
    `SELECT dungeon_name,
            COUNT(*)::int as total_runs,
            SUM(won)::int as wins,
            AVG(rooms_cleared)::float as avg_rooms
     FROM run_history
     WHERE user_address = $1 AND timestamp > $2
     GROUP BY dungeon_name`,
    [userAddress, cutoff]
  );
  return rows as DungeonPerformanceRow[];
}

export async function getRunStats(userAddress: string): Promise<{
  totalRuns: number;
  wins: number;
  losses: number;
  avgRooms: number;
  totalItems: Record<string, { name: string; amount: number }>;
  recentRuns: RunHistoryRow[];
}> {
  if (!hasDatabase()) return { totalRuns: 0, wins: 0, losses: 0, avgRooms: 0, totalItems: {}, recentRuns: [] };
  await ensureTables();
  const p = getPool();
  const { rows: [{ c: total }] } = await p.query(
    `SELECT COUNT(*) as c FROM run_history WHERE user_address = $1`,
    [userAddress]
  );
  const { rows: [{ c: wins }] } = await p.query(
    `SELECT COUNT(*) as c FROM run_history WHERE won = 1 AND user_address = $1`,
    [userAddress]
  );
  const { rows: avgResult } = await p.query(
    `SELECT AVG(rooms_cleared) as a FROM run_history WHERE user_address = $1`,
    [userAddress]
  );
  const avgRooms = Number(total) > 0 ? Number(avgResult[0].a) : 0;
  const { rows: recent } = await p.query(
    `SELECT * FROM run_history WHERE user_address = $1 ORDER BY timestamp DESC LIMIT 20`,
    [userAddress]
  );

  // Aggregate all items across all runs
  const { rows: allRuns } = await p.query(
    `SELECT items_json FROM run_history WHERE user_address = $1`,
    [userAddress]
  );
  const totalItems: Record<string, { name: string; amount: number }> = {};
  for (const row of allRuns) {
    try {
      const items = JSON.parse(row.items_json) as { id: number; amount: number; name: string }[];
      for (const item of items) {
        const key = String(item.id);
        if (!totalItems[key]) totalItems[key] = { name: item.name, amount: 0 };
        totalItems[key].amount += item.amount;
      }
    } catch { /* skip bad json */ }
  }

  return {
    totalRuns: Number(total),
    wins: Number(wins),
    losses: Number(total) - Number(wins),
    avgRooms,
    totalItems,
    recentRuns: recent as RunHistoryRow[],
  };
}
