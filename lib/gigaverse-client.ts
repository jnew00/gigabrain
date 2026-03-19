// Gigaverse API client - reverse-engineered endpoints (March 2026)

import type {
  DungeonAction,
  DungeonActionPayload,
  DungeonActionResponse,
  UserMeResponse,
  EnergyResponse,
  RomsResponse,
  DungeonTodayResponse,
  AccountResponse,
} from "./types";

const BASE_URL = "https://gigaverse.io";

async function apiFetch<T>(
  endpoint: string,
  token: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "*/*",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ─── GET endpoints ─────────────────────────────────────────────

export function getUserMe(token: string) {
  return apiFetch<UserMeResponse>("/api/user/me", token);
}

export function getAccount(token: string, address: string) {
  return apiFetch<AccountResponse>(`/api/account/${address}`, token);
}

export function getEnergy(token: string, address: string) {
  return apiFetch<EnergyResponse>(
    `/api/offchain/player/energy/${address}`,
    token
  );
}

export function getRoms(token: string, address: string) {
  return apiFetch<RomsResponse>(
    `/api/roms/player?id=${address.toLowerCase()}`,
    token
  );
}

export function getDungeonState(token: string) {
  return apiFetch<DungeonActionResponse>("/api/game/dungeon/state", token);
}

export function getDungeonToday(token: string) {
  return apiFetch<DungeonTodayResponse>("/api/game/dungeon/today", token);
}

export function getActiveDungeon(token: string, address: string) {
  return apiFetch<unknown>(
    `/api/offchain/player/activeDungeon/${address}`,
    token
  );
}

export function getSkillsProgress(token: string, noobId: string | number) {
  return apiFetch<unknown>(
    `/api/offchain/skills/progress/${noobId}`,
    token
  );
}

export function getOffchainStatic(token: string) {
  return apiFetch<unknown>("/api/offchain/static", token);
}

export function getGameItems(token: string) {
  return apiFetch<unknown>("/api/indexer/gameitems", token);
}

export function getPlayerGameItems(token: string, address: string) {
  return apiFetch<unknown>(
    `/api/indexer/player/gameitems/${address}`,
    token
  );
}

export function getItemBalances(token: string) {
  return apiFetch<unknown>("/api/items/balances", token);
}

export function getGearItems(token: string) {
  return apiFetch<unknown>("/api/gear/items", token);
}

export function getGearInstances(token: string, address: string) {
  return apiFetch<unknown>(`/api/gear/instances/${address}`, token);
}

export function getJuiceState(token: string, address: string) {
  return apiFetch<unknown>(`/api/gigajuice/player/${address}`, token);
}

export function getFaction(token: string, address: string) {
  return apiFetch<unknown>(`/api/factions/player/${address}`, token);
}

export function getFishingState(token: string, address: string) {
  return apiFetch<unknown>(`/api/fishing/state/${address}`, token);
}

export function getFishingCards(token: string) {
  return apiFetch<unknown>("/api/fishing/cards", token);
}

// ─── POST endpoints ────────────────────────────────────────────

export function dungeonAction(
  token: string,
  action: DungeonAction,
  actionToken: string | number,
  dungeonId: number = 0,
  data: Partial<DungeonActionPayload["data"]> = {}
) {
  const payload: DungeonActionPayload = {
    action,
    actionToken,
    dungeonId,
    data: {
      consumables: [],
      itemId: 0,
      expectedAmount: 0,
      index: 0,
      isJuiced: false,
      gearInstanceIds: [],
      ...data,
    },
  };

  return apiFetch<DungeonActionResponse>(
    "/api/game/dungeon/action",
    token,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

export function claimRom(
  token: string,
  romId: string,
  claimId: string
) {
  return apiFetch<{ success: boolean }>(
    "/api/roms/factory/claim",
    token,
    {
      method: "POST",
      body: JSON.stringify({ romId, claimId }),
    }
  );
}
