// The hatchery: eggs incubating toward a Gigling, and the three dials that
// decide what comes out.
//
// What the game actually says (verified against the live API on 2026-08-11 and
// docs.gigaverse.io, rather than inferred):
//
//   Temperature drives Progress. Comfort and Progress together drive Quality.
//   Fate is faction dust already fed in, and only matters at the moment of the
//   hatch. So the three dials are not interchangeable:
//
//     - Temperature at 0 costs time. Progress stops; nothing is destroyed.
//     - Comfort below max costs Quality permanently, because Quality is banked
//       as Progress accrues. Progress earned while uncomfortable cannot be
//       re-earned comfortably later.
//     - Fate is a one-time purchase that expires at the hatch.
//
//   That asymmetry is the whole reason this advisor exists, and it is why a
//   short inventory funds Comfort before Temperature: running cold is a delay,
//   running uncomfortable is a loss.
//
// Bounds come from `/api/offchain/static` -> `hatchery`, so they track the game
// rather than this file. The fallbacks below are what that endpoint returned on
// 2026-08-11 and exist only so the advisor still runs before static data loads.

/* ─── Bounds ────────────────────────────────────────────────── */

export interface StatConfig {
  minValue: number;
  maxValue: number;
  /** The step the game moves this stat in — one feed is at least this much. */
  increment: number;
}

export interface HatcheryConfig {
  maxProgress: number;
  /** `maxRarity` upstream. It is the Quality bar the docs describe. */
  maxQuality: number;
  maxPetsInHatchery: number;
  comfort: StatConfig;
  temperature: StatConfig;
}

/** What /api/offchain/static returned on 2026-08-11. Used until it loads. */
export const HATCHERY_FALLBACK_CONFIG: HatcheryConfig = {
  maxProgress: 100,
  maxQuality: 100,
  maxPetsInHatchery: 300,
  comfort: { minValue: 0, maxValue: 5, increment: 1 },
  temperature: { minValue: 0, maxValue: 100, increment: 10 },
};

interface WireStatConfig {
  minValue?: number;
  maxValue?: number;
  increment?: number;
}

interface WireHatcheryConfig {
  maxProgress?: number;
  maxRarity?: number;
  maxPetsInHatchery?: number;
  comfortConfig?: WireStatConfig;
  temperatureConfig?: WireStatConfig;
}

function stat(wire: WireStatConfig | undefined, fallback: StatConfig): StatConfig {
  return {
    minValue: typeof wire?.minValue === "number" ? wire.minValue : fallback.minValue,
    maxValue: typeof wire?.maxValue === "number" ? wire.maxValue : fallback.maxValue,
    // An increment of 0 would make every "steps to full" division infinite, so
    // it is treated as absent rather than trusted.
    increment:
      typeof wire?.increment === "number" && wire.increment > 0
        ? wire.increment
        : fallback.increment,
  };
}

/** Read the live bounds, falling back field by field rather than wholesale. */
export function readHatcheryConfig(staticData: unknown): HatcheryConfig {
  const wire = (staticData as { hatchery?: WireHatcheryConfig } | null | undefined)?.hatchery;
  const f = HATCHERY_FALLBACK_CONFIG;
  return {
    maxProgress: typeof wire?.maxProgress === "number" ? wire.maxProgress : f.maxProgress,
    maxQuality: typeof wire?.maxRarity === "number" ? wire.maxRarity : f.maxQuality,
    maxPetsInHatchery:
      typeof wire?.maxPetsInHatchery === "number" ? wire.maxPetsInHatchery : f.maxPetsInHatchery,
    comfort: stat(wire?.comfortConfig, f.comfort),
    temperature: stat(wire?.temperatureConfig, f.temperature),
  };
}

/* ─── Materials ─────────────────────────────────────────────── */

export type EggStat = "temperature" | "comfort";

export interface HatcheryMaterial {
  itemId: number;
  name: string;
  stat: EggStat;
  /** 0 = base grade. Higher grades are assumed to be worth more per feed. */
  tier: number;
  /** Vilhelm's trade that mints it, runnable through /api/offchain/recipes/start */
  recipeId: string;
  input: { itemId: number; name: string; amount: number };
  /** Units minted per completion of that recipe */
  output: number;
}

