import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "enemy-intel.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS enemy_moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enemy_id INTEGER NOT NULL,
        room_num INTEGER NOT NULL,
        dungeon_id INTEGER NOT NULL,
        level INTEGER NOT NULL,
        move TEXT NOT NULL,
        round INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_enemy_id ON enemy_moves(enemy_id);
      CREATE INDEX IF NOT EXISTS idx_enemy_room ON enemy_moves(enemy_id, room_num);

      CREATE TABLE IF NOT EXISTS run_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dungeon_name TEXT NOT NULL,
        won INTEGER NOT NULL,
        rooms_cleared INTEGER NOT NULL,
        final_hp INTEGER NOT NULL,
        max_hp INTEGER NOT NULL,
        items_json TEXT NOT NULL DEFAULT '[]',
        boons_json TEXT NOT NULL DEFAULT '[]',
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_timestamp ON run_history(timestamp);
    `);

    // Clean up bad data (enemy_id -1 = no enemy)
    db.exec("DELETE FROM enemy_moves WHERE enemy_id < 0");
  }
  return db;
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
}

export function insertMove(
  enemyId: number,
  roomNum: number,
  dungeonId: number,
  level: number,
  move: string,
  round: number,
  timestamp: number
) {
  const d = getDb();
  d.prepare(
    `INSERT INTO enemy_moves (enemy_id, room_num, dungeon_id, level, move, round, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(enemyId, roomNum, dungeonId, level, move, round, timestamp);
}

export function getAllMoves(): EnemyMoveRow[] {
  const d = getDb();
  return d.prepare("SELECT * FROM enemy_moves ORDER BY timestamp ASC").all() as EnemyMoveRow[];
}

export function getStats(): { totalRecords: number; uniqueEnemies: number } {
  const d = getDb();
  const total = (d.prepare("SELECT COUNT(*) as c FROM enemy_moves").get() as { c: number }).c;
  const unique = (d.prepare("SELECT COUNT(DISTINCT enemy_id) as c FROM enemy_moves").get() as { c: number }).c;
  return { totalRecords: total, uniqueEnemies: unique };
}

export function importBulk(
  records: { enemyId: number; roomNum: number; dungeonId: number; level: number; move: string; round: number; timestamp: number }[]
) {
  const d = getDb();
  const insert = d.prepare(
    `INSERT INTO enemy_moves (enemy_id, room_num, dungeon_id, level, move, round, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = d.transaction((recs: typeof records) => {
    for (const r of recs) {
      insert.run(r.enemyId, r.roomNum, r.dungeonId, r.level, r.move, r.round, r.timestamp);
    }
  });
  tx(records);
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
}

export function insertRun(
  dungeonName: string,
  won: boolean,
  roomsCleared: number,
  finalHp: number,
  maxHp: number,
  items: { id: number; amount: number; name: string }[],
  boons: string[]
) {
  const d = getDb();
  d.prepare(
    `INSERT INTO run_history (dungeon_name, won, rooms_cleared, final_hp, max_hp, items_json, boons_json, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(dungeonName, won ? 1 : 0, roomsCleared, finalHp, maxHp, JSON.stringify(items), JSON.stringify(boons), Date.now());
}

export function getRunStats(): {
  totalRuns: number;
  wins: number;
  losses: number;
  avgRooms: number;
  totalItems: Record<string, { name: string; amount: number }>;
  recentRuns: RunHistoryRow[];
} {
  const d = getDb();
  const total = (d.prepare("SELECT COUNT(*) as c FROM run_history").get() as { c: number }).c;
  const wins = (d.prepare("SELECT COUNT(*) as c FROM run_history WHERE won = 1").get() as { c: number }).c;
  const avgRooms = total > 0
    ? (d.prepare("SELECT AVG(rooms_cleared) as a FROM run_history").get() as { a: number }).a
    : 0;
  const recent = d.prepare("SELECT * FROM run_history ORDER BY timestamp DESC LIMIT 20").all() as RunHistoryRow[];

  // Aggregate all items across all runs
  const allRuns = d.prepare("SELECT items_json FROM run_history").all() as { items_json: string }[];
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

  return { totalRuns: total, wins, losses: total - wins, avgRooms, totalItems, recentRuns: recent };
}
