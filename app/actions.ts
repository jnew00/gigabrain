"use server";

import {
  insertRun,
  getRunStats as dbGetRunStats,
  getDungeonPerformance as dbGetDungeonPerformance,
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

export async function getDungeonPerformanceAction(userAddress: string) {
  if (typeof userAddress !== "string") {
    throw new Error("Invalid user address");
  }
  return dbGetDungeonPerformance(userAddress);
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
