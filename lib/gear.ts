// Gear repair, restore and burn, read from the game's own definitions.
//
// `/api/gear/items` publishes a `repairCost` block per gear item that answers
// three questions the UI otherwise has to guess at:
//
//   INPUT_ID/AMOUNT_CID_array        what one repair costs
//   RESET_INPUT_ID/AMOUNT_CID_array  what one restore costs — EMPTY when the
//                                    item cannot be restored at all
//   LOOT_ID_CID / LOOT_AMOUNT_CID    what burning it yields
//
// The empty-reset case is the important one. A Soulmint Necklace (item 214)
// carries `REPAIR_COUNT_CID: 2` and empty reset arrays, so once its two repairs
// are spent it is finished: no amount of Gear Ember will restore it. The repair
// endpoint still answers "Gear is already at max repair count 2 of 2, use
// restore endpoint instead", and restore then fails with "Reset items not
// found" — the server naming the empty RESET_INPUT array. Following that advice
// costs a farming trip for a currency that was never going to be spent.
//
// Restorability is per item, not per gear type: of the 18 type-3 charms, 5 have
// a reset recipe and 13 do not. So it has to be read per item, never inferred
// from the slot.

export interface GearRepairCost {
  INPUT_ID_CID_array?: number[];
  INPUT_AMOUNT_CID_array?: number[];
  RESET_INPUT_ID_CID_array?: number[];
  RESET_INPUT_AMOUNT_CID_array?: number[];
}

/** One rarity's worth of triggered effects. Index 0 is the base rarity. */
export interface GearEffectTier {
  effects?: {
    triggerType?: string;
    durabilityChange?: number;
    effects?: { type?: string; amount?: number }[];
  }[];
}

export interface GearItemDef {
  GAME_ITEM_ID_CID: number;
  NAME_CID?: string;
  GEAR_TYPE_CID?: number;
  /** Which slot this piece occupies. Slots are numbered, not named, by the API. */
  EQUIPPABLE_TO_CID?: number;
  /** Durability by rarity, e.g. [40, 44, 50, 60] */
  DURABILITY_CID_array?: number[];
  /** What the piece grants, indexed by rarity */
  itemEffects?: GearEffectTier[];
  /** Repairs allowed before the item needs restoring (or is finished) */
  REPAIR_COUNT_CID?: number;
  repairCost?: GearRepairCost;
  /** Item id yielded by burning this gear */
  LOOT_ID_CID?: number;
  LOOT_AMOUNT_CID?: number;
}

export interface ItemCost {
  itemId: number;
  amount: number;
}

/**
 * One owned piece of gear, as far as repair accounting is concerned.
 *
 * `REPAIR_COUNT_CID` on an INSTANCE is the number of repairs already spent on
 * that piece. The identically named field on the DEFINITION is the ceiling. The
 * server's own refusal reads "already at max repair count 2 of 2" — used, then
 * max — and the instance field is absent on gear that has never been repaired,
 * which is what a spent-count starts at and not what a remaining-count would.
 */
export interface GearInstanceRepairState {
  REPAIR_COUNT_CID?: number;
}

/**
 * Repairs this piece has left, or null when the answer isn't knowable yet.
 *
 * Null means one of the two numbers is missing — no definition loaded, or an
 * instance that has never been repaired and so carries no counter. Callers must
 * treat null as "don't know" and leave the piece repairable: the cost of trying
 * a repair that fails is one request and a learned fact, while the cost of
 * hiding a repairable piece is gear that silently rots out of the daily plan.
 */
export function repairsLeft(
  instance: GearInstanceRepairState | undefined,
  def: GearItemDef | undefined
): number | null {
  const max = def?.REPAIR_COUNT_CID;
  if (typeof max !== "number") return null;
  const used = instance?.REPAIR_COUNT_CID ?? 0;
  return Math.max(0, max - used);
}

/**
 * Is this piece provably out of repairs, so that repair is the wrong offer?
 *
 * Deliberately answers false when unknown. This is the difference between
 * "the definitions say repair will be refused" and "we have not tried yet",
 * and only the first justifies routing a piece to the restore flow before the
 * server has said anything.
 */