/**
 * The five incubation materials and the Vilhelm trades that make them.
 *
 * Taken verbatim from `/api/offchain/static` -> `recipes`, tag "vilhelm"
 * (ids 500001-500005), so the base-material costs here are the real ones and
 * the shortfall advice can name what to farm.
 */
export const HATCHERY_MATERIALS: HatcheryMaterial[] = [
  {
    itemId: 576,
    name: "Biofuel",
    stat: "temperature",
    tier: 0,
    recipeId: "500001",
    input: { itemId: 21, name: "Wood", amount: 3 },
    output: 3,
  },
  {
    itemId: 577,
    name: "Biofuel+",
    stat: "temperature",
    tier: 1,
    recipeId: "500002",
    input: { itemId: 61, name: "Coal", amount: 3 },
    output: 3,
  },
  {
    itemId: 578,
    name: "Incube",
    stat: "comfort",
    tier: 0,
    recipeId: "500003",
    input: { itemId: 23, name: "Bone", amount: 2 },
    output: 1,
  },
  {
    itemId: 579,
    name: "Incube+",
    stat: "comfort",
    tier: 1,
    recipeId: "500004",
    input: { itemId: 22, name: "Fiber", amount: 2 },
    output: 1,
  },
  {
    itemId: 580,
    name: "Incube++",
    stat: "comfort",
    tier: 2,
    recipeId: "500005",
    input: { itemId: 25, name: "Stone", amount: 5 },
    output: 1,
  },
];

export function materialsFor(stat: EggStat): HatcheryMaterial[] {
  return HATCHERY_MATERIALS.filter((m) => m.stat === stat).sort((a, b) => a.tier - b.tier);
}

export function materialById(itemId: number): HatcheryMaterial | undefined {
  return HATCHERY_MATERIALS.find((m) => m.itemId === itemId);
}

/**
 * Eggspeditors, which set Progress to 100 and raise Quality to a floor.
 *
 * Item ids and floors are from `/api/offchain/static` -> `hatchery.eggspediteItems`,
 * cross-checked against each item's own description. Note the floor is a floor:
 * on an egg already above it, the Eggspeditor only buys time.
 */
export interface Eggspeditor {
  itemId: number;
  name: string;
  qualityFloor: number;
}

export const EGGSPEDITORS: Eggspeditor[] = [
  { itemId: 584, name: "Eggspeditor 1", qualityFloor: 10 },
  { itemId: 585, name: "Eggspeditor 2", qualityFloor: 30 },
  { itemId: 586, name: "Eggspeditor 3", qualityFloor: 50 },
  { itemId: 587, name: "Eggspeditor 4", qualityFloor: 70 },
  { itemId: 589, name: "Eggspeditor 5", qualityFloor: 90 },
];

/* ─── Fate ──────────────────────────────────────────────────── */

export interface FactionDust {
  factionId: number;
  faction: string;
  itemId: number;
}

/**
 * Faction ids paired with their dust.
 *
 * The pairing is not guesswork from item order: every faction-gated recipe in
 * static data carries both `FACTION_CID_array` and a name ending in the faction,
 * and the two agree across all 7.
 */
export const FACTION_DUSTS: FactionDust[] = [
  { factionId: 1, faction: "Crusader", itemId: 73 },
  { factionId: 2, faction: "Overseer", itemId: 74 },
  { factionId: 3, faction: "Athena", itemId: 75 },
  { factionId: 4, faction: "Archon", itemId: 76 },
  { factionId: 5, faction: "Foxglove", itemId: 77 },
  { factionId: 6, faction: "Summoner", itemId: 78 },
  { factionId: 7, faction: "Chobo", itemId: 79 },
];

/** Influences that together guarantee a faction trait (20 x 4.75% + 20 x 0.25%). */
export const MAX_INFLUENCES = 20;
/** Chance of the fed faction added per influence. */
export const FACTION_PCT_PER_INFLUENCE = 4.75;
/** Chance of Gigus added per influence, whichever dust was used. */
export const GIGUS_PCT_PER_INFLUENCE = 0.25;
/** The 1st influence of any one faction costs this much of its dust. */
export const FIRST_INFLUENCE_COST = 5;

