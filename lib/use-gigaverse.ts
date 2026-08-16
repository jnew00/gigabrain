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
  WireFishingGameState,
  WireFishingActionResponse,
  GigaJuiceResponse,
  GearInstancesResponse,
  VendorListingsResponse,
} from "./types";
import { normalizeFishingState, normalizeActionResponse, pendingCatchCards } from "./fishing-state";
import { pondById } from "./ponds";
import { HATCHERY_FALLBACK_CONFIG, readHatcheryConfig, type HatcheryConfig } from "./hatchery";
import { indexGearDefs, type GearItemDef } from "./gear";
import {
  FEED_PAYLOAD_SHAPES,
  isRequestShapeComplaint,
  loadKnownShapeIndex,
  saveKnownShapeIndex,
  shapeOrder,
} from "./hatchery-feed";
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

/**
 * Item deltas seen while a capture is open.
 *
 * Every game action returns `gameItemBalanceChanges`, and every one of them
 * goes through proxy(), so accumulating here catches the whole haul — dungeon
 * loot, fish, chests, pots, trades, ROM claims — without each call site having
 * to remember to report. A call site that forgets is exactly how the run
 * summary ended up as counts with no items.
 *
 * Module-level rather than per-hook: one run is in flight at a time, and the
 * executor spans several components.
 */
let haulCapture: Map<number, number> | null = null;

export function beginHaulCapture(): void {
  haulCapture = new Map();
}

/**
 * The deltas so far, without closing the capture.
 *
 * The run modal shows the haul filling up while the run is still going, which
 * means reading the same accumulator the summary will later close over. Reading
 * it must not disturb it — an early `endHaulCapture` would hand the summary an
 * empty haul and lose everything collected after the peek.
 */
export function peekHaulCapture(): { id: number; amount: number }[] {
  return haulCapture
    ? Array.from(haulCapture, ([id, amount]) => ({ id, amount })).filter((e) => e.amount !== 0)
    : [];
}

/** Ends the capture and returns the net item deltas collected. */
export function endHaulCapture(): { id: number; amount: number }[] {
  const out = peekHaulCapture();
  haulCapture = null;
  return out;
}

/**
 * Fold one API response's item deltas into the open capture. Called by proxy()
 * for every response; exported so the accumulation can be tested directly
 * rather than only through begin/end.
 */
