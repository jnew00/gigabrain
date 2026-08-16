// What gear to make next, read from the game's own recipes and effect tables.
//
// Everything here comes from two published sources — `/api/gear/items` for what
// a piece does, and the `recipes` block of `/api/offchain/static` for what it
// costs. Nothing is hardcoded about which gear is good, because the tables move
// and a table in the code would quietly stop matching the game.
//
// Shapes verified against live responses on 2026-08-15:
//
//   Gear def   itemEffects[rarity].effects[] = { triggerType, durabilityChange,
//              effects: [{ type, amount }] }
//   Recipe     INPUT_ID_CID_array / INPUT_AMOUNT_CID_array -> LOOT_ID_CID_array
//
// Two findings from that data shape the advice below, and both are the kind of
// thing a player would otherwise buy their way into learning:
//
//   - Rods carry no effects at all. Wood, Stone and Phin's Rod all publish
//     `OnStartFishing` with an EMPTY effects array and the same durability
//     ladder, so no rod out-fishes another. A rod is a consumable that lets you
//     cast; it is never an upgrade. The advisor says so rather than ranking
//     three identical things.
//   - The fishing bonuses live in a different slot entirely (Gigapengu, slot
//     10, carries IncreaseFishingDoublerChance). That is the slot worth
//     spending on.

import type { GearItemDef, ItemCost } from "./gear";
import { isRestorable, repairsLeft, type GearInstanceRepairState } from "./gear";

/** A single granted effect, flattened out of the nested trigger structure. */
export interface GearEffect {
  type: string;
  amount: number;
}

export type GearPurpose = "dungeon" | "fishing";

/** The trigger that carries each purpose's effects. */
const TRIGGER: Record<GearPurpose, string> = {
  dungeon: "OnStartDungeon",
  fishing: "OnStartFishing",
};

/**
 * The effects a piece grants at a given rarity, for one purpose.
 *
 * Rarity indexes `itemEffects` directly. An out-of-range rarity falls back to
 * the lowest entry rather than throwing: an unfamiliar rarity should understate
 * a piece, not blank the whole suggestion list.
 */
export function effectsFor(
  def: GearItemDef | undefined,
  rarity: number,
  purpose: GearPurpose
): GearEffect[] {
  const tiers = def?.itemEffects;
  if (!tiers?.length) return [];
  const tier = tiers[rarity] ?? tiers[0];
  const out: GearEffect[] = [];
  for (const group of tier?.effects ?? []) {
    if (group?.triggerType !== TRIGGER[purpose]) continue;
    for (const e of group.effects ?? []) {
      if (typeof e?.type === "string" && typeof e?.amount === "number") {
        out.push({ type: e.type, amount: e.amount });
      }
    }
  }
  return out;
}

/**
 * Effect names as the game words them, minus the internal prefixes.
 *
 * Unknown types pass through unchanged rather than being dropped or renamed —
 * a new effect the game adds should show up as itself, not vanish from a
 * suggestion whose whole value is saying what the piece does.
 */
export function describeEffect(effect: GearEffect): string {
  const NAMES: Record<string, string> = {
    IncreaseDamage_Sword: "Sword damage",
    IncreaseDamage_Shield: "Shield damage",
    IncreaseDamage_Spell: "Spell damage",
    IncreaseDamage_Random: "random damage",
    IncreaseArmor_Sword: "Sword armor",
    IncreaseArmor_Shield: "Shield armor",
    IncreaseArmor_Spell: "Spell armor",
    IncreaseArmor_Random: "random armor",
    IncreaseMaxHealth: "max HP",
    IncreaseMaxArmor: "max armor",
    IncreaseFishingDoublerChance: "doubler chance",
    IncreaseFishingPredictionChance: "prediction chance",
    IncreaseFishingCritChance: "crit chance",
    IncreaseFishingJebaitorChance: "jebaitor chance",
    IncreaseFishingQualityChance: "quality chance",
    IncreaseFishingRarityChance: "rarity chance",
    AdjustEchoChance: "echo chance",
    GrantBoon: "boon",
    Heal: "heal",
    Prevent: "prevent",
  };
  const label = NAMES[effect.type] ?? effect.type;
  return `+${effect.amount} ${label}`;
}

export function describeEffects(effects: GearEffect[]): string {
  return effects.map(describeEffect).join(", ");
}