/**
 * Dust cost of the `nth` influence bought with a single faction's dust.
 *
 * The ladder is per faction and resets for each new one — "5 Faction Dust, and
 * if you use the same Faction Dust it will cost 1 more dust per influence".
 * That reset is the entire reason spreading across factions is cheaper, so it
 * lives in one function rather than being open-coded at the call sites.
 */
export function influenceCost(nth: number): number {
  return FIRST_INFLUENCE_COST + Math.max(0, nth - 1);
}

/** Total dust to put `count` influences into one faction. */
export function influenceLadderCost(count: number): number {
  let total = 0;
  for (let i = 1; i <= count; i++) total += influenceCost(i);
  return total;
}

export interface FateBuy {
  factionId: number;
  faction: string;
  itemId: number;
  /** Influences to buy from this faction, cheapest rungs first */
  influences: number;
  dust: number;
}

export interface FatePlan {
  buys: FateBuy[];
  /** Influences the plan adds on top of what the egg already has */
  influencesGained: number;
  /** Influences the egg would sit at once the plan is applied */
  influencesAfter: number;
  totalDust: number;
  /** Chance of hatching with any faction trait afterwards, 0-100 */
  factionChanceAfter: number;
  /** True when the plan reaches a guaranteed faction trait */
  guaranteed: boolean;
  /** Set when the plan stops short, saying what ran out */
  shortfall: string | null;
}

export interface FatePlanInput {
  /**
   * Influences already fed, keyed by faction id. The hatchery response is the
   * only source for this; an empty map means a fresh egg.
   */
  current: Record<number, number>;
  /** Dust on hand, keyed by item id */
  balances: Record<number, number>;
  /**
   * Which faction the Gigling should end up as, or "any" when only the faction
   * trait itself is wanted. These are genuinely different purchases, not a
   * preference: a named faction has to climb one ladder to 20 (290 dust),
   * while "any" hops between seven cheap rungs (119 dust for the same 100%).
   */
  target: number | "any";
  /** Stop below the cap, e.g. to leave dust for a second egg */
  maxInfluences?: number;
}

/**
 * Cheapest dust to reach the fate target.
 *
 * Greedy on marginal cost is optimal here rather than merely convenient: each
 * faction's rungs get strictly more expensive, so the cheapest next rung overall
 * can never be made cheaper by having bought something else first.
 */
export function planFate(input: FatePlanInput): FatePlan {
  const cap = Math.min(input.maxInfluences ?? MAX_INFLUENCES, MAX_INFLUENCES);
  const used: Record<number, number> = { ...input.current };
  const spent: Record<number, number> = {};
  const remaining = { ...input.balances };

  const startTotal = Object.values(input.current).reduce((s, n) => s + n, 0);
  let total = startTotal;
  let shortfall: string | null = null;

  const pool =
    input.target === "any"
      ? FACTION_DUSTS
      : FACTION_DUSTS.filter((d) => d.factionId === input.target);

  if (input.target !== "any" && pool.length === 0) {
    return {
      buys: [],
      influencesGained: 0,
      influencesAfter: startTotal,
      totalDust: 0,
      factionChanceAfter: startTotal * FACTION_PCT_PER_INFLUENCE,
      guaranteed: startTotal >= MAX_INFLUENCES,
      shortfall: `Faction ${input.target} has no dust in the game's faction table.`,
    };
  }

  while (total < cap) {
    let best: { dust: FactionDust; cost: number } | null = null;
    for (const dust of pool) {
      const cost = influenceCost((used[dust.factionId] ?? 0) + 1);
      if ((remaining[dust.itemId] ?? 0) < cost) continue;
      if (!best || cost < best.cost) best = { dust, cost };
    }
    if (!best) {
      const nextCosts = pool.map(
        (d) => `${d.faction} needs ${influenceCost((used[d.factionId] ?? 0) + 1)}`
      );
      shortfall =
        input.target === "any"
          ? `Out of dust at ${total}/${cap} influences — next rung costs ${nextCosts.join(", ")}.`
          : `Out of ${pool[0].faction} Dust at ${total}/${cap} influences — the next influence costs ${influenceCost((used[pool[0].factionId] ?? 0) + 1)}.`;
      break;
    }
    used[best.dust.factionId] = (used[best.dust.factionId] ?? 0) + 1;
    spent[best.dust.factionId] = (spent[best.dust.factionId] ?? 0) + best.cost;
    remaining[best.dust.itemId] -= best.cost;
    total++;
  }

  const buys: FateBuy[] = FACTION_DUSTS.filter((d) => spent[d.factionId] > 0)
    .map((d) => ({
      factionId: d.factionId,
      faction: d.faction,
      itemId: d.itemId,
      influences: (used[d.factionId] ?? 0) - (input.current[d.factionId] ?? 0),
      dust: spent[d.factionId],
    }))
    .sort((a, b) => b.influences - a.influences || a.faction.localeCompare(b.faction));

  return {
    buys,
    influencesGained: total - startTotal,
    influencesAfter: total,
    totalDust: buys.reduce((s, b) => s + b.dust, 0),
    factionChanceAfter: Number((total * FACTION_PCT_PER_INFLUENCE).toFixed(2)),
    guaranteed: total >= MAX_INFLUENCES,
    shortfall,
  };
}

