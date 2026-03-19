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
    CREATE TABLE IF NOT EXISTS enemy_moves (
      id SERIAL PRIMARY KEY,
      enemy_id INTEGER NOT NULL,
      room_num INTEGER NOT NULL,
      dungeon_id INTEGER NOT NULL,
      level INTEGER NOT NULL,
      move TEXT NOT NULL,
      round INTEGER NOT NULL,
      timestamp BIGINT NOT NULL,
      user_address TEXT NOT NULL DEFAULT ''
    )
  `);
  // Migration: add user_address to existing tables
  await p.query(`ALTER TABLE enemy_moves ADD COLUMN IF NOT EXISTS user_address TEXT NOT NULL DEFAULT ''`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_enemy_id ON enemy_moves(enemy_id)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_enemy_room ON enemy_moves(enemy_id, room_num)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_enemy_user ON enemy_moves(user_address)`);
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

  // Clean up bad data (enemy_id -1 = no enemy)
  await p.query(`DELETE FROM enemy_moves WHERE enemy_id < 0`);
  initialized = true;
}

export interface EnemyMoveRow {
  id: number;
  enemy_id: number;
  room_num: number;
  dungeon_id: number;
  level: number;
  move: string;
  round: number;
  timestamp: number;
  user_address: string;
}

export async function insertMove(
  enemyId: number,
  roomNum: number,
  dungeonId: number,
  level: number,
  move: string,
  round: number,
  timestamp: number,
  userAddress: string
) {
  if (!hasDatabase()) return;
  await ensureTables();
  await getPool().query(
    `INSERT INTO enemy_moves (enemy_id, room_num, dungeon_id, level, move, round, timestamp, user_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [enemyId, roomNum, dungeonId, level, move, round, timestamp, userAddress]
  );
}

export async function getAllMoves(userAddress: string): Promise<EnemyMoveRow[]> {
  if (!hasDatabase()) return [];
  await ensureTables();
  const { rows } = await getPool().query(
    `SELECT * FROM enemy_moves WHERE user_address = $1 ORDER BY timestamp ASC`,
    [userAddress]
  );
  return rows as EnemyMoveRow[];
}

export async function getStats(userAddress: string): Promise<{ totalRecords: number; uniqueEnemies: number }> {
  if (!hasDatabase()) return { totalRecords: 0, uniqueEnemies: 0 };
  await ensureTables();
  const p = getPool();
  const { rows: [{ c: total }] } = await p.query(
    `SELECT COUNT(*) as c FROM enemy_moves WHERE user_address = $1`,
    [userAddress]
  );
  const { rows: [{ c: unique }] } = await p.query(
    `SELECT COUNT(DISTINCT enemy_id) as c FROM enemy_moves WHERE user_address = $1`,
    [userAddress]
  );
  return { totalRecords: Number(total), uniqueEnemies: Number(unique) };
}

export async function importBulk(
  records: { enemyId: number; roomNum: number; dungeonId: number; level: number; move: string; round: number; timestamp: number }[],
  userAddress: string
) {
  if (!hasDatabase()) return;
  await ensureTables();
  const p = getPool();
  // Build a multi-row INSERT for efficiency
  const values: unknown[] = [];
  const placeholders: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const offset = i * 8;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`);
    values.push(r.enemyId, r.roomNum, r.dungeonId, r.level, r.move, r.round, r.timestamp, userAddress);
  }
  await p.query(
    `INSERT INTO enemy_moves (enemy_id, room_num, dungeon_id, level, move, round, timestamp, user_address)
     VALUES ${placeholders.join(", ")}`,
    values
  );
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
