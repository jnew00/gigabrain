"use server";

import {
  insertMove,
  getAllMoves,
  getStats as dbGetStats,
  importBulk,
  insertRun,
  getRunStats as dbGetRunStats,
} from "@/lib/enemy-db";
import type { EnemyMoveRow } from "@/lib/enemy-db";

/* ─── Validation helpers ─────────────────────────────── */

const VALID_MOVES = new Set(["rock", "paper", "scissor"]);
const MAX_BULK_IMPORT = 10_000;

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/* ─── Enemy Intel ─────────────────────────────────────── */

export async function recordEnemyMoveAction(
  enemyId: number,
  roomNum: number,
  dungeonId: number,
  level: number,
  move: string,
  round: number
) {
  if (!isPositiveInt(enemyId) || !isPositiveInt(roomNum) || !isPositiveInt(dungeonId) || !isPositiveInt(level) || !isPositiveInt(round)) {
    throw new Error("Invalid numeric parameter");
  }
  if (!VALID_MOVES.has(move)) {
    throw new Error("Invalid move");
  }
  insertMove(enemyId, roomNum, dungeonId, level, move, round, Date.now());
}

export async function getAllEnemyMoves(): Promise<EnemyMoveRow[]> {
  return getAllMoves();
}

export async function getEnemyStats(): Promise<{ totalRecords: number; uniqueEnemies: number }> {
  return dbGetStats();
}

/** Migrate localStorage records to SQLite (one-time) */
export async function migrateEnemyMoves(
  records: { enemyId: number; roomNum: number; dungeonId: number; level: number; move: string; round: number; timestamp: number }[]
): Promise<{ imported: number }> {
  if (!Array.isArray(records) || records.length === 0) return { imported: 0 };
  if (records.length > MAX_BULK_IMPORT) {
    throw new Error(`Bulk import limited to ${MAX_BULK_IMPORT} records`);
  }
  for (const r of records) {
    if (!isPositiveInt(r.enemyId) || !isPositiveInt(r.roomNum) || !isPositiveInt(r.dungeonId) || !isPositiveInt(r.level) || !isPositiveInt(r.round) || !isPositiveInt(r.timestamp)) {
      throw new Error("Invalid record in bulk import");
    }
    if (!VALID_MOVES.has(r.move)) {
      throw new Error("Invalid move in bulk import");
    }
  }
  importBulk(records);
  return { imported: records.length };
}

/* ─── Run History ─────────────────────────────────────── */

export async function recordRunAction(
  dungeonName: string,
  won: boolean,
  roomsCleared: number,
  finalHp: number,
  maxHp: number,
  items: { id: number; amount: number; name: string }[],
  boons: string[]
) {
  if (typeof dungeonName !== "string" || dungeonName.length === 0 || dungeonName.length > 200) {
    throw new Error("Invalid dungeon name");
  }
  if (!isPositiveInt(roomsCleared) || !isPositiveInt(maxHp)) {
    throw new Error("Invalid numeric parameter");
  }
  if (!Array.isArray(items) || !Array.isArray(boons)) {
    throw new Error("Invalid items or boons");
  }
  insertRun(dungeonName, won, roomsCleared, finalHp, maxHp, items, boons);
}

export async function getRunStatsAction() {
  return dbGetRunStats();
}

/* ─── Auth ────────────────────────────────────────────── */

/**
 * Authenticate with Gigaverse using a wallet signature.
 * POST https://gigaverse.io/api/user/auth
 */
export async function authenticateWithSignature(
  address: string,
  signature: string,
  message: string,
  timestamp: number
): Promise<{
  success: boolean;
  jwt?: string;
  expiresAt?: number;
  error?: string;
}> {
  try {
    const res = await fetch("https://gigaverse.io/api/user/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify({ address, signature, message, timestamp }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        success: false,
        error: data.message || `Auth failed (${res.status})`,
      };
    }

    const data = await res.json();
    return {
      success: true,
      jwt: data.jwt,
      expiresAt: data.expiresAt,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "Auth request failed",
    };
  }
}