/* ─── Reading an egg out of the API ─────────────────────────── */

/**
 * An item cost the game itself quotes, rather than one this app worked out.
 *
 * The hatchery names the exact item and quantity that buys the next increment
 * of a stat, and it does not always name the cheap grade: an egg at 72/100
 * temperature was quoted 3x Biofuel+ while plain Biofuel sat unused in the bag.
 * Anything that plans a feed has to use this, because a plan built on grade
 * order alone recommends an item the game will refuse.
 */
export interface StatRequirement {
  itemId: number;
  amount: number;
}

/** What the game says about Fate on one egg, beyond the influences fed. */
export interface FateStatus {
  /** Influence cap for this egg — 20 on every egg read so far */
  max: number;
  /** Dust cost of the next influence per faction, quoted by the game */
  nextCost: Record<number, StatRequirement>;
  /** False once today's influence has been used */
  canInfluenceToday: boolean;
  /** Some eggs gate influencing behind a temperature floor */
  meetsTemperatureRequirement: boolean;
  temperatureRequirement: number;
}

export interface EggState {
  /** Pet/egg id — what a feed call has to name */
  petId: string;
  name: string;
  eggType: string | null;
  temperature: number | null;
  comfort: number | null;
  progress: number | null;
  quality: number | null;
  /** Influences already fed, by faction id. Empty when the API didn't say. */
  fate: Record<number, number>;
  /** Sum of `fate` */
  influences: number;
  /**
   * True when the egg is actually in the hatchery.
   *
   * An egg in the inventory that was never placed carries no incubation block
   * at all. That is a different thing from an egg whose stats failed to parse,
   * and conflating the two put "no data, check your parser" warnings on eggs
   * that were simply sitting in the bag.
   */
  incubating: boolean;
  /** The game's own quote for the next increment of each stat */
  nextIncrement: Record<EggStat, StatRequirement | null>;
  /** Progress added per day at the current temperature, as the game prints it */
  progressPerDay: number | null;
  /** Quality banked per day at the current comfort, as the game prints it */
  qualityPerDay: number | null;
  /** Fate detail from the incubation block, absent on an egg not in the hatchery */
  fateStatus: FateStatus | null;
  /** True once the egg has hatched and is no longer an incubation target */
  hatched: boolean;
  /**
   * Fields the response had no recognisable value for.
   *
   * Carried per egg rather than logged, because an advisor that silently reads
   * a missing Comfort as 0 would recommend feeding Incube forever. The UI shows
   * this instead of a number it made up.
   */
  missing: EggField[];
  /**
   * Where each reading came from, and everything else that could have supplied
   * it. Readings off the incubation block name their exact path; readings from
   * the fallback scan are the ones worth distrusting, and this is what says
   * which field was believed and what the alternatives were.
   */
  readings: Record<"temperature" | "comfort" | "progress" | "quality", StatReading>;
  /** Stats where more than one in-range field matched, so the pick is a guess */
  ambiguous: ("temperature" | "comfort" | "progress" | "quality")[];
  /** The entity as it arrived, for the field inspector on the hatchery page */
  raw: unknown;
}

