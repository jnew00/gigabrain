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

/**
 * Wallet addresses are case-insensitive; EIP-55 mixed case is a checksum, not
 * identity. Postgres `=` is not, so a checksummed address written one day and a
 * lowercase one read the next look like two different players and silently
 * orphan the entire history — the reader sees "no data" with nothing to
 * explain it. Every address crossing this module is folded to one case.
 */
function normAddr(address: string): string {
  return address.toLowerCase();
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
  // One row per cast. Casts were never recorded before, which is why the
  // advisor had a measured figure for a Forbidden Woods run and nothing at all
  // for a Grove cast, and had to fall back on a judgement call about which
  // deserved the energy.
  await p.query(`
    CREATE TABLE IF NOT EXISTS cast_history (
      id SERIAL PRIMARY KEY,
      pond_id INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      energy_cost INTEGER NOT NULL,
      entry_multiplier INTEGER NOT NULL DEFAULT 1,
      caught INTEGER NOT NULL,
      items_json TEXT NOT NULL DEFAULT '[]',
      timestamp BIGINT NOT NULL,
      user_address TEXT NOT NULL DEFAULT ''
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_cast_user ON cast_history(user_address)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_cast_timestamp ON cast_history(timestamp)`);
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
    [dungeonName, won ? 1 : 0, roomsCleared, finalHp, maxHp, JSON.stringify(items), JSON.stringify(boons), Date.now(), normAddr(userAddress)]
  );
}

