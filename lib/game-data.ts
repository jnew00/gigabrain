// Canonical game constants from https://docs.gigaverse.io (August 2026).
// API data wins where available.
// API data wins where available — these are fallbacks + doc-only facts
// (base run limits, mode descriptions) the API doesn't expose.

export interface DungeonInfo {
  /** Substring match against NAME_CID (lowercased) */
  match: string;
  name: string;
  energyCost: number;
  maxRunsPerDay: number;
  juicedMaxRunsPerDay: number;
  currency: string;
  /** What a run yields — used by the advisor to explain recommendations */
  yields: string;
  /** Only source of its reward currency */
  exclusiveSource?: boolean;
  /** Event-only dungeon with item-based entry (no energy) */
  eventOnly?: boolean;
}

export const DUNGEON_INFO: DungeonInfo[] = [
  {
    match: "underhaul",
    name: "Underhaul",
    energyCost: 40,
    // Verified against /api/game/dungeon/today on 2026-08-10: base 8, juiced 9.
    // The docs said 9/12; that cost the plan 3 phantom runs (120E) when juiced.
    maxRunsPerDay: 8,
    juicedMaxRunsPerDay: 9,
    currency: "Giga Shards",
    yields: "Giga Shards + items/materials/skins",
  },
  {
    match: "forbidden",
    name: "Forbidden Woods",
    energyCost: 20,
    maxRunsPerDay: 12,
    juicedMaxRunsPerDay: 12, // Juice multiplies Cores, not the run count
    currency: "Hard Cores",
    yields: "Hard Cores + Dendren Remnants",
    // Deliberately not exclusiveSource: that flag routes a dungeon into the
    // advisor's Gigus gate, which allocates last behind a deep-clear check.
    // Hard Cores are handled by the event pass instead.
  },
  {
    match: "gigus",
    name: "Dungetron 5000: Gigus",
    energyCost: 200,
    maxRunsPerDay: 30,
    juicedMaxRunsPerDay: 30,
    currency: "Gigus materials",
    yields: "Gigus materials (no scrap)",
    exclusiveSource: true,
  },
  {
    match: "void",
    name: "Dungetron: Void",
    energyCost: 0,
    maxRunsPerDay: 0, // no daily limit; item-based entry per event
    juicedMaxRunsPerDay: 0,
    currency: "Void essence / event rewards",
    yields: "Event rewards, gigabit jackpots",
    eventOnly: true,
  },
  {
    // Keep last: "5000"/"normal" would also match Gigus by name otherwise
    match: "5000",
    name: "Dungetron 5000: Normal",
    energyCost: 40,
    maxRunsPerDay: 10,
    juicedMaxRunsPerDay: 12,
    currency: "Dungeon Scrap",
    yields: "Dungeon Scrap + items/materials/skins",
  },
];

export function findDungeonInfo(name: string): DungeonInfo | undefined {
  const lower = name.toLowerCase();
  return DUNGEON_INFO.find((d) => lower.includes(d.match));
}

/**
 * Max runs/day for a dungeon, juice-aware. Prefers API fields
 * (juicedMaxRunsPerDay, UINT256_CID appears to be the base limit),
 * falls back to doc constants by name.
 */
export function getMaxRunsPerDay(
  d: { NAME_CID: string; juicedMaxRunsPerDay?: number; maxRunsPerDay?: number; UINT256_CID?: number },
  isJuiced: boolean
): number {
  const info = findDungeonInfo(d.NAME_CID);
  if (isJuiced) {
    return d.juicedMaxRunsPerDay || info?.juicedMaxRunsPerDay || 12;
  }
  // Base limit. UINT256_CID is confirmed to be it — checked against
  // /api/game/dungeon/today on 2026-08-10, where Dungetron 5000 reports 10,
  // Underhaul 8, and Forbidden Woods 12. It now outranks the doc constants so
  // the app follows the game when limits change, rather than a stale table.
  if (d.maxRunsPerDay && d.maxRunsPerDay > 0) return d.maxRunsPerDay;
  if (d.UINT256_CID && d.UINT256_CID > 0 && d.UINT256_CID <= 50) return d.UINT256_CID;
  if (info) return info.maxRunsPerDay;
  return Math.max(1, (d.juicedMaxRunsPerDay || 12) - 2);
}

/**
 * The Awakening — seasonal event, verified against /api/offchain/static
 * (liveEvent) on 2026-08-10. Hard Cores are earned in the Forbidden Woods
 * dungeon and the Dendren Grove pond, and stop existing when it ends, so the
 * advisor funds them ahead of permanent currencies while the window is open.
 */
export const AWAKENING = {
  name: "The Awakening",
  /** Game item ID for Hard Core */
  coreItemId: 845,
  startTimestamp: 1786384800, // 2026-08-10 18:00 UTC
  endTimestamp: 1791655200,   // 2026-10-10 18:00 UTC
  /** NAME_CID substrings that identify the event's dungeon */
  dungeonMatches: ["forbidden", "woods", "grove", "dendren", "awakening"],
  /**
   * The pond the event opened. Its nodes, currency and board live in
   * lib/ponds.ts with every other pond's — this is only the cross-reference,
   * so event code can find it without knowing the number.
   */
  pondId: 2,
} as const;