export type EggField = "temperature" | "comfort" | "progress" | "quality" | "fate";

/**
 * Pull a number out of an unknown object by matching key names.
 *
 * The incubation fields sit behind an authenticated endpoint that could not be
 * read while this was written, so the exact casing is unknown — `TEMPERATURE_CID`,
 * `temperature`, and `temp` are all plausible. Matching on a pattern costs
 * nothing and means a rename upstream doesn't blank the panel; anything that
 * still fails to match is reported through `missing` rather than defaulted.
 */
export interface FieldCandidate {
  /** Dotted path from the entity root, e.g. "data.temperature" */
  path: string;
  value: number;
}

/**
 * Every numeric field whose key matches, not just the first.
 *
 * Taking the first match was wrong in a way worth spelling out: entities in this
 * API carry a wide row of `*_CID` columns, many of them defaults, and a stale
 * top-level `TEMPERATURE_CID` of 0 beat the live value nested under `data`. The
 * symptom was a temperature confidently reported as 0 on an egg that was warm.
 * Collecting all of them lets the caller choose on the stat's own bounds and,
 * when that still doesn't separate them, say that it couldn't.
 */
export function findNumberCandidates(source: unknown, pattern: RegExp): FieldCandidate[] {
  const out: FieldCandidate[] = [];
  if (!source || typeof source !== "object") return out;
  const seen = new Set<object>();
  const walk = (node: unknown, depth: number, prefix: string) => {
    if (!node || typeof node !== "object" || depth > 3) return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === "number" && pattern.test(key)) out.push({ path, value });
      else if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value, depth + 1, path);
      }
    }
  };
  walk(source, 0, "");
  return out;
}

export function findNumber(source: unknown, pattern: RegExp): number | null {
  const candidates = findNumberCandidates(source, pattern);
  return candidates.length > 0 ? candidates[0].value : null;
}

export interface StatReading {
  value: number | null;
  /** Which field it came from, for the UI to show when a reading is disputed */
  chosen: string | null;
  /** More than one field could have supplied this — the reading is a guess */
  ambiguous: boolean;
  candidates: FieldCandidate[];
}

/**
 * Choose one reading for a stat from everything that matched.
 *
 * Out-of-range candidates are discarded first, which is what separates the
 * Gigling's 1-6 `RARITY_CID` trait from the 0-100 hatch Quality, and any
 * 0-100 column from Comfort's 0-5. When two survivors remain in range the
 * bounds cannot separate them, so the reading is marked ambiguous rather than
 * presented as fact.
 */
export function pickStat(candidates: FieldCandidate[], bounds: StatConfig): StatReading {
  if (candidates.length === 0) {
    return { value: null, chosen: null, ambiguous: false, candidates };
  }
  const inRange = candidates.filter(
    (c) => c.value >= bounds.minValue && c.value <= bounds.maxValue
  );
  const pool = inRange.length > 0 ? inRange : candidates;
  return {
    value: pool[0].value,
    chosen: pool[0].path,
    ambiguous: pool.length > 1,
    candidates,
  };
}

/**
 * Influences per faction, from whichever shape the API uses.
 *
 * Two are handled: a keyed map ({"1": 3}) and a parallel-array pair, which is
 * the house style everywhere else in this API (`INPUT_ID_CID_array` alongside
 * `INPUT_AMOUNT_CID_array`).
 */
