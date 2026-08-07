// Canonical game constants from https://docs.gigaverse.io (August 2026).
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
    name: "Dungetron: Underhaul",
    energyCost: 40,
    maxRunsPerDay: 9,
    juicedMaxRunsPerDay: 12,
    currency: "Giga Shards",
    yields: "Giga Shards + items/materials/skins",
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
  // Base limit: explicit API field, then verified doc constants for known
  // dungeons, then UINT256_CID (believed to be the base limit) for unknown
  // ones, finally derive from the juiced limit
  if (d.maxRunsPerDay && d.maxRunsPerDay > 0) return d.maxRunsPerDay;
  if (info) return info.maxRunsPerDay;
  if (d.UINT256_CID && d.UINT256_CID > 0 && d.UINT256_CID <= 50) return d.UINT256_CID;
  return Math.max(1, (d.juicedMaxRunsPerDay || 12) - 2);
}

export const FISHING = {
  maxCastsPerDay: 10,
  juicedMaxCastsPerDay: 20,
  nodes: [
    { nodeId: "0", label: "Small", cost: 12 },
    { nodeId: "1", label: "Normal", cost: 16 },
    { nodeId: "2", label: "Big", cost: 20 },
  ],
} as const;

export const ENERGY = {
  baseDaily: 240,
  juicedDaily: 420,
  baseRegenPerHour: 10,
  juicedRegenPerHour: 17.5,
} as const;

export const POT_ENERGY_COST = 5;
