"use server";

import {
  insertRun,
  insertCast,
  getRunStats as dbGetRunStats,
  getDungeonPerformance as dbGetDungeonPerformance,
  getPondYields as dbGetPondYields,
} from "@/lib/run-db";

/* ─── Validation helpers ─────────────────────────────── */

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/* ─── Run History ─────────────────────────────────────── */

export async function recordRunAction(
  dungeonName: string,
  won: boolean,
  roomsCleared: number,
  finalHp: number,
  maxHp: number,
  items: { id: number; amount: number; name: string }[],
  boons: string[],
  userAddress: string
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
  if (typeof userAddress !== "string") {
    throw new Error("Invalid user address");
  }
  await insertRun(dungeonName, won, roomsCleared, finalHp, maxHp, items, boons, userAddress);
}

export async function getRunStatsAction(userAddress: string) {
  if (typeof userAddress !== "string") {
    throw new Error("Invalid user address");
  }
  return dbGetRunStats(userAddress);
}

export async function getDungeonPerformanceAction(userAddress: string, yieldItemId?: number) {
  if (typeof userAddress !== "string") {
    throw new Error("Invalid user address");
  }
  if (yieldItemId !== undefined && !isPositiveInt(yieldItemId)) {
    throw new Error("Invalid yield item id");
  }
  return dbGetDungeonPerformance(userAddress, yieldItemId);
}

/* ─── Cast History ────────────────────────────────────── */

/**
 * Record one cast and what it paid out.
 *
 * The pond is required and unvalidated against a default on purpose — a cast
 * filed under the wrong pond is worse than one not filed at all, because it
 * silently corrupts the yield the advisor then ranks ponds by.
 */
export async function recordCastAction(
  pondId: number,
  nodeId: string,
  energyCost: number,
  entryMultiplier: number,
  caught: boolean,
  items: { id: number; amount: number; name: string }[],
  userAddress: string
) {
  if (!isPositiveInt(pondId) || pondId <= 0) {
    throw new Error("Invalid pond id");
  }
  if (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 20) {
    throw new Error("Invalid node id");
  }
  if (!isPositiveInt(energyCost) || !isPositiveInt(entryMultiplier)) {
    throw new Error("Invalid numeric parameter");
  }
  if (!Array.isArray(items)) {
    throw new Error("Invalid items");
  }
  if (typeof userAddress !== "string") {
    throw new Error("Invalid user address");
  }
  await insertCast(pondId, nodeId, energyCost, entryMultiplier, caught, items, userAddress);
}

export async function getPondYieldsAction(userAddress: string, yieldItemId?: number) {
  if (typeof userAddress !== "string") {
    throw new Error("Invalid user address");
  }
  if (yieldItemId !== undefined && !isPositiveInt(yieldItemId)) {
    throw new Error("Invalid yield item id");
  }
  return dbGetPondYields(userAddress, yieldItemId);
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