export function isRepairExhausted(
  instance: GearInstanceRepairState | undefined,
  def: GearItemDef | undefined
): boolean {
  const left = repairsLeft(instance, def);
  return left != null && left <= 0;
}

function pairCosts(ids?: number[], amounts?: number[]): ItemCost[] {
  if (!ids?.length) return [];
  return ids.map((itemId, i) => ({ itemId, amount: amounts?.[i] ?? 0 }));
}

/** What one repair of this gear costs. */
export function repairCost(def: GearItemDef | undefined): ItemCost[] {
  return pairCosts(
    def?.repairCost?.INPUT_ID_CID_array,
    def?.repairCost?.INPUT_AMOUNT_CID_array
  );
}

/** What one restore costs. Empty means the gear has no restore at all. */
export function restoreCost(def: GearItemDef | undefined): ItemCost[] {
  return pairCosts(
    def?.repairCost?.RESET_INPUT_ID_CID_array,
    def?.repairCost?.RESET_INPUT_AMOUNT_CID_array
  );
}

/**
 * Can this gear be restored at all?
 *
 * False for an unknown definition too. Offering a restore we have no definition
 * for is how a click turns into "Reset items not found" — better to say the
 * cost isn't known than to send a request whose failure teaches nothing.
 */
export function isRestorable(def: GearItemDef | undefined): boolean {
  return restoreCost(def).length > 0;
}

/** What burning this gear yields, if anything. */
export function burnYield(def: GearItemDef | undefined): ItemCost | null {
  if (!def?.LOOT_ID_CID) return null;
  return { itemId: def.LOOT_ID_CID, amount: def.LOOT_AMOUNT_CID ?? 1 };
}

export type RestoreVerdict =
  | { kind: "unknown"; reason: string }
  | { kind: "not-restorable"; reason: string; burn: ItemCost | null }
  | { kind: "short"; reason: string; cost: ItemCost[]; missing: ItemCost[] }
  | { kind: "ready"; cost: ItemCost[] };

/**
 * Whether a restore should be offered, and what it will cost.
 *
 * Checked before the request rather than after, because the two failure modes
 * look identical from the server ("Reset items not found") but call for opposite
 * responses: go and farm Gear Ember, or stop trying and burn the item.
 */
export function restoreVerdict(
  def: GearItemDef | undefined,
  balances: Record<number | string, number>,
  itemName: (id: number) => string = (id) => `#${id}`
): RestoreVerdict {
  if (!def) {
    return {
      kind: "unknown",
      reason: "No gear definition loaded, so the restore cost is unknown.",
    };
  }

  const cost = restoreCost(def);
  if (cost.length === 0) {
    const burn = burnYield(def);
    const repairs = def.REPAIR_COUNT_CID ?? 0;
    return {
      kind: "not-restorable",
      reason:
        `This gear has no restore recipe — its ${repairs} repair${repairs === 1 ? "" : "s"} ` +
        `${repairs === 1 ? "is" : "are"} all it gets. ` +
        (burn
          ? `Burn it for ${burn.amount}x ${itemName(burn.itemId)} and replace it.`
          : `It cannot be restored or burned.`),
      burn,
    };
  }

  const missing = cost
    .map((c) => ({ itemId: c.itemId, amount: c.amount - (balances[c.itemId] ?? 0) }))
    .filter((c) => c.amount > 0);

  if (missing.length > 0) {
    return {
      kind: "short",
      reason: `Needs ${missing.map((m) => `${m.amount} more ${itemName(m.itemId)}`).join(", ")}.`,
      cost,
      missing,
    };
  }

  return { kind: "ready", cost };
}

/** Index gear definitions by their game item id. */
export function indexGearDefs(response: unknown): Record<number, GearItemDef> {
  const entities = (response as { entities?: GearItemDef[] } | null | undefined)?.entities;
  const out: Record<number, GearItemDef> = {};
  for (const def of entities ?? []) {
    if (typeof def?.GAME_ITEM_ID_CID === "number") out[def.GAME_ITEM_ID_CID] = def;
  }
  return out;
}
