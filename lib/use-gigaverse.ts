"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type {
  DungeonAction,
  DungeonActionResponse,
  EnergyResponse,
  DungeonTodayResponse,
  AccountResponse,
  RomsResponse,
  GameItemsResponse,
  OffchainStaticResponse,
  RecipeEntity,
  PlayerRecipesResponse,
  SkillTree,
  SkillProgressEntity,
  SkillsResponse,
  SkillProgressResponse,
  ItemBalancesResponse,
  FishingGameState,
  FishingActionResponse,
  GigaJuiceResponse,
  GearInstancesResponse,
} from "./types";
import { loadLocalStorageRecords, clearLocalStorageRecords } from "./enemy-tracker";
import type { EnemyMoveRecord } from "./enemy-tracker";
import {
  recordEnemyMoveAction,
  getAllEnemyMoves,
  migrateEnemyMoves,
} from "@/app/actions";

const STORAGE_KEY = "giga-auth";

interface StoredAuth {
  jwt: string;
  expiresAt: number;
}

function loadStoredAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuth;
    // Check expiry with 60s buffer
    if (parsed.expiresAt && Date.now() > parsed.expiresAt - 60_000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveAuth(jwt: string, expiresAt?: number) {
  const data: StoredAuth = {
    jwt,
    // Default to 1 hour from now if no expiresAt provided
    expiresAt: expiresAt ?? Date.now() + 60 * 60 * 1000,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function clearAuth() {
  localStorage.removeItem(STORAGE_KEY);
}

async function proxy<T>(
  endpoint: string,
  token: string,
  method: "GET" | "POST" = "GET",
  body?: unknown
): Promise<T> {
  const res = await fetch("/api/proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-giga-token": token,
    },
    body: JSON.stringify({ endpoint, method, body }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error(`[proxy] ${method} ${endpoint} → ${res.status}:`, data?.message || data?.error, body ? JSON.stringify(body).substring(0, 200) : "");
    const err = new Error(data?.message || data?.error || `API error ${res.status}`);
    // Attach response data so callers can extract actionToken from error responses
    (err as Error & { responseData?: unknown }).responseData = data;
    throw err;
  }

  return data as T;
}

export function useGigaverse() {
  const [token, setToken] = useState<string>("");
  const [address, setAddress] = useState<string>("");
  const [noobId, setNoobId] = useState<string>("");
  const [username, setUsername] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dungeonState, setDungeonState] =
    useState<DungeonActionResponse | null>(null);
  const [energy, setEnergy] = useState<EnergyResponse | null>(null);
  const [dungeonToday, setDungeonToday] =
    useState<DungeonTodayResponse | null>(null);
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [roms, setRoms] = useState<RomsResponse | null>(null);
  const [actionToken, setActionToken] = useState<number>(Date.now());
  const [itemNames, setItemNames] = useState<Record<string, string>>({});
  const [itemInfo, setItemInfo] = useState<Record<string, { name: string; rarity?: number; rarityName?: string; icon?: string }>>({});
  const [enemyNames, setEnemyNames] = useState<Record<string, { name: string; stats?: number[] }>>({});
  const [enemyMoveRecords, setEnemyMoveRecords] = useState<EnemyMoveRecord[]>([]);
  const [worldRecipes, setWorldRecipes] = useState<RecipeEntity[]>([]);
  const [playerRecipes, setPlayerRecipes] = useState<PlayerRecipesResponse | null>(null);
  const [skillTrees, setSkillTrees] = useState<SkillTree[]>([]);
  const [skillProgress, setSkillProgress] = useState<SkillProgressEntity[]>([]);
  const [itemBalances, setItemBalances] = useState<Record<string, number>>({});
  const [fishingState, setFishingState] = useState<FishingGameState | null>(null);
  const [juiceExpiry, setJuiceExpiry] = useState<number | null>(null); // unix timestamp
  const [gearInstances, setGearInstances] = useState<GearInstancesResponse | null>(null);
  const [fishingActionToken, setFishingActionToken] = useState<number>(Date.now());
  const fishingActionTokenRef = useRef(fishingActionToken);
  fishingActionTokenRef.current = fishingActionToken;
  const [restoringSession, setRestoringSession] = useState(true);

  const withLoading = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | null> => {
      setLoading(true);
      setError(null);
      try {
        const result = await fn();
        return result;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const connect = useCallback(
    async (jwt: string, expiresAt?: number) => {
      setToken(jwt);
      setLoading(true);
      setError(null);
      try {
        // Fetch user identity first
        const me = await proxy<{ address: string; canEnterGame: boolean }>(
          "/api/user/me",
          jwt
        );
        setAddress(me.address);

        // Fetch everything else in parallel
        const [acc, eng, ds, dt, rm, items, staticData, playerRecipeData, balancesData, juiceData, gearData] = await Promise.all([
          proxy<AccountResponse>(`/api/account/${me.address}`, jwt),
          proxy<EnergyResponse>(`/api/offchain/player/energy/${me.address}`, jwt),
          proxy<DungeonActionResponse>("/api/game/dungeon/state", jwt),
          proxy<DungeonTodayResponse>("/api/game/dungeon/today", jwt),
          proxy<RomsResponse>(`/api/roms/player?id=${me.address.toLowerCase()}`, jwt),
          proxy<GameItemsResponse>("/api/indexer/gameitems", jwt),
          proxy<OffchainStaticResponse>("/api/offchain/static", jwt),
          proxy<PlayerRecipesResponse>(`/api/offchain/recipes/player/${me.address}`, jwt),
          proxy<ItemBalancesResponse>("/api/items/balances", jwt),
          proxy<GigaJuiceResponse>(`/api/gigajuice/player/${me.address}`, jwt).catch(() => null),
          proxy<GearInstancesResponse>(`/api/gear/instances/${me.address}`, jwt).catch(() => null),
        ] as const);

        setAccount(acc);
        if (acc.noob) setNoobId(acc.noob.docId);
        if (acc.usernames?.length) setUsername(acc.usernames[0].NAME_CID);

        // Build enemy name lookup: multiple key formats for robust matching
        if (staticData?.enemies) {
          const names: Record<string, { name: string; stats?: number[] }> = {};
          for (let i = 0; i < staticData.enemies.length; i++) {
            const e = staticData.enemies[i];
            const entry = { name: e.NAME_CID, stats: e.MOVE_STATS_CID_array };
            // Key by raw ID_CID (e.g. "ENEMY#5" or "5")
            names[e.ID_CID] = entry;
            // Key by numeric portion only (e.g. "5")
            const numericId = e.ID_CID.replace(/\D/g, "");
            if (numericId) names[numericId] = entry;
            // Key by array index (0-based)
            names[`idx:${i}`] = entry;
          }
          setEnemyNames(names);
        }

        // Build item name lookup: id -> name (from gameitems index)
        if (items?.entities) {
          const names: Record<string, string> = {};
          for (const item of items.entities) {
            const id = item.docId || item.ID_CID || "";
            names[id] = (item.NAME_CID || "").replace("ITEM#", "");
          }
          setItemNames(names);
        }

        // Build rich item info from offchain static (has rarity + icons)
        if (staticData?.gameItems) {
          const info: Record<string, { name: string; rarity?: number; rarityName?: string; icon?: string }> = {};
          for (const gi of staticData.gameItems) {
            const id = String(gi.ID_CID || gi.docId);
            info[id] = {
              name: (gi.NAME_CID || "").replace("ITEM#", ""),
              rarity: gi.RARITY_CID,
              rarityName: gi.RARITY_NAME,
              icon: gi.ICON_URL_CID || gi.IMG_URL_CID,
            };
          }
          setItemInfo(info);
        }
        // Store world recipes (pots, chests, crafting) + player recipe progress
        if (staticData?.recipes) {
          setWorldRecipes(staticData.recipes);
        }
        setPlayerRecipes(playerRecipeData);

        // Store item balances as a lookup map
        if (balancesData?.entities) {
          const bals: Record<string, number> = {};
          for (const b of balancesData.entities) bals[b.ID_CID] = b.BALANCE_CID;
          setItemBalances(bals);
        }

        // Store juice expiry
        if (juiceData?.juiceData?.isJuiced && juiceData.juiceData.TIMESTAMP_CID) {
          setJuiceExpiry(juiceData.juiceData.TIMESTAMP_CID);
        }

        // Store gear instances
        if (gearData) setGearInstances(gearData);

        // Fetch skills + progress (needs noobId)
        const nid = acc.noob?.docId;
        if (nid) {
          Promise.all([
            proxy<SkillsResponse>("/api/offchain/skills", jwt),
            proxy<SkillProgressResponse>(`/api/offchain/skills/progress/${nid}`, jwt),
          ]).then(([sk, sp]) => {
            if (sk?.entities) setSkillTrees(sk.entities);
            else if (Array.isArray(sk)) setSkillTrees(sk as SkillTree[]);
            if (sp?.entities) setSkillProgress(sp.entities);
            else if (Array.isArray(sp)) setSkillProgress(sp as SkillProgressEntity[]);
          }).catch(() => {});
        }

        setEnergy(eng);
        setDungeonState(ds);
        setDungeonToday(dt);
        setRoms(rm);
        if (ds.actionToken) {
          setActionToken(ds.actionToken);
          actionTokenRef.current = ds.actionToken;
        }

        // Persist JWT
        saveAuth(jwt, expiresAt);

        // Load enemy intel from SQLite + migrate localStorage if needed
        try {
          const lsRecords = loadLocalStorageRecords();
          if (lsRecords.length > 0) {
            await migrateEnemyMoves(lsRecords, me.address);
            clearLocalStorageRecords();
          }
          const dbRecords = await getAllEnemyMoves(me.address);
          setEnemyMoveRecords(
            dbRecords.map((r) => ({
              enemyId: r.enemy_id,
              roomNum: r.room_num,
              dungeonId: r.dungeon_id,
              level: r.level,
              move: r.move,
              round: r.round,
              timestamp: r.timestamp,
            }))
          );
        } catch {
          // Fall back to localStorage if SQLite fails
          setEnemyMoveRecords(loadLocalStorageRecords());
        }

        return me;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Connection failed");
        clearAuth();
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  /** Record an enemy move — writes to SQLite + updates local state */
  const recordEnemyMove = useCallback(
    (enemyId: number, roomNum: number, dungeonId: number, level: number, move: string, round: number) => {
      const record: EnemyMoveRecord = { enemyId, roomNum, dungeonId, level, move, round, timestamp: Date.now() };
      setEnemyMoveRecords((prev) => [...prev, record]);
      // Fire-and-forget write to SQLite
      recordEnemyMoveAction(enemyId, roomNum, dungeonId, level, move, round, address).catch(() => {});
    },
    [address]
  );

  const disconnect = useCallback(() => {
    setToken("");
    setAddress("");
    setNoobId("");
    setUsername("");
    setDungeonState(null);
    setEnergy(null);
    setDungeonToday(null);
    setAccount(null);
    setRoms(null);
    setItemNames({});
    setItemInfo({});
    setEnemyNames({});
    setEnemyMoveRecords([]);
    setError(null);
    clearAuth();
  }, []);

  // Auto-restore session from localStorage on mount
  useEffect(() => {
    const stored = loadStoredAuth();
    if (stored) {
      connect(stored.jwt, stored.expiresAt).finally(() =>
        setRestoringSession(false)
      );
    } else {
      setRestoringSession(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track whether auto-battle is active — when true, refreshAll skips dungeon
  // state fetch to avoid rotating the actionToken on the server
  const autoBattleRef = useRef(false);

  const refreshAll = useCallback(async () => {
    if (!token || !address) return;
    try {
      // NEVER fetch /api/game/dungeon/state here — it rotates the actionToken
      // on the Gigaverse server. Dungeon state is only fetched explicitly via
      // fetchDungeonState() or from connect/performAction/startRun responses.
      const [eng, dt, rm, pr, bal, fs] = await Promise.all([
        proxy<EnergyResponse>(`/api/offchain/player/energy/${address}`, token),
        proxy<DungeonTodayResponse>("/api/game/dungeon/today", token),
        proxy<RomsResponse>(`/api/roms/player?id=${address.toLowerCase()}`, token),
        proxy<PlayerRecipesResponse>(`/api/offchain/recipes/player/${address}`, token),
        proxy<ItemBalancesResponse>("/api/items/balances", token),
        proxy<FishingGameState>(`/api/fishing/state/${address}`, token).catch(() => null),
      ] as const);
      setEnergy(eng);
      setDungeonToday(dt);
      setRoms(rm);
      setPlayerRecipes(pr);
      if (bal?.entities) {
        const bals: Record<string, number> = {};
        for (const b of bal.entities) bals[b.ID_CID] = b.BALANCE_CID;
        setItemBalances(bals);
      }
      if (fs) {
        setFishingState(fs);
        if (fs.actionToken) {
          setFishingActionToken(fs.actionToken);
          fishingActionTokenRef.current = fs.actionToken;
        }
      }
    } catch {
      // Silently fail on refresh — don't block UI
    }
  }, [token, address]);

  // Ref is the sole source of truth for actionToken — only updated imperatively
  // in performAction/startRun/fetchDungeonState/refreshAll. Do NOT sync from
  // React state on re-render as it can overwrite with a stale value.
  const actionTokenRef = useRef(actionToken);

  const performAction = useCallback(
    async (action: DungeonAction, dungeonId: number = 0) => {
      if (!token) return null;
      const sentToken = actionTokenRef.current;
      console.log(`[performAction] ${action} sending token=${sentToken} dungeonId=${dungeonId}`);
      try {
        const result = await proxy<DungeonActionResponse>(
          "/api/game/dungeon/action",
          token,
          "POST",
          {
            action,
            actionToken: sentToken,
            dungeonId,
            data: {
              consumables: [],
              itemId: 0,
              expectedAmount: 0,
              index: 0,
              isJuiced: false,
              gearInstanceIds: [],
            },
          }
        );
        if (result) {
          setDungeonState(result);
          if (result.actionToken) {
            console.log(`[performAction] ${action} OK, new token=${result.actionToken} (was ${sentToken})`);
            setActionToken(result.actionToken);
            actionTokenRef.current = result.actionToken;
            // Sync fishing token — server uses one shared token
            fishingActionTokenRef.current = result.actionToken;
          } else {
            console.warn(`[performAction] ${action} OK but NO actionToken in response!`);
          }
        }
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Action failed";
        // Recover actionToken from error response — server rotates even on failure
        const respData = (e as Error & { responseData?: { actionToken?: number } }).responseData;
        if (respData?.actionToken) {
          console.warn(`[performAction] ${action} FAILED but got new token=${respData.actionToken}`);
          actionTokenRef.current = respData.actionToken;
          fishingActionTokenRef.current = respData.actionToken;
        } else {
          console.warn(`[performAction] ${action} FAILED: ${msg} (token=${sentToken}, no new token in error)`);
        }
        setError(msg);
        return null;
      }
    },
    [token]
  );

  /** Fetch fresh dungeon state directly (bypasses async React state) */
  const fetchDungeonState = useCallback(async () => {
    if (!token) return null;
    try {
      const ds = await proxy<DungeonActionResponse>("/api/game/dungeon/state", token);
      setDungeonState(ds);
      if (ds.actionToken) {
        setActionToken(ds.actionToken);
        actionTokenRef.current = ds.actionToken;
        fishingActionTokenRef.current = ds.actionToken;
      }
      return ds;
    } catch {
      return null;
    }
  }, [token]);

  const startRun = useCallback(
    (dungeonId: number = 0, isJuiced = false, gearInstanceIds: string[] = []) => {
      if (!token) return null;
      return withLoading(async () => {
        const result = await proxy<DungeonActionResponse>(
          "/api/game/dungeon/action",
          token,
          "POST",
          {
            action: "start_run",
            actionToken: actionTokenRef.current,
            dungeonId,
            data: {
              consumables: [],
              itemId: 0,
              expectedAmount: 0,
              index: 0,
              isJuiced,
              gearInstanceIds,
            },
          }
        );
        setDungeonState(result);
        if (result.actionToken) {
          console.log(`[startRun] got token=${result.actionToken}, setting ref`);
          setActionToken(result.actionToken);
          actionTokenRef.current = result.actionToken;
          fishingActionTokenRef.current = result.actionToken;
        } else {
          console.warn(`[startRun] NO actionToken in response! ref stays=${actionTokenRef.current}`);
        }
        return result;
      });
    },
    [token, withLoading]
  );

  const claimRom = useCallback(
    async (romId: string, claimId: string) => {
      if (!token) return null;
      return withLoading(() =>
        proxy<{ success: boolean }>(
          "/api/roms/factory-claim",
          token,
          "POST",
          { romId, claimId }
        )
      );
    },
    [token, withLoading]
  );

  /** Convert ROM energy to Gigus Dust */
  const convertEnergyToDust = useCallback(
    async (romId: string, amount: number) => {
      if (!token) return null;
      return withLoading(() =>
        proxy<{ success: boolean }>(
          "/api/roms/factory-claim",
          token,
          "POST",
          { romId, claimId: "gigusDust", amount }
        )
      );
    },
    [token, withLoading]
  );

  /** Use a recipe (pots, chests, etc.) */
  const useRecipe = useCallback(
    async (recipeId: string, gearInstanceId: string = "") => {
      if (!token || !noobId) return null;
      const result = await proxy<{ success: boolean; message?: string; data?: unknown; entities?: unknown[] }>(
        "/api/offchain/recipes/start",
        token,
        "POST",
        { recipeId, noobId: Number(noobId), gearInstanceId, nodeIndex: 0, quantity: 1 }
      );
      // Refresh player recipe progress after use
      if (address) {
        proxy<PlayerRecipesResponse>(`/api/offchain/recipes/player/${address}`, token)
          .then(setPlayerRecipes)
          .catch(() => {});
      }
      return result;
    },
    [token, noobId, address]
  );

  /** Fetch current fishing game state */
  const fetchFishingState = useCallback(async () => {
    if (!token || !address) return null;
    try {
      const state = await proxy<FishingGameState>(
        `/api/fishing/state/${address}`,
        token
      );
      setFishingState(state);
      if (state.actionToken) {
        setFishingActionToken(state.actionToken);
        fishingActionTokenRef.current = state.actionToken;
        actionTokenRef.current = state.actionToken;
      }
      return state;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fishing state fetch failed");
      return null;
    }
  }, [token, address]);

  /** Perform a fishing action (start_run or play_cards) */
  const fishingAction = useCallback(
    async (action: "start_run" | "play_cards", data: { cards: number[]; nodeId: string }) => {
      if (!token) return null;
      try {
        const result = await proxy<FishingActionResponse>(
          "/api/fishing/action",
          token,
          "POST",
          {
            action,
            actionToken: fishingActionTokenRef.current,
            data,
          }
        );
        if (result) {
          // Merge action response into fishing state shape
          // Action response wraps game state inside data.doc
          setFishingState((prev) => ({
            ...prev!,
            gameState: result.data.doc,
            actionToken: result.actionToken,
          }));
          if (result.actionToken) {
            setFishingActionToken(result.actionToken);
            fishingActionTokenRef.current = result.actionToken;
            // Sync dungeon token — server uses one shared token
            actionTokenRef.current = result.actionToken;
          }
        }
        return result;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Fishing action failed");
        return null;
      }
    },
    [token]
  );

  /** Sell fish at the Fish Stall */
  const sellFish = useCallback(
    async (fishId: number, amount: number, expectedValue: number) => {
      if (!token) return null;
      try {
        return await proxy<{ success: boolean; message?: string; data?: { value: number; boost: number }; gameItemBalanceChanges?: { id: number; amount: number }[] }>(
          "/api/fishing/sell",
          token,
          "POST",
          { fishId, amount, expectedValue }
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Fish sell failed");
        return null;
      }
    },
    [token]
  );

  return {
    // State
    token,
    address,
    noobId,
    username,
    loading,
    error,
    dungeonState,
    energy,
    dungeonToday,
    account,
    roms,
    actionToken,
    itemNames,
    itemInfo,
    enemyNames,
    enemyMoveRecords,
    worldRecipes,
    playerRecipes,
    skillTrees,
    skillProgress,
    itemBalances,
    fishingState,
    juiceExpiry,
    gearInstances,
    restoringSession,
    // Actions
    connect,
    disconnect,
    recordEnemyMove,
    refreshAll,
    autoBattleRef,
    performAction,
    fetchDungeonState,
    startRun,
    claimRom,
    convertEnergyToDust,
    useRecipe,
    fetchFishingState,
    fishingAction,
    sellFish,
    setToken,
  };
}