export interface DungeonPerformanceRow {
  dungeon_name: string;
  total_runs: number;
  wins: number;
  avg_rooms: number;
  /**
   * Average of one item's drops per run, when the caller asked for a specific
   * item. Null when nothing was recorded for that item, which the advisor
   * reads as "unmeasured" rather than as zero.
   */
  avg_item_amount?: number | null;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Sum one item's amount out of a stored items_json blob. */
function itemAmountIn(itemsJson: string, itemId: number): number {
  try {
    const items = JSON.parse(itemsJson) as { id: number; amount: number }[];
    let sum = 0;
    for (const it of items) if (it.id === itemId) sum += it.amount ?? 0;
    return sum;
  } catch {
    return 0;
  }
}

/**
 * Per-dungeon aggregates for the energy advisor (last 30 days).
 *
 * `yieldItemId` adds that item's average drop per run — the advisor passes the
 * event's Core item so it can rank a dungeon run against a pond cast on
 * measured return instead of on which one felt more important.
 */
export async function getDungeonPerformance(
  userAddress: string,
  yieldItemId?: number
): Promise<DungeonPerformanceRow[]> {
  if (!hasDatabase()) return [];
  await ensureTables();
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const { rows } = await getPool().query(
    `SELECT dungeon_name,
            COUNT(*)::int as total_runs,
            SUM(won)::int as wins,
            AVG(rooms_cleared)::float as avg_rooms
     FROM run_history
     WHERE user_address = $1 AND timestamp > $2
     GROUP BY dungeon_name`,
    [normAddr(userAddress), cutoff]
  );
  const perf = rows as DungeonPerformanceRow[];
  if (yieldItemId === undefined) return perf;

  const { rows: lootRows } = await getPool().query(
    `SELECT dungeon_name, items_json FROM run_history
     WHERE user_address = $1 AND timestamp > $2`,
    [normAddr(userAddress), cutoff]
  );
  // Every run counts, including the ones that dropped nothing.
  //
  // The advisor is deciding where to send the NEXT unit of energy, so the
  // number it needs is the expected return per run attempted. Averaging only
  // over runs that happened to drop Cores answers a different question — "how
  // many Cores when it works" — and reads high by exactly the failure rate,
  // which is the part the ranking is supposed to price in. A run that dies in
  // room 2 earning nothing is a real outcome, not a missing measurement.
  const tally = new Map<string, { runs: number; total: number }>();
  for (const r of lootRows as { dungeon_name: string; items_json: string }[]) {
    const t = tally.get(r.dungeon_name) ?? { runs: 0, total: 0 };
    t.runs++;
    t.total += itemAmountIn(r.items_json, yieldItemId);
    tally.set(r.dungeon_name, t);
  }
  return perf.map((p) => {
    const t = tally.get(p.dungeon_name);
    return { ...p, avg_item_amount: t && t.runs > 0 ? t.total / t.runs : null };
  });
}

/* ─── Cast History ────────────────────────────────────── */

export async function insertCast(
  pondId: number,
  nodeId: string,
  energyCost: number,
  entryMultiplier: number,
  caught: boolean,
  items: { id: number; amount: number; name: string }[],
  userAddress: string
) {
  if (!hasDatabase()) return;
  await ensureTables();
  await getPool().query(
    `INSERT INTO cast_history (pond_id, node_id, energy_cost, entry_multiplier, caught, items_json, timestamp, user_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [pondId, nodeId, energyCost, entryMultiplier, caught ? 1 : 0, JSON.stringify(items), Date.now(), normAddr(userAddress)]
  );
}

export interface PondYieldRow {
  pond_id: number;
  total_casts: number;
  catches: number;
  avg_energy: number;
  /**
   * Requested item per cast attempted, averaged over every recorded cast
   * including the ones that paid nothing. Null when no cast was recorded.
   */
  avg_item_amount: number | null;
}

/**
 * Per-pond cast yields (last 30 days).
 *
 * Normalised to a tier-1 entry: a cast paid for with a 4x offering ring earns
 * four times the Cores, and averaging those in raw would make the pond look
 * four times as productive as it will be on the next free cast.
 */
export async function getPondYields(
  userAddress: string,
  yieldItemId?: number
): Promise<PondYieldRow[]> {
  if (!hasDatabase()) return [];
  await ensureTables();
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const { rows } = await getPool().query(
    `SELECT pond_id, energy_cost, entry_multiplier, caught, items_json
     FROM cast_history
     WHERE user_address = $1 AND timestamp > $2`,
    [normAddr(userAddress), cutoff]
  );

  const byPond = new Map<
    number,
    { casts: number; catches: number; energy: number; itemTotal: number }
  >();
  for (const r of rows as {
    pond_id: number;
    energy_cost: number;
    entry_multiplier: number;
    caught: number;
    items_json: string;
  }[]) {
    const acc = byPond.get(r.pond_id) ?? { casts: 0, catches: 0, energy: 0, itemTotal: 0 };
    acc.casts++;
    acc.catches += r.caught ? 1 : 0;
    acc.energy += r.energy_cost;
    if (yieldItemId !== undefined) {
      // Every cast counts, including the ones that paid nothing.
      //
      // A fish that escapes earns no Cores, and that is a real outcome of
      // spending the energy — not a gap in the data. Averaging only over casts
      // that paid out would answer "how many Cores when I land one", which
      // reads high by exactly the escape rate and would push the advisor to
      // over-fund the pond. The number it needs is Cores per cast attempted.
      acc.itemTotal +=
        itemAmountIn(r.items_json, yieldItemId) / Math.max(1, r.entry_multiplier || 1);
    }
    byPond.set(r.pond_id, acc);
  }

  return Array.from(byPond, ([pond_id, a]) => ({
    pond_id,
    total_casts: a.casts,
    catches: a.catches,
    avg_energy: a.casts > 0 ? a.energy / a.casts : 0,
    // Null only when nothing was asked for or no cast was recorded — never as
    // a stand-in for a measured zero.
    avg_item_amount:
      yieldItemId !== undefined && a.casts > 0 ? a.itemTotal / a.casts : null,
  }));
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
    [normAddr(userAddress)]
  );
  const { rows: [{ c: wins }] } = await p.query(
    `SELECT COUNT(*) as c FROM run_history WHERE won = 1 AND user_address = $1`,
    [normAddr(userAddress)]
  );
  const { rows: avgResult } = await p.query(
    `SELECT AVG(rooms_cleared) as a FROM run_history WHERE user_address = $1`,
    [normAddr(userAddress)]
  );
  const avgRooms = Number(total) > 0 ? Number(avgResult[0].a) : 0;
  const { rows: recent } = await p.query(
    `SELECT * FROM run_history WHERE user_address = $1 ORDER BY timestamp DESC LIMIT 20`,
    [normAddr(userAddress)]
  );

  // Aggregate all items across all runs
  const { rows: allRuns } = await p.query(
    `SELECT items_json FROM run_history WHERE user_address = $1`,
    [normAddr(userAddress)]
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