export function findFate(source: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (!source || typeof source !== "object") return out;

  const obj = source as Record<string, unknown>;
  const isNumberArray = (v: unknown): v is number[] =>
    Array.isArray(v) && v.every((n) => typeof n === "number");

  // Keyed map: { fate: { "1": 3 } }
  for (const [key, value] of Object.entries(obj)) {
    if (!/fate|influence/i.test(key)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [fid, count] of Object.entries(value as Record<string, unknown>)) {
      const id = Number(fid);
      if (Number.isInteger(id) && typeof count === "number" && count > 0) out[id] = count;
    }
  }
  if (Object.keys(out).length > 0) return out;

  // Parallel arrays, the house style elsewhere in this API. The two roles are
  // matched on distinct patterns rather than "any other numeric array": every
  // key here ends in _CID_array, so a loose /id/ test matches "CID" and pairs
  // the counts array with itself reversed.
  const idsKey = Object.keys(obj).find((k) => /faction/i.test(k) && isNumberArray(obj[k]));
  const countsKey = Object.keys(obj).find(
    (k) => k !== idsKey && /influence|fate|amount|count/i.test(k) && isNumberArray(obj[k])
  );
  if (idsKey && countsKey) {
    const ids = obj[idsKey] as number[];
    const counts = obj[countsKey] as number[];
    if (ids.length === counts.length) {
      ids.forEach((id, i) => {
        if (Number.isInteger(id) && counts[i] > 0) out[id] = counts[i];
      });
    }
  }
  return out;
}

/* ─── The incubation block ──────────────────────────────────── */

/**
 * `data.hatcheryStatus`, as `/api/pets/player?id={address}` returned it on
 * 2026-08-12 for an egg mid-incubation:
 *
 *   progress: 29
 *   rarity: 8.65                                  <- the Quality bar
 *   temperature: { current: 72, max: 100, nextDayIncreaseRate: 2.5,
 *                  itemsForNextIncrement: { ID_CID: 577, BALANCE_CID: 3 } }
 *   comfort:     { current: 2,  max: 5,   nextDayIncreaseRate: 1,
 *                  itemsForNextIncrement: { ID_CID: 579, BALANCE_CID: 2 } }
 *   fate: { upgrades: [...], probabilities: [...], max: 20, ... }
 *
 * Two things here were previously guessed and are now read:
 *
 *   - The stats are objects, not numbers. The old key-pattern scan walked into
 *     `temperature` looking for a number and found `current`, `max` and
 *     `nextDayIncreaseRate`, none of which are named after the stat — which is
 *     exactly why the page reported no temperature on an egg at 72/100.
 *   - `nextDayIncreaseRate` is the derived daily gain, not a rise in the stat
 *     itself. Temperature's is the Progress the egg gains per day and comfort's
 *     is the Quality; both match the two rates printed beside those bars in
 *     game (+2.50% and +1.00% on the egg above).
 */
interface WireStatBlock {
  current?: number;
  max?: number;
  nextDayIncreaseRate?: number;
  itemsForNextIncrement?: { ID_CID?: number; BALANCE_CID?: number };
}

interface WireFateBlock {
  /** Influences fed, indexed by faction id. Index 0 and 8 are not factions. */
  upgrades?: number[];
  probabilities?: number[];
  max?: number;
  interactionCount?: number;
  canInfluenceToday?: boolean;
  meetsTemperatureRequirement?: boolean;
  temperatureRequirement?: number;
  itemsForNextIncrement?: { FACTION_CID?: number; ID_CID?: number; BALANCE_CID?: number }[];
}

interface WireHatcheryStatus {
  progress?: number;
  rarity?: number;
  temperature?: WireStatBlock;
  comfort?: WireStatBlock;
  fate?: WireFateBlock;
}

function numberOrNull(v: number | undefined): number | null {
  return typeof v === "number" ? v : null;
}

function requirementOf(block: WireStatBlock | undefined): StatRequirement | null {
  const item = block?.itemsForNextIncrement;
  if (typeof item?.ID_CID !== "number" || typeof item?.BALANCE_CID !== "number") return null;
  return { itemId: item.ID_CID, amount: item.BALANCE_CID };
}

/**
 * Influences per faction from the `upgrades` array.
 *
 * The array is indexed by faction id and runs longer than the seven factions —
 * index 0 is the factionless remainder and index 8 is Gigus, neither of which
 * is a dust that can be fed. Reading it as a dense list of factions would file
 * the Gigus chance as an eighth faction's influences.
 *
 * The arithmetic checks out on the live egg: `upgrades[3] = 12` alongside
 * `probabilities[3] = 57` is 12 x 4.75, and `probabilities[8] = 3` is 12 x 0.25.
 */