/**
 * Is this piece part of this activity's kit at all?
 *
 * The trigger answers that, not the effect list. A rod publishes
 * `OnStartFishing` with nothing in it — it grants no bonus, but it is still the
 * thing without which you cannot cast. Testing effects instead would drop every
 * rod from the suggestions and leave an empty rod slot unmentioned, which is
 * the one fishing problem that stops the day outright.
 */
export function servesPurpose(
  def: GearItemDef | undefined,
  purpose: GearPurpose
): boolean {
  return (def?.itemEffects ?? []).some((tier) =>
    (tier?.effects ?? []).some((g) => g?.triggerType === TRIGGER[purpose])
  );
}

/** The recipe fields this module reads. */
export interface GearRecipe {
  ID_CID?: string;
  NAME_CID?: string;
  INPUT_ID_CID_array?: number[];
  INPUT_AMOUNT_CID_array?: number[];
  LOOT_ID_CID_array?: number[];
  ENERGY_CID?: number;
}

/** One owned piece, as far as slot occupancy is concerned. */
export interface OwnedGear extends GearInstanceRepairState {
  GAME_ITEM_ID_CID: number;
  DURABILITY_CID: number;
  EQUIPPED_TO_SLOT_CID: number;
  RARITY_CID?: number;
}

export type SuggestionKind =
  /** The slot is filled with a piece that cannot be repaired or restored. */
  | "replace-dead"
  /** The slot is empty. */
  | "fill-empty"
  /** A piece that grants more of this purpose's effects than what is worn. */
  | "upgrade";

export interface GearSuggestion {
  recipeId: string;
  recipeName: string;
  outputItemId: number;
  outputName: string;
  slot: number;
  purpose: GearPurpose;
  kind: SuggestionKind;
  energy: number;
  /** What it grants at base rarity. Empty for pieces that only add durability. */
  effects: GearEffect[];
  cost: ItemCost[];
  /** Materials still needed. Empty means it can be made now. */
  missing: ItemCost[];
  affordable: boolean;
  reason: string;
}

export interface SuggestGearInput {
  /** Gear definitions keyed by game item id. */
  defs: Record<number, GearItemDef>;
  /** Every recipe from the static block; gear ones are picked out here. */
  recipes: GearRecipe[];
  /** Item balances, keyed by id in either number or string form. */
  balances: Record<number | string, number>;
  /** Every gear instance the player owns. */
  owned: OwnedGear[];
  itemName: (id: number) => string;
}

/**
 * A recipe whose only input is an item of the same name is a loot box: one
 * token in, a random piece out. Those cannot be advice — the output is not
 * known until it is opened — so they are dropped rather than presented as a
 * craft with a predictable result.
 */
function isLootBox(recipe: GearRecipe, itemName: (id: number) => string): boolean {
  const inputs = recipe.INPUT_ID_CID_array ?? [];
  if (inputs.length !== 1) return false;
  return itemName(inputs[0]) === recipe.NAME_CID;
}

function totalEffect(effects: GearEffect[]): number {
  return effects.reduce((s, e) => s + e.amount, 0);
}

/**
 * Is this owned piece finished — worn out, out of repairs, and with no restore?
 *
 * The three conditions together, because any one alone is recoverable: a broken
 * piece with repairs left gets repaired, and a spent piece with a reset recipe
 * gets restored. Only all three at once means the slot needs a new piece.
 */
export function isDeadGear(owned: OwnedGear, def: GearItemDef | undefined): boolean {
  if (owned.DURABILITY_CID > 0) return false;
  const left = repairsLeft(owned, def);
  if (left == null || left > 0) return false;
  return !isRestorable(def);
}

/**
 * What to make next, ranked by how much it changes.
 *
 * The ranking is deliberately blunt: a dead slot outranks an empty one, an
 * empty one outranks an upgrade, and within a kind the bigger effect wins. A
 * finer score would be inventing a model of the game's combat maths that
 * nothing here can check.
 */
