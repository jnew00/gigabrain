// Gigaverse API type definitions - reverse-engineered March 2026

import type { PondEntryTier } from "./ponds";

// ─── Player / Combat ───────────────────────────────────────────

export interface MoveStats {
  startingATK: number;
  startingDEF: number;
  currentATK: number;
  currentDEF: number;
  currentCharges: number;
  maxCharges: number;
}

export interface HealthOrShield {
  current: number;
  starting: number;
  currentMax: number;
  startingMax: number;
}

export interface StatValue {
  current: number;
  starting: number;
}

export interface Equipment {
  docId: string;
  RARITY_CID: number;
  UINT256_CID: number;
  UINT256_CID_array: (number | null)[];
  selectedVal1: number;
  selectedVal2: number;
  boonTypeString: string;
}

export interface Player {
  id: string;
  _id: string;
  rock: MoveStats;
  paper: MoveStats;
  scissor: MoveStats;
  health: HealthOrShield;
  shield: HealthOrShield;
  equipment: Equipment[];
  lastMove: string;
  thisPlayerWin: boolean;
  otherPlayerWin: boolean;
  activeEffects: unknown[];
  statusEffects: unknown[];
  tenacity: StatValue;
  evasion: StatValue;
  lck: StatValue;
  intuition: StatValue;
  block: StatValue;
}

export interface LootOption {
  docId: string;
  RARITY_CID: number;
  UINT256_CID: number;
  UINT256_CID_array: (number | null)[];
  selectedVal1: number;
  selectedVal2: number;
  boonTypeString: string;
}

/** Affix carried by an Awakening enemy — "Searing", "Bladebreaker", etc. */
export interface EnemyBuff {
  id: string;
  name: string;
  description: string;
  minTier: number;
  effects: { kind: string; [key: string]: unknown }[];
}

/**
 * Per-encounter stat roll the server applies on top of an enemy's static
 * MOVE_STATS. Higher tiers roll higher, which is what makes them dangerous —
 * base ATK/DEF are unchanged.
 */
export interface RolledEnemyStats {
  evasion: number;
  block: number;
  lck: number;
  tenacity: number;
}

/**
 * Reward choice offered after clearing a room in the Awakening dungeon: a boon
 * paired with a Hard Core payout. More Cores comes with a weaker boon.
 */
export interface RewardPathOption {
  index: number;
  tier: number;
  tierName: string;
  boon: LootOption;
  gigusOrbItemId: number;
  gigusOrbAmount: number;
}

/** Enemy choice offered after the reward choice. Tier drives Cores and risk. */
export interface EnemyPathOption {
  index: number;
  tier: number;
  tierName: string;
  enemyId: number;
  enemyBuff: EnemyBuff | null;
  rolledEnemyStats: RolledEnemyStats;
  lootTable?: {
    NAME_CID: string;
    ID_CID: number;
    GAME_ITEM_ID_CID_array: number[];
    WEIGHT_CID_array: number[];
    LOOT_AMOUNT_CID_array: number[];
  };
}