function fateFromUpgrades(upgrades: number[] | undefined): Record<number, number> {
  const out: Record<number, number> = {};
  if (!Array.isArray(upgrades)) return out;
  for (const { factionId } of FACTION_DUSTS) {
    const n = upgrades[factionId];
    if (typeof n === "number" && n > 0) out[factionId] = n;
  }
  return out;
}

function readFateStatus(fate: WireFateBlock | undefined): FateStatus | null {
  if (!fate) return null;
  const nextCost: Record<number, StatRequirement> = {};
  for (const row of fate.itemsForNextIncrement ?? []) {
    if (typeof row?.FACTION_CID !== "number") continue;
    if (typeof row.ID_CID !== "number" || typeof row.BALANCE_CID !== "number") continue;
    nextCost[row.FACTION_CID] = { itemId: row.ID_CID, amount: row.BALANCE_CID };
  }
  return {
    max: typeof fate.max === "number" ? fate.max : MAX_INFLUENCES,
    nextCost,
    canInfluenceToday: fate.canInfluenceToday !== false,
    meetsTemperatureRequirement: fate.meetsTemperatureRequirement !== false,
    temperatureRequirement:
      typeof fate.temperatureRequirement === "number" ? fate.temperatureRequirement : 0,
  };
}

/**
 * Turn one raw hatchery/pet entity into an EggState.
 *
 * `/api/pets/player?id={address}` carries everything: the egg inventory and,
 * on any egg actually placed in the hatchery, a `data.hatcheryStatus` block
 * with the live incubation stats. That block is read by path. The key-pattern
 * scan below it is the fallback for an entity shaped some other way, and it is
 * the only path that can produce an ambiguous reading.
 */
export function normalizeEgg(
  raw: unknown,
  config: HatcheryConfig = HATCHERY_FALLBACK_CONFIG
): EggState {
  const e = (raw ?? {}) as Record<string, unknown>;
  const data = (e.data ?? {}) as Record<string, unknown>;
  const status = (data.hatcheryStatus ?? null) as WireHatcheryStatus | null;

  const bounds = (max: number): StatConfig => ({ minValue: 0, maxValue: max, increment: 1 });

  /** A reading straight off a known path — one candidate, nothing to weigh. */
  const known = (path: string, value: number): StatReading => ({
    value,
    chosen: path,
    ambiguous: false,
    candidates: [{ path, value }],
  });
  const at = (field: string, value: number | undefined, fallback: () => StatReading) =>
    typeof value === "number" ? known(`data.hatcheryStatus.${field}`, value) : fallback();

  const temperature = at("temperature.current", status?.temperature?.current, () =>
    pickStat(findNumberCandidates(e, /^(temperature|temp)/i), config.temperature)
  );
  const comfort = at("comfort.current", status?.comfort?.current, () =>
    pickStat(findNumberCandidates(e, /comfort/i), config.comfort)
  );
  const progress = at("progress", status?.progress, () =>
    pickStat(findNumberCandidates(e, /progress/i), bounds(config.maxProgress))
  );
  // `rarity` inside the incubation block is the Quality bar. Outside it, on a
  // pet NFT, `RARITY_CID` is the 1-6 trait tier — so the fallback only reaches
  // for a rarity-named field once nothing named quality has matched.
  const quality = at("rarity", status?.rarity, () => {
    const qualityMatches = findNumberCandidates(e, /quality/i);
    return pickStat(
      qualityMatches.length > 0 ? qualityMatches : findNumberCandidates(e, /rarity/i),
      bounds(config.maxQuality)
    );
  });

  const fate = status?.fate ? fateFromUpgrades(status.fate.upgrades) : findFate(e);

  const missing: EggField[] = [];
  if (temperature.value === null) missing.push("temperature");
  if (comfort.value === null) missing.push("comfort");
  if (progress.value === null) missing.push("progress");
  if (quality.value === null) missing.push("quality");
  if (Object.keys(fate).length === 0) missing.push("fate");

  const readings = { temperature, comfort, progress, quality };
  const ambiguous = (Object.keys(readings) as (keyof typeof readings)[]).filter(
    (k) => readings[k].ambiguous
  );

  return {
    petId: String(e.docId ?? e.petId ?? e.ID_CID ?? ""),
    name: typeof e.NAME_CID === "string" ? e.NAME_CID : `#${e.docId ?? "?"}`,
    eggType: typeof data.eggType === "string" ? data.eggType : null,
    temperature: temperature.value,
    comfort: comfort.value,
    progress: progress.value,
    quality: quality.value,
    fate,
    influences: Object.values(fate).reduce((s, n) => s + n, 0),
    incubating: status !== null,
    nextIncrement: {
      temperature: requirementOf(status?.temperature),
      comfort: requirementOf(status?.comfort),
    },
    progressPerDay: numberOrNull(status?.temperature?.nextDayIncreaseRate),
    qualityPerDay: numberOrNull(status?.comfort?.nextDayIncreaseRate),
    fateStatus: readFateStatus(status?.fate),
    // An entity carrying `hatchedAt` has hatched whatever COMPLETE_CID says;
    // both were present together on every live pet read.
    hatched: e.COMPLETE_CID === true || typeof data.hatchedAt === "string",
    missing,
    readings,
    ambiguous,
    raw,
  };
}

