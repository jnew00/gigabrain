// Gigaverse API type definitions - reverse-engineered March 2026

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

export interface RunData {
  _id: string;
  DUNGEON_ID_CID: number;
  userId: string;
  players: Player[];
  lootPhase: boolean;
  lootOptions: LootOption[];
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
  UINT256_CID: number;
  CHECKPOINT_CID: number;
  juicedMaxRunsPerDay: number;
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

export interface FishingGameData {
  deckCardData: FishingCard[];
  playerMaxHp: number;       // mana capacity
  playerHp: number;          // current mana
  fishHp: number;            // fish catch meter (goal: reduce to 0)
  fishMaxHp: number;
  fishPosition: number[];    // 1-2 grid positions where fish currently is
  previousFishPosition: number[];
  hand: number[];            // card IDs currently in hand
  discard: number[];
  fullDeck: number[];
  nextCardIndex: number;
  cardInDrawPile: number;
  nextPosition: number[] | null;  // Fintuition skill: where fish will move next
  caughtFish?: {
    gameItemId: number;
    name: string;
    rarity: number;
    quality: number;
    size: string;
    sizes: { weight: number; length: number; girth: number };
    seaweedEarned: number;
  };
  cardsToAdd?: FishingCard[];
}

export interface FishingGameState {
  gameState: {
    docId: string;
    COMPLETE_CID: boolean;
    SUCCESS_CID: boolean;     // true = caught, false = escaped
    LEVEL_CID: number;
    data: FishingGameData;
  };
  dayDoc: { UINT256_CID: number };  // casts done today
  maxPerDay: number;
  maxPerDayJuiced: number;
  node0Energy: number;   // 12
  node1Energy: number;   // 16
  node2Energy: number;   // 20
  exchangeRates?: { id: number; tier: number; baseVal: number; value: number }[];
  actionToken?: number;
}

export type FishingAction = "start_run" | "play_cards";

export interface FishingActionPayload {
  action: FishingAction;
  actionToken: string | number;
  data: {
    cards: number[];
    nodeId: string;
  };
}

export interface FishingActionResponse {
  success: boolean;
  message?: string;
  data: {
    doc: FishingGameState["gameState"];
    events?: { type: string; value?: number; playerId?: number; batch?: number; data?: Record<string, unknown> }[];
  };
  gameItemBalanceChanges?: { id: number; amount: number }[];
  actionToken?: number;
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