export interface RunData {
  _id: string;
  DUNGEON_ID_CID: number;
  userId: string;
  players: Player[];
  lootPhase: boolean;
  lootOptions: LootOption[];
  // Awakening phases. Absent on the classic dungeons, so all optional.
  pathPhase?: boolean;
  pathOptions?: unknown[];
  rewardPathPhase?: boolean;
  rewardPathOptions?: RewardPathOption[];
  enemyPathPhase?: boolean;
  enemyPathOptions?: EnemyPathOption[];
  activeEnemyBuff?: EnemyBuff | null;
  enemyStartingBuff?: EnemyBuff | null;
  perpetualBuffs?: EnemyBuff[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DungeonEntity {
  _id: string;
  docId: string;
  LEVEL_CID: number;
  GAME_ITEM_ID_CID_array: unknown[];
  ID_CID: string;
  PLAYER_CID: string;
  NOOB_TOKEN_CID: number;
  DUNGEON_ID_CID: number;
  FACTION_CID: number;
  COMPLETE_CID: boolean;
  ROOM_NUM_CID: number;
  ENEMY_CID: number;
  GEAR_CID_array: unknown[];
  TIER_CID: number;
  IS_JUICED_CID: number;
  MULTIPLIER_CID: number;
  WEEK_CID: number;
  DAY_CID: number;
  DAY_OF_WEEK_CID: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ─── API Responses ─────────────────────────────────────────────

export interface DungeonActionResponse {
  success: boolean;
  message: string;
  data: {
    run: RunData | null;
    entity: DungeonEntity | null;
  };
  actionToken?: number;
  gameItemBalanceChanges?: { id: number; amount: number }[];
}

export interface UserMeResponse {
  address: string;
  canEnterGame: boolean;
}

export interface EnergyParsedData {
  energy: number;
  energyValue: number;
  maxEnergy: number;
  regenPerSecond: number;
  regenPerHour: number;
  secondsSinceLastUpdate: number;
  isPlayerJuiced: boolean;
}

export interface EnergyEntity {
  docId: string;
  createdAt: string;
  updatedAt: string;
  ENERGY_CID: number;
  TIMESTAMP_CID: number;
  parsedData: EnergyParsedData;
}

export interface EnergyResponse {
  entities: EnergyEntity[];
}

export interface RomFactoryStats {
  tier: string;
  memory: string;
  faction: string;
  serialNumber: string;
  shardProductionPerWeek: number;
  dustProductionPerWeek: number;
  maxEnergy: number;
  maxShard: number;
  maxDust: number;
  dustItemId: number;
  shardItemId: number;
  energyCollectable: number;
  shardCollectable: number;
  dustCollectable: number;
}

export interface RomEntity {
  _id: string;
  docId: string;
  tableName: string;
  OWNER_CID: string;
  INITIALIZED_CID: boolean;
  factoryStats: RomFactoryStats;
  createdAt: string;
  updatedAt: string;
}

export interface RomsResponse {
  entities: RomEntity[];
}

export interface GameItemEntity {
  docId: string;
  NAME_CID: string;
  ID_CID?: string;
}

export interface GameItemsResponse {
  entities: GameItemEntity[];
}

export interface DayProgressEntity {
  _id: string;
  docId: string;
  UINT256_CID: number;
  ID_CID: string;
  TIMESTAMP_CID: number;
  PLAYER_CID: string;
  DOC_TYPE_CID: string;
}

export interface DungeonEntryTier {
  name: string;
  tier: number;
  inputItems: number[];
  inputAmounts: number[];
  inputsBasedOnFactionDay: boolean;
  dropItemIds: number[];
  dropRateMultipliers: number[];
  jackpotChance: number;
  jackpotItemId: number;
}

export interface TodayDungeonData {
  ID_CID: number;
  NAME_CID: string;
  ENERGY_CID: number;
  UINT256_CID: number;          // base (non-juiced) max runs per day
  CHECKPOINT_CID: number;
  juicedMaxRunsPerDay: number;
  maxRunsPerDay?: number;       // some responses expose the base limit explicitly
  entryData?: DungeonEntryTier[];
}

export interface DungeonTodayResponse {
  dayProgressEntities: DayProgressEntity[];
  dungeonDataEntities: TodayDungeonData[];
}

export interface AccountEntity {
  _id: string;
  docId: string;
  tableName: string;
  NOOB_TOKEN_CID?: number;
  createdAt: string;
  updatedAt: string;
}

export interface NoobEntity {
  docId: string;
  tableName: string;
  LEVEL_CID: number;
  IS_NOOB_CID: boolean;
  OWNER_CID: string;
}

export interface AccountResponse {
  accountEntity: AccountEntity;
  usernames: { NAME_CID: string; docId: string }[];
  noob: NoobEntity | null;
  checkpointProgress: unknown[];
}

// ─── Offchain Static ──────────────────────────────────────────

export interface EnemyEntity {
  docId: string;
  ID_CID: string;
  NAME_CID: string;
  EQUIPMENT_HEAD_CID: number;
  EQUIPMENT_BODY_CID: number;
  LOOT_ID_CID: number;
  MOVE_STATS_CID_array: number[];
}

export interface OffchainGameItem {
  ID_CID: number;
  docId: string;
  NAME_CID: string;
  DESCRIPTION_CID?: string;
  RARITY_CID?: number;
  RARITY_NAME?: string;
  IMG_URL_CID?: string;
  ICON_URL_CID?: string;
  TYPE_CID?: string;
}

export interface RecipeEntity {
  docId: string;
  ID_CID: string;
  NAME_CID: string;
  COOLDOWN_CID: number;
  ENERGY_CID: number;
  IS_JUICED_CID: boolean;
  SUCCESS_RATE_CID: number;
  INPUT_ID_CID_array: number[];
  INPUT_AMOUNT_CID_array: number[];
  INPUT_NAMES_CID_array: string[];
  LOOT_ID_CID_array: number[];
  LOOT_AMOUNT_CID_array: number[];
  GEAR_TYPE_CID: number;
  TAG_CID_array: string[];
}

export interface PlayerRecipeEntity {
  docId: string;
  ID_CID: string;               // e.g. "Recipe#700000"
  END_TIMESTAMP_CID: number;    // when recipe was last completed (unix timestamp)
  PLAYER_CID: string;
  COMPLETIONS_CID?: number;
  DAY_COUNT_CID?: number;
  WEEK_COUNT_CID?: number;
}

export interface PlayerRecipesResponse {
  entities: PlayerRecipeEntity[];
}

export interface OffchainStaticResponse {
  enemies: EnemyEntity[];
  recipes: RecipeEntity[];
  gameItems: OffchainGameItem[];
  checkpoints: unknown[];
  constants: Record<string, unknown>;
  /**
   * Server day number. The unit `pondEntryTiers` states its `startDay` and
   * `endDay` in, so an offering's window can only be honoured with this.
   */
  currentDay?: number;
}

// ─── Gear ─────────────────────────────────────────────────────

export interface GearInstance {
  docId: string;
  GAME_ITEM_ID_CID: number;
  OWNER_CID: string;
  PLAYER_CID: string;
  RARITY_CID: number;
  DURABILITY_CID: number;
  EQUIPPED_TO_SLOT_CID: number;  // -1 = not equipped
  EQUIPPED_TO_INDEX_CID: number;
  REPAIR_COUNT_CID?: number;
}

export interface GearInstancesResponse {
  entities: GearInstance[];
}

// ─── Traveling Merchant (Hugis/Munis) ────────────────────────
// Shape is best-effort — captured GET only; fields probed defensively

export interface VendorListingEntity {
  docId?: string;
  ID_CID?: string;
  NAME_CID?: string;
  INPUT_ID_CID_array?: number[];
  INPUT_AMOUNT_CID_array?: number[];
  LOOT_ID_CID_array?: number[];
  LOOT_AMOUNT_CID_array?: number[];
  MAX_COMPLETIONS_CID?: number;
  COMPLETIONS_CID?: number;
  DAY_COUNT_CID?: number;
  WEEK_COUNT_CID?: number;
  [key: string]: unknown;
}

export interface VendorListingsResponse {
  entities?: VendorListingEntity[];
}

// ─── GigaJuice ────────────────────────────────────────────────

export interface GigaJuiceData {
  isJuiced: boolean;
  juicedSeconds: number;
  TIMESTAMP_CID: number;  // expiry unix timestamp
}

export interface GigaJuiceResponse {
  juiceData: GigaJuiceData;
}

// ─── Skills ───────────────────────────────────────────────────

export interface SkillStat {
  id: number;
  name: string;
  desc: string;
  levelsPerPoint: number[];
  unit: string;
  increaseKey: string;
  increaseValue: number;
}

export interface SkillTree {
  docId: string;
  name: string;
  LEVEL_CID: number;          // max level
  GAME_ITEM_ID_CID: number;   // currency item ID
  xpPerLvl: number[];         // cost per level (index = level)
  stats: SkillStat[];
  usesSkillPoints: boolean;
}

export interface SkillProgressEntity {
  docId: string;
  SKILL_CID: number;          // skill tree ID
  LEVEL_CID: number;          // total level across all stats
  LEVEL_CID_array: (number | null)[];  // level per stat
  NOOB_TOKEN_CID: number;
}

export interface SkillsResponse {
  entities?: SkillTree[];
}

export interface SkillProgressResponse {
  entities?: SkillProgressEntity[];
}

export interface ItemBalanceEntity {
  docId: string;
  ID_CID: string;
  PLAYER_CID: string;
  BALANCE_CID: number;
}

export interface ItemBalancesResponse {
  entities: ItemBalanceEntity[];
}

// ─── Fishing ──────────────────────────────────────────────────

export interface FishingCard {
  id: number;
  manaCost: number;
  hitZones: number[];       // grid positions 1-9 where this card hits
  critZones: number[];      // grid positions where this card crits
  hitEffects: { type: string; amount: number }[];   // damage on hit (positive = fish loses HP)
  missEffects: { type: string; amount: number }[];  // on miss (negative = fish gains HP)
  critEffects: { type: string; amount: number }[];  // damage on crit
  rarity: number;
  isDayCard: boolean;
  earnable: boolean;
}

export interface CaughtFish {
  gameItemId: number;
  name: string;
  rarity: number;
  quality: number;
  size: string;
  sizes: { weight: number; length: number; girth: number };
  /**
   * Stall payout for this catch, in the currency of the pond it came out of.
   *
   * Renamed from the wire's `seaweedEarned`, which stopped meaning seaweed the
   * day the Grove opened — a Grove catch reports Infused Sediment through the
   * same field. The old name survives only in `WireCaughtFish`, so nothing
   * downstream can read it and assume a currency.
   */
  currencyEarned: number;
}

/** Exactly what the API sends. Normalised into `CaughtFish` at the boundary. */
export interface WireCaughtFish extends Omit<CaughtFish, "currencyEarned"> {
  seaweedEarned: number;
}

export interface FishingGameData {
  deckCardData: FishingCard[];
  playerMaxHp: number;       // mana capacity
  playerHp: number;          // current mana
  fishHp: number;            // fish catch meter (goal: reduce to 0)
  fishMaxHp: number;
  fishPosition: number[];    // 1-2 grid positions where fish currently is
  previousFishPosition: number[];
  /** Board edge length — 3 on the classic ponds, 4 in the Dendren Grove */
  gridSize?: number;
  /** Which movement pattern the fish is using this cast, stated outright */
  patternIndex?: number;
  focusPoint?: number[];
  focusMeter?: number;
  focusMeterMax?: number;
  focusMechanicEnabled?: boolean;
  hand: number[];            // card IDs currently in hand
  discard: number[];
  fullDeck: number[];
  nextCardIndex: number;
  cardInDrawPile: number;
  nextPosition: number[] | null;  // Fintuition skill: where fish will move next
  caughtFish?: CaughtFish;
  /** The three spells offered after a successful catch. */
  cardsToAdd?: FishingCard[];
  /**
   * The spell already taken from `cardsToAdd`, once one has been.
   *
   * This is what separates a catch still owed from one already collected:
   * `cardsToAdd` stays on the document forever as the record of what was
   * offered, so it says nothing about whether the payout has been claimed.
   */
  cardChosenId?: number | null;
}

export interface WireFishingGameData extends Omit<FishingGameData, "caughtFish"> {
  caughtFish?: WireCaughtFish;
}

export interface FishingGameDoc {
  docId: string;
  COMPLETE_CID: boolean;
  SUCCESS_CID: boolean;     // true = caught, false = escaped
  LEVEL_CID: number;
  /**
   * The cast node this game is being played on — "0"/"1"/"2" classic, "5" the
   * Grove. This is how a game states its pond: `focusMechanicEnabled` only
   * says the Grove plays differently, which stops distinguishing anything the
   * moment a third pond shares the mechanic.
   */
  ID_CID: string;
  /** Cores multiplier from the entry offering paid for this cast (1, 2 or 4) */
  MULTIPLIER_CID?: number;
  IS_JUICED_CID?: boolean;
  /** Server day number the cast was started on */
  DAY_CID?: number;
  data: FishingGameData;
}

export interface WireFishingGameDoc extends Omit<FishingGameDoc, "data"> {
  data: WireFishingGameData;
}

/** Sell value per fish item. `pondId` says which stall buys it. */
export interface FishExchangeRate {
  id: number;
  tier: number;
  baseVal: number;
  value: number;
  pondId: number;
}

/**
 * `pondId` is optional on the wire only so a malformed row can be detected and
 * dropped rather than silently attributed to pond 1. Every row the live API
 * returned on 2026-08-11 had one (63 of 63, across both ponds).
 */
export interface WireFishExchangeRate extends Omit<FishExchangeRate, "pondId"> {
  pondId?: number;
}

export interface FishingGameState {
  gameState: FishingGameDoc;
  /**
   * Only the FIRST pond's counter. Do not read this for "casts used today" —
   * the daily cap is shared across ponds and this omits every other one. Use
   * castsUsedToday(), which sums dayDocs.
   */
  dayDoc: { UINT256_CID: number };
  /** Per-pond cast counters. pondId 1 is the classic pond, 2 the Dendren Grove. */
  dayDocs?: { pondId: number; doc: { UINT256_CID: number } }[];
  maxPerDay: number;
  maxPerDayJuiced: number;
  node0Energy: number;   // 12
  node1Energy: number;   // 16
  node2Energy: number;   // 20
  exchangeRates?: FishExchangeRate[];
  /** Per-pond offering tiers. See PondEntryTier in lib/ponds.ts. */
  pondEntryTiers?: PondEntryTier[];
  actionToken?: number;
}

export interface WireFishingGameState extends Omit<FishingGameState, "gameState" | "exchangeRates"> {
  gameState: WireFishingGameDoc;
  exchangeRates?: WireFishExchangeRate[];
}

export type FishingAction = "start_run" | "play_cards" | "loot";

export interface FishingActionPayload {
  action: FishingAction;
  actionToken: string | number;
  data: {
    cards: number[];
    nodeId: string;
    /** Grove offering tier: 1 = 1x Cores, 2 = 2x, 3 = 4x. 0 on classic ponds. */
    tierId: number;
    /** Lure position, sent with every card play rather than as its own action */
    focusPoint: number[];
    itemId: number;
    slotIndex: number;
  };
}

export interface FishingActionResponse {
  success: boolean;
  message?: string;
  data: {
    doc: FishingGameDoc;
    events?: { type: string; value?: number; playerId?: number; batch?: number; data?: Record<string, unknown> }[];
  };
  /**
   * What the action actually paid out. The only place the app can see Cores
   * arriving from a cast, so it is what pond yield is measured from.
   */
  gameItemBalanceChanges?: { id: number; amount: number }[];
  actionToken?: number;
}

/** The un-normalised form of the above, straight off the wire. */
export interface WireFishingActionResponse extends Omit<FishingActionResponse, "data"> {
  data: {
    doc: WireFishingGameDoc;
    events?: { type: string; value?: number; playerId?: number; batch?: number; data?: Record<string, unknown> }[];
  };
}

// ─── Marketplace ──────────────────────────────────────────────

export interface MarketListing {
  docId: string;
  ID_CID: string;
  OWNER_CID: string;
  GAME_ITEM_ID_CID: number;
  /** Price per unit in wei */
  ETH_MINT_PRICE_CID: number;
  /** Units still available on this listing */
  UINT256_CID: number;
  /** Units originally listed */
  EXPORT_AMOUNT_CID: number;
  TIMESTAMP_CID: number;
}

export interface MarketListingsResponse {
  entities: MarketListing[];
}

// ─── Action Payloads ───────────────────────────────────────────

export type DungeonAction =
  | "start_run"
  | "rock"
  | "paper"
  | "scissor"
  | "loot_one"
  | "loot_two"
  | "loot_three"
  | "loot_four"
  // Awakening: reward choice (boon + Hard Cores), then enemy/difficulty choice
  | "reward_one"
  | "reward_two"
  | "reward_three"
  | "path_one"
  | "path_two"
  | "path_three"
  | "use_item";

export interface DungeonActionPayload {
  action: DungeonAction;
  actionToken: string | number;
  dungeonId: number;
  data: {
    consumables: unknown[];
    itemId: number;
    expectedAmount: number;
    index: number;
    isJuiced: boolean;
    gearInstanceIds: string[];
  };
}