export function suggestGear(input: SuggestGearInput): GearSuggestion[] {
  const { defs, recipes, balances, owned, itemName } = input;
  const have = (id: number) => balances[id] ?? balances[String(id)] ?? 0;

  // What is worn in each slot right now, and what it grants.
  const equippedBySlot = new Map<number, OwnedGear>();
  for (const g of owned) {
    if (g.EQUIPPED_TO_SLOT_CID >= 0) equippedBySlot.set(g.EQUIPPED_TO_SLOT_CID, g);
  }

  const out: GearSuggestion[] = [];

  for (const recipe of recipes) {
    if (isLootBox(recipe, itemName)) continue;
    const outputId = (recipe.LOOT_ID_CID_array ?? []).find((id) => defs[id]);
    if (outputId == null) continue;
    const def = defs[outputId];
    const slot = def.EQUIPPABLE_TO_CID;
    if (typeof slot !== "number") continue;

    const cost: ItemCost[] = (recipe.INPUT_ID_CID_array ?? []).map((itemId, i) => ({
      itemId,
      amount: recipe.INPUT_AMOUNT_CID_array?.[i] ?? 0,
    }));
    const missing = cost
      .map((c) => ({ itemId: c.itemId, amount: c.amount - have(c.itemId) }))
      .filter((c) => c.amount > 0);

    for (const purpose of ["dungeon", "fishing"] as const) {
      const effects = effectsFor(def, 0, purpose);
      const worn = equippedBySlot.get(slot);
      const wornDef = worn ? defs[worn.GAME_ITEM_ID_CID] : undefined;
      const wornEffects = worn ? effectsFor(wornDef, worn.RARITY_CID ?? 0, purpose) : [];

      // Does this piece belong to this activity's kit? Read from the trigger,
      // so a rod still counts as fishing gear despite granting nothing.
      if (!servesPurpose(def, purpose)) continue;

      let kind: SuggestionKind;
      let reason: string;
      if (worn && isDeadGear(worn, wornDef)) {
        kind = "replace-dead";
        reason =
          `${itemName(worn.GAME_ITEM_ID_CID)} is finished — broken, out of repairs, ` +
          `and it has no restore recipe. This slot needs a new piece.`;
      } else if (!worn) {
        kind = "fill-empty";
        reason = `Nothing equipped in this slot.`;
      } else if (totalEffect(effects) > totalEffect(wornEffects)) {
        kind = "upgrade";
        reason =
          `Beats the equipped ${itemName(worn.GAME_ITEM_ID_CID)} ` +
          `(${describeEffects(wornEffects) || "no bonuses"}).`;
      } else {
        continue;
      }

      out.push({
        recipeId: recipe.ID_CID ?? String(outputId),
        recipeName: recipe.NAME_CID ?? itemName(outputId),
        outputItemId: outputId,
        outputName: itemName(outputId),
        slot,
        purpose,
        kind,
        energy: recipe.ENERGY_CID ?? 0,
        effects,
        cost,
        missing,
        affordable: missing.length === 0,
        reason,
      });
    }
  }

  const KIND_RANK: Record<SuggestionKind, number> = {
    "replace-dead": 0,
    "fill-empty": 1,
    upgrade: 2,
  };
  return out.sort((a, b) => {
    // Something you can make now beats something you cannot, whatever it is:
    // an unaffordable best-in-slot is a shopping list, not a suggestion.
    if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    const byEffect = totalEffect(b.effects) - totalEffect(a.effects);
    if (byEffect !== 0) return byEffect;
    return a.missing.length - b.missing.length;
  });
}

/**
 * Slots whose equipped piece is finished, with nothing craftable to replace it.
 *
 * Surfaced separately because it is the one case the suggestion list cannot
 * answer: the slot needs a piece, and no recipe the player can reach makes one.
 * Silence there would read as "nothing to do".
 */
export function deadSlotsWithoutOptions(
  input: SuggestGearInput,
  suggestions: GearSuggestion[]
): { slot: number; itemName: string }[] {
  const covered = new Set(suggestions.map((s) => s.slot));
  const out: { slot: number; itemName: string }[] = [];
  for (const g of input.owned) {
    if (g.EQUIPPED_TO_SLOT_CID < 0) continue;
    if (covered.has(g.EQUIPPED_TO_SLOT_CID)) continue;
    if (!isDeadGear(g, input.defs[g.GAME_ITEM_ID_CID])) continue;
    out.push({ slot: g.EQUIPPED_TO_SLOT_CID, itemName: input.itemName(g.GAME_ITEM_ID_CID) });
  }
  return out;
}