/**
 * Every egg the player owns, incubating or not.
 *
 * `/api/pets/player?id={address}` alone answers this on a live account — it
 * lists the eggs and carries `data.hatcheryStatus` on the placed ones. The
 * second argument stays because the merge costs nothing and a separate
 * hatchery read may exist; when both describe an egg, the side that actually
 * carries an incubation block wins rather than the later one.
 */
export function collectEggs(
  petsResponse: unknown,
  hatcheryResponse: unknown,
  config: HatcheryConfig = HATCHERY_FALLBACK_CONFIG
): EggState[] {
  const entitiesOf = (source: unknown): unknown[] => {
    const s = source as Record<string, unknown> | null | undefined;
    for (const key of ["entities", "eggs", "pets", "data"]) {
      const v = s?.[key];
      if (Array.isArray(v)) return v;
    }
    return Array.isArray(source) ? (source as unknown[]) : [];
  };

  const byId = new Map<string, EggState>();
  for (const raw of entitiesOf(petsResponse)) {
    const egg = normalizeEgg(raw, config);
    if (egg.petId) byId.set(egg.petId, egg);
  }

  for (const raw of entitiesOf(hatcheryResponse)) {
    const overlay = normalizeEgg(raw, config);
    if (!overlay.petId) continue;
    const base = byId.get(overlay.petId);
    if (!base) {
      byId.set(overlay.petId, overlay);
      continue;
    }
    // The overlay only replaces the readings it actually supplies. Taking them
    // wholesale blanked a fully-read egg whenever the second response knew the
    // egg existed but not how it was doing.
    const richer = overlay.incubating || !base.incubating ? overlay : base;
    byId.set(overlay.petId, {
      ...base,
      temperature: overlay.temperature ?? base.temperature,
      comfort: overlay.comfort ?? base.comfort,
      progress: overlay.progress ?? base.progress,
      quality: overlay.quality ?? base.quality,
      fate: overlay.influences > 0 ? overlay.fate : base.fate,
      influences: Math.max(overlay.influences, base.influences),
      incubating: base.incubating || overlay.incubating,
      nextIncrement: {
        temperature: overlay.nextIncrement.temperature ?? base.nextIncrement.temperature,
        comfort: overlay.nextIncrement.comfort ?? base.nextIncrement.comfort,
      },
      progressPerDay: overlay.progressPerDay ?? base.progressPerDay,
      qualityPerDay: overlay.qualityPerDay ?? base.qualityPerDay,
      fateStatus: overlay.fateStatus ?? base.fateStatus,
      missing: richer.missing,
      readings: richer.readings,
      ambiguous: richer.ambiguous,
      // Keep both halves: which field was believed is only answerable against
      // the entity it was read from.
      raw: { pets: base.raw, hatchery: raw },
    });
  }

  return Array.from(byId.values()).filter((e) => !e.hatched);
}