/** True while the event window is open — everything event-specific gates on this */
export function isAwakeningActive(nowSeconds: number = Date.now() / 1000): boolean {
  return nowSeconds >= AWAKENING.startTimestamp && nowSeconds < AWAKENING.endTimestamp;
}

/** Does this dungeon drop Hard Cores? Matched by name — no API flag exposes it. */
export function isEventDungeon(name: string): boolean {
  const lower = name.toLowerCase();
  return AWAKENING.dungeonMatches.some((m) => lower.includes(m));
}

/**
 * Highest entry offering the player can pay for out of inventory.
 *
 * Never buys: an offering ring is a Legendary collectable and whether one is
 * worth 2x or 4x Cores on a single run is a market question, not a rule.
 *
 * `inputsBasedOnFactionDay` means the server picks WHICH of the listed rings it
 * wants from your faction and the day, and that mapping is not documented. So
 * this treats a tier as payable when any listed ring is held in sufficient
 * quantity, and the caller falls back to tier 1 if the server disagrees — a
 * rejected start_run consumes neither a ring nor a daily run.
 */
export function pickEntryTier(
  entryData: {
    tier: number;
    inputItems: number[];
    inputAmounts: number[];
  }[] | undefined,
  balances: Record<string, number>
): number {
  if (!entryData?.length) return 1;
  let best = 1;
  for (const t of entryData) {
    if (t.tier <= best) continue;
    if (!t.inputItems?.length) continue;
    const payable = t.inputItems.some((itemId, i) => {
      const need = t.inputAmounts?.[i] ?? 1;
      return (balances[String(itemId)] ?? 0) >= need;
    });
    if (payable) best = t.tier;
  }
  return best;
}

/**
 * The daily cast allowance. One shared pool across every pond — the cap is on
 * casts, not on any particular water. Per-pond nodes live in lib/ponds.ts.
 *
 * Confirmed against /api/fishing/state on 2026-08-11: maxPerDay 10,
 * maxPerDayJuiced 20, and the live values there outrank these fallbacks.
 */
export const FISHING = {
  maxCastsPerDay: 10,
  juicedMaxCastsPerDay: 20,
} as const;

/**
 * Cheapest available unit price, in ETH, from a marketplace listing set.
 *
 * Listings arrive unsorted and some are exhausted (UINT256_CID 0) while still
 * being returned, so both have to be handled before taking a floor.
 */
export function listingFloorEth(
  listings: { ETH_MINT_PRICE_CID: number; UINT256_CID: number }[] | undefined
): { eth: number; qty: number } | null {
  const live = (listings ?? []).filter((l) => (l.UINT256_CID ?? 0) > 0);
  if (!live.length) return null;
  const cheapest = live.reduce((a, b) => (b.ETH_MINT_PRICE_CID < a.ETH_MINT_PRICE_CID ? b : a));
  return { eth: cheapest.ETH_MINT_PRICE_CID / 1e18, qty: cheapest.UINT256_CID };
}

export const POT_ENERGY_COST = 5;

/**
 * Every recipe that is a free or near-free periodic claim.
 *
 * Single source of truth deliberately: this list lived duplicated in the Run
 * Plan and the Pots & Chests panel, and when the Awakening added a second
 * juiced chest only one copy was updated — so the plan claimed a chest the
 * panel never showed, and the nav badge under-counted. Adding a future event's
 * claim should be one line here and nowhere else.
 */
export interface ClaimRecipe {
  /** Stable handle for code that needs one specific claim */
  key: "chest" | "juiceChest" | "juiceChestForest" | "bluePot" | "tanPot";
  id: string;
  label: string;
  desc: string;
  /** Energy to break it open; chests are free */
  energy: number;
  /** Requires an active Giga Juice subscription */
  needsJuice: boolean;
  /** Gear that must be equipped, for pots */
  handsType: string | null;
}

export const CLAIM_RECIPES: ClaimRecipe[] = [
  {
    key: "chest", id: "Recipe#700000", label: "Weekly Chest",
    desc: "Free weekly loot chest", energy: 0, needsJuice: false, handsType: null,
  },
  {
    key: "juiceChest", id: "Recipe#700003", label: "Juiced Chest",
    desc: "Bonus chest for juiced players", energy: 0, needsJuice: true, handsType: null,
  },
  {
    // Added with the Awakening's forest area, on its own weekly cooldown
    key: "juiceChestForest", id: "Recipe#700004", label: "Juiced Chest (Forest)",
    desc: "Bonus chest in the Awakening forest", energy: 0, needsJuice: true, handsType: null,
  },
  {
    key: "bluePot", id: "Recipe#700001", label: "Blue Pot",
    desc: "Break with Paper Hands — materials + shards",
    energy: POT_ENERGY_COST, needsJuice: false, handsType: "Paper Hands",
  },
  {
    key: "tanPot", id: "Recipe#700002", label: "Tan Pot",
    desc: "Break with Rock Hands — materials + bones + consumables",
    energy: POT_ENERGY_COST, needsJuice: false, handsType: "Rock Hands",
  },
];

/** Recipe id by handle, for the few call sites that need a named one. */
export const CLAIM_RECIPE_IDS = Object.fromEntries(
  CLAIM_RECIPES.map((r) => [r.key, r.id])
) as Record<ClaimRecipe["key"], string>;

export const ENERGY = {
  baseDaily: 240,
  juicedDaily: 420,
  baseRegenPerHour: 10,
  juicedRegenPerHour: 17.5,
} as const;