export function recordHaul(data: unknown): void {
  if (!haulCapture) return;
  const changes = (data as { gameItemBalanceChanges?: { id: number; amount: number }[] })
    ?.gameItemBalanceChanges;
  if (!Array.isArray(changes)) return;
  for (const c of changes) {
    if (typeof c?.id !== "number" || typeof c?.amount !== "number") continue;
    haulCapture.set(c.id, (haulCapture.get(c.id) ?? 0) + c.amount);
  }
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
    const err = new Error(data?.message || data?.error || `API error ${res.status}`);
    // Attach response data so callers can extract actionToken from error responses
    (err as Error & { responseData?: unknown }).responseData = data;
    throw err;
  }

  recordHaul(data);
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
  // Mirrors dungeonState for callbacks that must read it synchronously
  const dungeonStateRef = useRef<DungeonActionResponse | null>(null);
  const [energy, setEnergy] = useState<EnergyResponse | null>(null);
  const [dungeonToday, setDungeonToday] =
    useState<DungeonTodayResponse | null>(null);
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [roms, setRoms] = useState<RomsResponse | null>(null);
  const [actionToken, setActionToken] = useState<number>(Date.now());
  const [itemNames, setItemNames] = useState<Record<string, string>>({});
  const [itemInfo, setItemInfo] = useState<Record<string, { name: string; rarity?: number; rarityName?: string; icon?: string }>>({});
  const [enemyNames, setEnemyNames] = useState<Record<string, { name: string; stats?: number[] }>>({});
  const [worldRecipes, setWorldRecipes] = useState<RecipeEntity[]>([]);
  /** Server day number, for anything with a day-bounded window. */
  const [currentDay, setCurrentDay] = useState<number | undefined>(undefined);
  const [playerRecipes, setPlayerRecipes] = useState<PlayerRecipesResponse | null>(null);
  const [skillTrees, setSkillTrees] = useState<SkillTree[]>([]);
  const [skillProgress, setSkillProgress] = useState<SkillProgressEntity[]>([]);
  const [itemBalances, setItemBalances] = useState<Record<string, number>>({});
  const [fishingState, setFishingState] = useState<FishingGameState | null>(null);
  const [juiceExpiry, setJuiceExpiry] = useState<number | null>(null); // unix timestamp
  const [gearInstances, setGearInstances] = useState<GearInstancesResponse | null>(null);
  const [vendorListings, setVendorListings] = useState<VendorListingsResponse | null>(null);
  /**
   * Gear definitions by item id. These carry `repairCost`, whose
   * RESET_INPUT arrays say whether a gear can be restored at all and at what
   * price — the difference between "farm more Gear Ember" and "this item is
   * finished, burn it".
   */
  const [gearDefs, setGearDefs] = useState<Record<number, GearItemDef>>({});
  const [pets, setPets] = useState<unknown>(null);
  const [hatcheryConfig, setHatcheryConfig] = useState<HatcheryConfig>(
    HATCHERY_FALLBACK_CONFIG
  );
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
        const [acc, eng, ds, dt, rm, items, staticData, playerRecipeData, balancesData, juiceData, gearData, gearDefsData, vendorData] = await Promise.all([
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
          proxy<unknown>("/api/gear/items", jwt).catch(() => null),
          proxy<VendorListingsResponse>(`/api/vendor/listings?wallet=${me.address}`, jwt).catch(() => null),
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
        if (typeof staticData?.currentDay === "number") {
          setCurrentDay(staticData.currentDay);
        }
        // Hatchery bounds ship inside the same payload, so the advisor tracks
        // the game rather than a copy of it.
        setHatcheryConfig(readHatcheryConfig(staticData));
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
        if (gearDefsData) setGearDefs(indexGearDefs(gearDefsData));

        // Store traveling merchant listings
        if (vendorData) setVendorListings(vendorData);

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
        dungeonStateRef.current = ds;
        setDungeonState(ds);
        setDungeonToday(dt);
        setRoms(rm);
        if (ds.actionToken) {
          setActionToken(ds.actionToken);
          actionTokenRef.current = ds.actionToken;
        }

        // Persist JWT
        saveAuth(jwt, expiresAt);

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

  const disconnect = useCallback(() => {
    setToken("");
    setAddress("");
    setNoobId("");
    setUsername("");
    dungeonStateRef.current = null;
    setDungeonState(null);
    setEnergy(null);
    setDungeonToday(null);
    setAccount(null);
    setRoms(null);
    setItemNames({});
    setItemInfo({});
    setEnemyNames({});
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
      const [eng, dt, rm, pr, bal, fs, gear, vendor] = await Promise.all([
        proxy<EnergyResponse>(`/api/offchain/player/energy/${address}`, token),
        proxy<DungeonTodayResponse>("/api/game/dungeon/today", token),
        proxy<RomsResponse>(`/api/roms/player?id=${address.toLowerCase()}`, token),
        proxy<PlayerRecipesResponse>(`/api/offchain/recipes/player/${address}`, token),
        proxy<ItemBalancesResponse>("/api/items/balances", token),
        proxy<FishingGameState>(`/api/fishing/state/${address}`, token).catch(() => null),
        proxy<GearInstancesResponse>(`/api/gear/instances/${address}`, token).catch(() => null),
        proxy<VendorListingsResponse>(`/api/vendor/listings?wallet=${address}`, token).catch(() => null),
      ] as const);
      setEnergy(eng);
      setDungeonToday(dt);
      setRoms(rm);
      setPlayerRecipes(pr);
      if (gear) setGearInstances(gear);
      if (vendor) setVendorListings(vendor);
      if (bal?.entities) {
        const bals: Record<string, number> = {};
        for (const b of bal.entities) bals[b.ID_CID] = b.BALANCE_CID;
        setItemBalances(bals);
      }
      if (fs) {
        setFishingState(fs);
        // Only update fishing token ref if not in auto-battle — the fishing
        // state endpoint returns a stale token that clobbers the current one
        if (fs.actionToken && !autoBattleRef.current) {
          console.log(`[TOKEN] refreshAll fishing → clobbering token from ${actionTokenRef.current} to ${fs.actionToken}`);
          setFishingActionToken(fs.actionToken);
          fishingActionTokenRef.current = fs.actionToken;
          actionTokenRef.current = fs.actionToken;
        } else if (fs.actionToken && autoBattleRef.current) {
          console.log(`[TOKEN] refreshAll fishing → SKIPPED (autoBattle=true), would have set ${fs.actionToken}`);
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

  // Synchronous error ref — readable immediately after startRun/performAction returns null
  const lastErrorRef = useRef<string | null>(null);

  const performAction = useCallback(
    async (action: DungeonAction, dungeonId: number = 0) => {
      if (!token) return null;

      // Refs only. The auto-play loops read these synchronously and
      // deliberately don't depend on a re-render, so recovery paths must not
      // trigger one mid-run; the success path still publishes to state below.
      const adoptToken = (t: number) => {
        actionTokenRef.current = t;
        fishingActionTokenRef.current = t;
      };

      const send = async () => {
        console.log(`[TOKEN] performAction(${action}) sending token=${actionTokenRef.current}`);
        const result = await proxy<DungeonActionResponse>(
          "/api/game/dungeon/action",
          token,
          "POST",
          {
            action,
            actionToken: actionTokenRef.current,
            dungeonId,
            data: {
              consumables: [],
              itemId: 0,
              expectedAmount: 0,
              index: 0,
              gearInstanceIds: [],
            },
          }
        );
        if (result) {
          dungeonStateRef.current = result;
          setDungeonState(result);
          if (result.actionToken) {
            console.log(`[TOKEN] performAction(${action}) OK → new token=${result.actionToken}`);
            adoptToken(result.actionToken);
            setActionToken(result.actionToken);
          }
        }
        return result;
      };

      const tokenFrom = (e: unknown) =>
        (e as Error & { responseData?: { actionToken?: number } }).responseData?.actionToken;

      // No retry here. Feeding the server the exact actionToken it returned in
      // its own rejection still got refused, so the token is minted per request
      // and is a symptom rather than the cause — the move itself is what the
      // server won't accept. Recover the token, report, and let the caller
      // refetch state and pick again against reality.
      const believed = dungeonStateRef.current;

      try {
        return await send();
      } catch (e) {
        const recovered = tokenFrom(e);

        // Always refetch on failure. Two jobs: recover a usable token, and show
        // what the server thought was going on versus what we believed, which
        // is the only way to separate a phase desync from an unplayable move.
        let fresh: DungeonActionResponse | null = null;
        try {
          fresh = await proxy<DungeonActionResponse>("/api/game/dungeon/state", token);
        } catch { /* ignore */ }

        const view = (s: DungeonActionResponse | null) => {
          const r = s?.data?.run;
          const p = r?.players?.[0];
          if (!r) return "no run";
          return [
            `loot=${r.lootPhase ? "YES" : "no"}`,
            `opts=${r.lootOptions?.length ?? 0}`,
            `room=${s?.data?.entity?.ROOM_NUM_CID ?? "?"}`,
            p ? `charges r${p.rock.currentCharges}/p${p.paper.currentCharges}/s${p.scissor.currentCharges}` : "no player",
            p ? `hp=${p.health.current}` : "",
            `msg=${s?.message ?? ""}`,
          ].join(" ");
        };

        console.warn(
          `[ACTION FAILED] sent "${action}"\n` +
            `   we believed : ${view(believed)}\n` +
            `   server says : ${view(fresh)}`
        );

        if (fresh?.actionToken) {
          adoptToken(fresh.actionToken);
        } else if (recovered) {
          adoptToken(recovered);
        }
        setError(e instanceof Error ? e.message : "Action failed");
        return null;
      }
    },
    [token]
  );

  /** Fetch fresh dungeon state directly (bypasses async React state) */
  const fetchDungeonState = useCallback(async () => {
    if (!token) return null;
    console.log(`[TOKEN] fetchDungeonState (current ref=${actionTokenRef.current})`);
    try {
      const ds = await proxy<DungeonActionResponse>("/api/game/dungeon/state", token);
      dungeonStateRef.current = ds;
      setDungeonState(ds);
      if (ds.actionToken) {
        console.log(`[TOKEN] fetchDungeonState → new token=${ds.actionToken}`);
        setActionToken(ds.actionToken);
        actionTokenRef.current = ds.actionToken;
        fishingActionTokenRef.current = ds.actionToken;
      }
      return ds;
    } catch {
      return null;
    }
  }, [token]);

  /**
   * Start a dungeon run.
   *
   * `entryTier` is the offering index the Forbidden Woods charges a faction
   * ring for: 1 is free at 1x Hard Cores, 2 costs a Silver ring for 2x, 3 costs
   * a Golden ring for 4x. `isJuiced` is the per-run mode that charges 3x energy
   * for 3x rewards — unrelated to the Giga Juice subscription despite the name.
   */
  const startRun = useCallback(
    async (dungeonId: number = 0, isJuiced = false, gearInstanceIds: string[] = [], entryTier = 1) => {
      if (!token) return null;
      setLoading(true);
      setError(null);
      console.log(`[TOKEN] startRun sending token=${actionTokenRef.current}`);
      try {
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
              index: entryTier,
              isJuiced,
              gearInstanceIds,
              devBoons: [],
            },
          }
        );
        dungeonStateRef.current = result;
        setDungeonState(result);
        if (result.actionToken) {
          setActionToken(result.actionToken);
          actionTokenRef.current = result.actionToken;
          fishingActionTokenRef.current = result.actionToken;
        }
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Start run failed";
        lastErrorRef.current = msg;
        // Recover token from error response — server rotates even on failure
        const respData = (e as Error & { responseData?: { actionToken?: number } }).responseData;
        if (respData?.actionToken) {
          actionTokenRef.current = respData.actionToken;
          fishingActionTokenRef.current = respData.actionToken;
        } else {
          try {
            const fresh = await proxy<DungeonActionResponse>("/api/game/dungeon/state", token);
            if (fresh?.actionToken) {
              actionTokenRef.current = fresh.actionToken;
              fishingActionTokenRef.current = fresh.actionToken;
            }
          } catch { /* ignore */ }
        }
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [token]
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

  // Mirror of itemBalances readable synchronously inside callbacks
  const itemBalancesRef = useRef(itemBalances);
  itemBalancesRef.current = itemBalances;

  /** Use a recipe (pots, chests, etc.) */
  const useRecipe = useCallback(
    async (recipeId: string, gearInstanceId: string = "") => {
      if (!token || !noobId) return null;
      const balancesBefore = itemBalancesRef.current;
      const result = await proxy<{ success: boolean; message?: string; data?: unknown; entities?: unknown[]; gameItemBalanceChanges?: { id: number; amount: number }[] }>(
        "/api/offchain/recipes/start",
        token,
        "POST",
        { recipeId, noobId: Number(noobId), gearInstanceId, nodeIndex: 0, quantity: 1 }
      );
      // The recipes endpoint doesn't itemize loot — derive it from the
      // item-balance delta so pot/chest results can show what dropped
      // (skip when the before-snapshot never loaded — a diff against an empty
      // map would report the whole inventory as loot)
      if (result && result.success !== false && !result.gameItemBalanceChanges?.length && Object.keys(balancesBefore).length > 0) {
        try {
          await new Promise((r) => setTimeout(r, 600));
          const bal = await proxy<ItemBalancesResponse>("/api/items/balances", token);
          if (bal?.entities) {
            const bals: Record<string, number> = {};
            for (const b of bal.entities) bals[b.ID_CID] = b.BALANCE_CID;
            setItemBalances(bals);
            itemBalancesRef.current = bals;
            const changes: { id: number; amount: number }[] = [];
            const deltas: { id: number; amount: number }[] = [];
            for (const [id, v] of Object.entries(bals)) {
              const delta = v - (balancesBefore[id] ?? 0);
              if (delta > 0) changes.push({ id: Number(id), amount: delta });
              if (delta !== 0) deltas.push({ id: Number(id), amount: delta });
            }
            if (changes.length > 0) result.gameItemBalanceChanges = changes;
            // Hand the deltas to the open haul capture as well.
            //
            // recordHaul() runs inside proxy(), which has already returned by
            // the time this diff exists — so a pot or chest showed its loot in
            // the activity log, which reads this result object, and contributed
            // nothing to the haul pane, which reads the capture. Everything
            // else in a run reports through gameItemBalanceChanges on the
            // response and was never affected, which is what made the gap look
            // like the pots not dropping anything.
            //
            // The haul takes losses too, unlike the loot line above: a merchant
            // trade routed through this same call spends items to gain them,
            // and a net view that counts only the gains is an advert.
            if (deltas.length > 0) recordHaul({ gameItemBalanceChanges: deltas });
          }
        } catch {
          // Loot itemization is best-effort — the recipe itself succeeded
        }
      }
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

  /**
   * Read the hatchery.
   *
   * One call does it: `/api/pets/player?id=` lists the eggs and carries the
   * live incubation stats on each placed one, under `data.hatcheryStatus`.
   * There is no separate hatchery read to pair it with — on 2026-08-12
   * `/api/pets/hatchery` answered 400 and the address-suffixed form 405 — so
   * the normalizer's second source is left empty rather than pointing at
   * endpoints that don't answer.
   */
  const fetchHatchery = useCallback(async () => {
    if (!token || !address) return null;
    const petsData = await proxy<unknown>(
      `/api/pets/player?id=${address.toLowerCase()}`,
      token
    ).catch(() => null);
    if (petsData) setPets(petsData);
    return { pets: petsData, hatchery: null };
  }, [token, address]);

  /**
   * Feed one unit of one material to one egg.
   *
   * Deliberately one unit per call, and deliberately not batched. How much a
   * single Biofuel or Incube moves its stat is not published anywhere and could
   * not be observed without an authenticated session, so a batched call could
   * overshoot and burn materials on a stat that was already full. One unit at a
   * time is correct whatever the real delta turns out to be, and re-reading the
   * egg between feeds is what will eventually measure it.
   *
   * The request body could never be observed — the endpoint is authenticated —
   * so the shape is discovered against the server instead of guessed at. The
   * ladder in hatchery-feed.ts explains why that is safe here and, more
   * importantly, when it refuses to climb: only a complaint about the request
   * advances it, so a real refusal ("not enough Incube") is reported once
   * rather than re-asked in four spellings.
   *
   * The winning shape is remembered, so this costs a few round trips once and
   * nothing afterwards.
   */
  const feedEgg = useCallback(
    async (petId: string, itemId: number) => {
      if (!token) return null;

      type FeedResponse = {
        success?: boolean;
        message?: string;
        error?: string;
        gameItemBalanceChanges?: { id: number; amount: number }[];
      };

      let lastResult: FeedResponse | null = null;
      let lastError: Error | null = null;

      for (const index of shapeOrder(loadKnownShapeIndex())) {
        const shape = FEED_PAYLOAD_SHAPES[index];
        try {
          const res = await proxy<FeedResponse>(
            "/api/pets/feed",
            token,
            "POST",
            shape.build(petId, itemId)
          );
          if (res?.success !== false) {
            saveKnownShapeIndex(index);
            return res;
          }
          lastResult = res;
          if (!isRequestShapeComplaint(res.error ?? res.message)) return res;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          // A proxy-level throw carries the upstream body, which is where the
          // validation message lives on a 400.
          const body = (lastError as Error & { responseData?: FeedResponse }).responseData;
          const message = body?.error ?? body?.message ?? lastError.message;
          if (!isRequestShapeComplaint(message)) throw lastError;
          lastResult = body ?? null;
        }
      }

      // Every candidate was rejected as malformed. Surfacing the last message
      // beats inventing one: it is the only description of what the endpoint
      // actually wants.
      if (lastResult) return lastResult;
      if (lastError) throw lastError;
      return null;
    },
    [token]
  );

  /** Fetch current fishing game state */
  const fetchFishingState = useCallback(async () => {
    if (!token || !address) return null;
    try {
      const wire = await proxy<WireFishingGameState>(
        `/api/fishing/state/${address}`,
        token
      );
      const state = normalizeFishingState(wire, (dropped) => {
        // A fish whose pond is unknown cannot be sold — /api/fishing/sell needs
        // the pondId — so say so rather than letting it vanish from the stall.
        setError(
          `Fishing state returned ${dropped.length} exchange rate(s) with no pondId ` +
            `(items ${dropped.map((d) => d.id).join(", ")}). Those fish can't be sold until the pond is known.`
        );
      });
      setFishingState(state);
      if (state.actionToken) {
        setFishingActionToken(state.actionToken);
        fishingActionTokenRef.current = state.actionToken;
        // Only update shared actionTokenRef if not in auto-battle — the fishing
        // state endpoint returns a stale token that clobbers the current one
        if (!autoBattleRef.current) {
          actionTokenRef.current = state.actionToken;
        }
      }
      return state;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fishing state fetch failed");
      return null;
    }
  }, [token, address]);

  /**
   * Perform a fishing action.
   *
   * Redraw is not its own action: it is `play_cards` with an empty `cards`
   * array. Verified from a live cast on 2026-08-11 — hand [6,10,9] became
   * [7,5,4], the draw pile fell by three and mana by three, i.e. one per card
   * held. That is why no redraw verb exists in the client's ACTIONS table.
   */
  const fishingAction = useCallback(
    async (
      action: "start_run" | "play_cards" | "loot",
      data: {
        cards: number[];
        nodeId: string;
        /** Grove offering: 1 free at 1x Cores, 2 is 2x, 3 is 4x. 0 elsewhere. */
        tierId?: number;
        /** Where the lure sits. Sent on every card play, not a separate action. */
        focusPoint?: number[];
        /** Fishing oil to consume, with the slot it occupies */
        itemId?: number;
        slotIndex?: number;
      }
    ) => {
      if (!token || !address) return null;

      const doRequest = async (a: string, tkn: string, d: typeof data) => {
        const wire = await proxy<WireFishingActionResponse>(
          "/api/fishing/action",
          token,
          "POST",
          {
            action: a,
            actionToken: tkn,
            // The server expects every field on every action; the classic
            // ponds simply send the zero values.
            data: {
              cards: d.cards,
              nodeId: d.nodeId,
              focusPoint: d.focusPoint ?? [],
              itemId: d.itemId ?? 0,
              slotIndex: d.slotIndex ?? 0,
              tierId: d.tierId ?? 0,
            },
          }
        );
        // Rename `seaweedEarned` before anything downstream can read it.
        const result = wire ? normalizeActionResponse(wire) : wire;
        if (result) {
          const gd = result.data.doc.data;
          if (gd) {
            console.log("[FISH-DEBUG] raw API →", JSON.stringify({
              fishPosition: gd.fishPosition,
              previousFishPosition: gd.previousFishPosition,
              nextPosition: gd.nextPosition,
              fishHp: gd.fishHp,
              fishMaxHp: gd.fishMaxHp,
              hand: gd.hand,
              caughtFish: gd.caughtFish ?? null,
            }));
            if (gd.caughtFish) {
              console.log("[FISH-DEBUG] full caughtFish →", JSON.stringify(gd.caughtFish));
              console.log("[FISH-DEBUG] full response doc →", JSON.stringify(result.data.doc));
            }
          }
          setFishingState((prev) => ({
            ...prev!,
            gameState: result.data.doc,
            actionToken: result.actionToken,
          }));
          if (result.actionToken) {
            setFishingActionToken(result.actionToken);
            fishingActionTokenRef.current = result.actionToken;
            actionTokenRef.current = result.actionToken;
          }
        }
        return result;
      };

      try {
        const tkn = String(actionTokenRef.current);
        return await doRequest(action, tkn, data);
      } catch (e) {
        const respData = (e as Error & { responseData?: { actionToken?: number } }).responseData;
        if (respData?.actionToken) {
          actionTokenRef.current = respData.actionToken;
          fishingActionTokenRef.current = respData.actionToken;
        }

        // If start_run failed, check if there's a completed game needing loot
        if (action === "start_run") {
          try {
            const state = normalizeFishingState(
              await proxy<WireFishingGameState>(`/api/fishing/state/${address}`, token)
            );
            // A catch still owed — collect it, which also opens the cast the
            // failed start_run was after. `cardsToAdd` alone is not that test:
            // it stays on a game whose spell was already taken, and looting one
            // of those is answered "Card already chosen".
            const owed = pendingCatchCards(state?.gameState);
            if (owed) {
              return await doRequest("loot", String(actionTokenRef.current), {
                cards: [owed[0].id],
                nodeId: data.nodeId,
              });
            }
            // A cast is already open — the server refuses a second start_run,
            // and retrying it just fails the same way. Adopt the running cast
            // and let the caller play it out. This happens routinely after
            // playing in the official client, which leaves a cast mid-flight.
            if (state?.gameState && !state.gameState.COMPLETE_CID) {
              setFishingState(state);
              if (state.actionToken) {
                setFishingActionToken(state.actionToken);
                fishingActionTokenRef.current = state.actionToken;
                actionTokenRef.current = state.actionToken;
              }
              return {
                success: true,
                message: "Resumed cast already in progress",
                data: { doc: state.gameState },
                actionToken: state.actionToken,
              } as FishingActionResponse;
            }
          } catch { /* fall through */ }

          // No completed game — just retry with recovered token
          try {
            return await doRequest(action, String(actionTokenRef.current), data);
          } catch (e2) {
            const rd2 = (e2 as Error & { responseData?: { actionToken?: number } }).responseData;
            if (rd2?.actionToken) {
              actionTokenRef.current = rd2.actionToken;
              fishingActionTokenRef.current = rd2.actionToken;
            }
          }
        }

        const msg = e instanceof Error ? e.message : "Fishing action failed";
        lastErrorRef.current = msg;
        setError(msg);
        return null;
      }
    },
    [token, address]
  );

  /**
   * Repair or restore one gear instance at the Gear Station.
   *
   * The two are the same request against different paths — verified on
   * 2026-08-12 by sending the same instance under two field names: only
   * `gearInstanceId` reached it, `docId` came back "Gear instance not found".
   *
   * Restore is where repair sends you once an instance is out of repairs
   * ("already at max repair count 2 of 2. Use restore endpoint instead"). What
   * it charges is not published anywhere and has never been observed, so
   * nothing here assumes it is free — the server's own message is returned
   * intact for the caller to show.
   */
  const gearStationAction = useCallback(
    async (path: "repair" | "restore", gearInstanceId: string) => {
      if (!token) return null;
      try {
        const result = await proxy<{ success?: boolean; message?: string }>(
          `/api/gear/${path}`,
          token,
          "POST",
          { gearInstanceId }
        );
        // Refresh gear so durability warnings clear immediately
        if (address) {
          proxy<GearInstancesResponse>(`/api/gear/instances/${address}`, token)
            .then((gear) => { if (gear) setGearInstances(gear); })
            .catch(() => {});
        }
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : `${path} failed`;
        lastErrorRef.current = msg;
        setError(msg);
        return null;
      }
    },
    [token, address]
  );

  const repairGear = useCallback(
    (gearInstanceId: string) => gearStationAction("repair", gearInstanceId),
    [gearStationAction]
  );

  const restoreGear = useCallback(
    (gearInstanceId: string) => gearStationAction("restore", gearInstanceId),
    [gearStationAction]
  );

  /** Refetch skill progress + currency balances (after level-ups) */
  const refreshSkills = useCallback(async () => {
    if (!token) return;
    try {
      const fetches: Promise<void>[] = [
        proxy<ItemBalancesResponse>("/api/items/balances", token).then((bal) => {
          if (bal?.entities) {
            const bals: Record<string, number> = {};
            for (const b of bal.entities) bals[b.ID_CID] = b.BALANCE_CID;
            setItemBalances(bals);
            itemBalancesRef.current = bals;
          }
        }),
      ];
      if (noobId) {
        fetches.push(
          proxy<SkillProgressResponse>(`/api/offchain/skills/progress/${noobId}`, token).then((sp) => {
            if (sp?.entities) setSkillProgress(sp.entities);
            else if (Array.isArray(sp)) setSkillProgress(sp as SkillProgressEntity[]);
          })
        );
      }
      await Promise.all(fetches);
    } catch {
      // Non-fatal — UI just shows stale levels until next refresh
    }
  }, [token, noobId]);

  /** Level up one skill stat. Costs the tree's currency (scrap/shards/seaweed). */
  const levelUpSkill = useCallback(
    async (skillId: number, statId: number) => {
      if (!token || !noobId) return null;
      try {
        return await proxy<{ success?: boolean; message?: string }>(
          "/api/game/skill/levelup",
          token,
          "POST",
          { skillId, statId, noobId: Number(noobId) }
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Skill level-up failed";
        lastErrorRef.current = msg;
        setError(msg);
        return null;
      }
    },
    [token, noobId]
  );

  /**
   * Sell fish at the Fish Stall.
   *
   * `pondId` became required when the Awakening added the Dendren Grove — with
   * two stalls the server can no longer infer which one buys a given fish, and
   * omitting it fails with MissingPondId. The pond for each fish is on its
   * `exchangeRates` entry in the fishing state.
   *
   * It has no default on purpose. A default of 1 would send a third pond's fish
   * to the classic stall, which either fails or pays the wrong currency — and
   * `pondById` throws first, before any request goes out.
   */
  const sellFish = useCallback(
    async (fishId: number, amount: number, expectedValue: number, pondId: number) => {
      if (!token) return null;
      pondById(pondId);
      try {
        return await proxy<{ success: boolean; message?: string; data?: { value: number; boost: number }; gameItemBalanceChanges?: { id: number; amount: number }[] }>(
          "/api/fishing/sell",
          token,
          "POST",
          { fishId, amount, expectedValue, pondId }
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
    worldRecipes,
    currentDay,
    playerRecipes,
    skillTrees,
    skillProgress,
    itemBalances,
    fishingState,
    juiceExpiry,
    gearInstances,
    gearDefs,
    vendorListings,
    pets,
    hatcheryConfig,
    restoringSession,
    // Actions
    connect,
    disconnect,
    refreshAll,
    autoBattleRef,
    lastErrorRef,
    performAction,
    fetchDungeonState,
    startRun,
    claimRom,
    convertEnergyToDust,
    useRecipe,
    fetchFishingState,
    fishingAction,
    sellFish,
    fetchHatchery,
    feedEgg,
    levelUpSkill,
    refreshSkills,
    repairGear,
    restoreGear,
    setToken,
  };
}
