import { describe, expect, it } from "vitest";
import {
  deadSlotsWithoutOptions,
  describeEffects,
  effectsFor,
  isDeadGear,
  servesPurpose,
  suggestGear,
  type GearRecipe,
  type OwnedGear,
  type SuggestGearInput,
} from "./gear-advisor";
import type { GearItemDef } from "./gear";

// Every fixture below is the real shape from /api/gear/items and the static
// recipes block, captured 2026-08-15.

/** Slot 10 charm. The only fishing piece in the data that grants anything. */
const GIGAPENGU: GearItemDef = {
  GAME_ITEM_ID_CID: 298,
  NAME_CID: "Gigapengu [GEAR]",
  GEAR_TYPE_CID: 11,
  EQUIPPABLE_TO_CID: 10,
  REPAIR_COUNT_CID: 2,
  itemEffects: [
    { effects: [{ triggerType: "OnStartFishing", durabilityChange: -1, effects: [{ type: "IncreaseFishingDoublerChance", amount: 2.25 }] }] },
    { effects: [{ triggerType: "OnStartFishing", durabilityChange: -1, effects: [{ type: "IncreaseFishingDoublerChance", amount: 2.5 }] }] },
    { effects: [{ triggerType: "OnStartFishing", durabilityChange: -1, effects: [{ type: "IncreaseFishingDoublerChance", amount: 2.75 }] }] },
    { effects: [{ triggerType: "OnStartFishing", durabilityChange: -1, effects: [{ type: "IncreaseFishingDoublerChance", amount: 3 }] }] },
  ],
  repairCost: { RESET_INPUT_ID_CID_array: [250], RESET_INPUT_AMOUNT_CID_array: [1] },
} as GearItemDef;

/** Rods publish the trigger with an EMPTY effect list at every rarity. */
const WOOD_ROD: GearItemDef = {
  GAME_ITEM_ID_CID: 49,
  NAME_CID: "Wood Rod [GEAR]",
  GEAR_TYPE_CID: 9,
  EQUIPPABLE_TO_CID: 8,
  REPAIR_COUNT_CID: 2,
  itemEffects: Array.from({ length: 4 }, () => ({
    effects: [{ triggerType: "OnStartFishing", durabilityChange: -1, effects: [] }],
  })),
  repairCost: { RESET_INPUT_ID_CID_array: [], RESET_INPUT_AMOUNT_CID_array: [] },
} as GearItemDef;

const RED_ROBE_HEAD: GearItemDef = {
  GAME_ITEM_ID_CID: 12,
  NAME_CID: "Red Robe Head [GEAR]",
  GEAR_TYPE_CID: 1,
  EQUIPPABLE_TO_CID: 2,
  REPAIR_COUNT_CID: 5,
  itemEffects: Array.from({ length: 4 }, () => ({
    effects: [{ triggerType: "OnStartDungeon", durabilityChange: -1, effects: [{ type: "IncreaseDamage_Shield", amount: 1 }] }],
  })),
  repairCost: { RESET_INPUT_ID_CID_array: [250], RESET_INPUT_AMOUNT_CID_array: [1] },
} as GearItemDef;

/** Same slot as Red Robe Head, strictly better. */
const BLACK_ROBE_HEAD: GearItemDef = {
  GAME_ITEM_ID_CID: 14,
  NAME_CID: "Black Robe Head [GEAR]",
  GEAR_TYPE_CID: 1,
  EQUIPPABLE_TO_CID: 2,
  REPAIR_COUNT_CID: 5,
  itemEffects: Array.from({ length: 4 }, () => ({
    effects: [{ triggerType: "OnStartDungeon", durabilityChange: -1, effects: [{ type: "IncreaseDamage_Shield", amount: 3 }] }],
  })),
  repairCost: { RESET_INPUT_ID_CID_array: [250], RESET_INPUT_AMOUNT_CID_array: [1] },
} as GearItemDef;

/** Jason's actual dead necklace: 2 of 2 repairs, empty reset arrays. */
const SOULMINT: GearItemDef = {
  GAME_ITEM_ID_CID: 214,
  NAME_CID: "Soulmint Necklace [GEAR]",
  GEAR_TYPE_CID: 3,
  EQUIPPABLE_TO_CID: 6,
  REPAIR_COUNT_CID: 2,
  itemEffects: Array.from({ length: 4 }, () => ({
    effects: [{ triggerType: "OnStartDungeon", durabilityChange: -1, effects: [{ type: "IncreaseMaxHealth", amount: 2 }] }],
  })),
  repairCost: { RESET_INPUT_ID_CID_array: [], RESET_INPUT_AMOUNT_CID_array: [] },
} as GearItemDef;

const AMULET: GearItemDef = {
  GAME_ITEM_ID_CID: 215,
  NAME_CID: "Iron Amulet [GEAR]",
  GEAR_TYPE_CID: 3,
  EQUIPPABLE_TO_CID: 6,
  REPAIR_COUNT_CID: 2,
  itemEffects: Array.from({ length: 4 }, () => ({
    effects: [{ triggerType: "OnStartDungeon", durabilityChange: -1, effects: [{ type: "IncreaseMaxHealth", amount: 1 }] }],
  })),
  repairCost: { RESET_INPUT_ID_CID_array: [250], RESET_INPUT_AMOUNT_CID_array: [1] },
} as GearItemDef;

const NAMES: Record<number, string> = {
  7: "Steel Pipe", 12: "Red Robe: Head", 14: "Black Robe: Head", 49: "Wood Rod",
  212: "Wood", 213: "Fiber", 214: "Soulmint Necklace", 215: "Iron Amulet",
  250: "Gear Ember", 298: "Gigapengu", 300: "Alchemy XP", 400: "Dungeon Scrap",
  999: "Mystery Box",
};
const itemName = (id: number) => NAMES[id] ?? `#${id}`;

const defs: Record<number, GearItemDef> = {
  12: RED_ROBE_HEAD, 14: BLACK_ROBE_HEAD, 49: WOOD_ROD,
  214: SOULMINT, 215: AMULET, 298: GIGAPENGU,
};

const recipe = (over: Partial<GearRecipe>): GearRecipe => ({
  ID_CID: "r", NAME_CID: "r", INPUT_ID_CID_array: [], INPUT_AMOUNT_CID_array: [],
  LOOT_ID_CID_array: [], ENERGY_CID: 20, ...over,
});

const RED_ROBE_RECIPE = recipe({
  ID_CID: "40001", NAME_CID: "Red Robe Head - [GEAR]",
  INPUT_ID_CID_array: [12, 300, 400], INPUT_AMOUNT_CID_array: [1, 8, 45],
  LOOT_ID_CID_array: [12],
});
const BLACK_ROBE_RECIPE = recipe({
  ID_CID: "40003", NAME_CID: "Black Robe Head - [GEAR]",
  INPUT_ID_CID_array: [14, 300, 400], INPUT_AMOUNT_CID_array: [1, 12, 75],
  LOOT_ID_CID_array: [14],
});
const ROD_RECIPE = recipe({
  ID_CID: "40010", NAME_CID: "Wooden Rod",
  INPUT_ID_CID_array: [212, 7, 213], INPUT_AMOUNT_CID_array: [15, 40, 10],
  LOOT_ID_CID_array: [49],
});
const PENGU_RECIPE = recipe({
  ID_CID: "40020", NAME_CID: "Gigapengu - [GEAR]",
  INPUT_ID_CID_array: [212, 400], INPUT_AMOUNT_CID_array: [5, 100],
  LOOT_ID_CID_array: [298],
});
const AMULET_RECIPE = recipe({
  ID_CID: "40030", NAME_CID: "Iron Amulet - [GEAR]",
  INPUT_ID_CID_array: [400], INPUT_AMOUNT_CID_array: [200],
  LOOT_ID_CID_array: [215],
});

const own = (over: Partial<OwnedGear> & { GAME_ITEM_ID_CID: number }): OwnedGear => ({
  DURABILITY_CID: 40, EQUIPPED_TO_SLOT_CID: -1, RARITY_CID: 0, ...over,
});

const base = (over: Partial<SuggestGearInput> = {}): SuggestGearInput => ({
  defs,
  recipes: [RED_ROBE_RECIPE, BLACK_ROBE_RECIPE, ROD_RECIPE, PENGU_RECIPE, AMULET_RECIPE],
  balances: { 7: 100, 212: 100, 213: 100, 300: 50, 400: 5000, 12: 5, 14: 5 },
  owned: [],
  itemName,
  ...over,
});

describe("reading what a piece actually does", () => {
  it("pulls effects out of the trigger that matches the purpose", () => {
    expect(effectsFor(GIGAPENGU, 0, "fishing")).toEqual([
      { type: "IncreaseFishingDoublerChance", amount: 2.25 },
    ]);
    expect(effectsFor(GIGAPENGU, 0, "dungeon")).toEqual([]);
  });

  it("indexes effects by rarity", () => {
    expect(effectsFor(GIGAPENGU, 3, "fishing")[0].amount).toBe(3);
  });

  it("falls back to the lowest rarity rather than blanking an unknown one", () => {
    expect(effectsFor(GIGAPENGU, 99, "fishing")[0].amount).toBe(2.25);
  });

  // The finding that makes "which rod should I buy" the wrong question.
  it("reports no effects for a rod, which publishes an empty effect list", () => {
    expect(effectsFor(WOOD_ROD, 0, "fishing")).toEqual([]);
    expect(effectsFor(WOOD_ROD, 3, "fishing")).toEqual([]);
  });

  it("survives a missing definition", () => {
    expect(effectsFor(undefined, 0, "dungeon")).toEqual([]);
  });

  it("names effects in the game's terms and keeps unknown ones intact", () => {
    expect(describeEffects(effectsFor(GIGAPENGU, 0, "fishing"))).toBe("+2.25 doubler chance");
    expect(describeEffects([{ type: "SomeNewEffect", amount: 4 }])).toBe("+4 SomeNewEffect");
  });
});

describe("recognising a piece that is finished", () => {
  it("needs all three: broken, out of repairs, and no restore", () => {
    expect(isDeadGear(own({ GAME_ITEM_ID_CID: 214, DURABILITY_CID: 0, REPAIR_COUNT_CID: 2 }), SOULMINT)).toBe(true);
  });

  it("is not dead while durability remains", () => {
    expect(isDeadGear(own({ GAME_ITEM_ID_CID: 214, DURABILITY_CID: 5, REPAIR_COUNT_CID: 2 }), SOULMINT)).toBe(false);
  });

  it("is not dead while a repair remains", () => {
    expect(isDeadGear(own({ GAME_ITEM_ID_CID: 214, DURABILITY_CID: 0, REPAIR_COUNT_CID: 1 }), SOULMINT)).toBe(false);
  });

  it("is not dead when a restore recipe exists", () => {
    expect(isDeadGear(own({ GAME_ITEM_ID_CID: 215, DURABILITY_CID: 0, REPAIR_COUNT_CID: 2 }), AMULET)).toBe(false);
  });

  it("is not dead when the definition is unknown", () => {
    expect(isDeadGear(own({ GAME_ITEM_ID_CID: 999, DURABILITY_CID: 0 }), undefined)).toBe(false);
  });
});

describe("suggesting what to make next", () => {
  it("puts replacing a finished piece above everything else", () => {
    const s = suggestGear(base({
      owned: [own({ GAME_ITEM_ID_CID: 214, DURABILITY_CID: 0, REPAIR_COUNT_CID: 2, EQUIPPED_TO_SLOT_CID: 6 })],
    }));
    expect(s[0].kind).toBe("replace-dead");
    expect(s[0].outputItemId).toBe(215);
    expect(s[0].reason).toContain("finished");
  });

  it("calls out an upgrade over a healthy equipped piece", () => {
    const s = suggestGear(base({
      owned: [own({ GAME_ITEM_ID_CID: 12, EQUIPPED_TO_SLOT_CID: 2 })],
    }));
    const up = s.find((x) => x.outputItemId === 14);
    expect(up?.kind).toBe("upgrade");
    expect(up?.reason).toContain("Red Robe: Head");
  });

  it("does not suggest a sidegrade or a downgrade", () => {
    const s = suggestGear(base({
      owned: [own({ GAME_ITEM_ID_CID: 14, EQUIPPED_TO_SLOT_CID: 2 })],
    }));
    expect(s.find((x) => x.outputItemId === 12)).toBeUndefined();
  });

  // A rod grants nothing, so it can never be an upgrade — but it still has to
  // be offered when the slot is empty, because without one you cannot fish.
  it("offers a rod for an empty slot but never as an upgrade", () => {
    const empty = suggestGear(base({ owned: [] }));
    expect(empty.find((x) => x.outputItemId === 49)?.kind).toBe("fill-empty");

    const worn = suggestGear(base({
      owned: [own({ GAME_ITEM_ID_CID: 49, EQUIPPED_TO_SLOT_CID: 8 })],
    }));
    expect(worn.find((x) => x.outputItemId === 49)).toBeUndefined();
  });

  it("separates fishing suggestions from dungeon ones", () => {
    const s = suggestGear(base({ owned: [] }));
    expect(s.find((x) => x.outputItemId === 298)?.purpose).toBe("fishing");
    expect(s.find((x) => x.outputItemId === 12)?.purpose).toBe("dungeon");
  });

  it("reports what is missing rather than hiding what cannot be made", () => {
    const s = suggestGear(base({ balances: { 400: 10 }, owned: [] }));
    const pengu = s.find((x) => x.outputItemId === 298);
    expect(pengu?.affordable).toBe(false);
    expect(pengu?.missing).toEqual([
      { itemId: 212, amount: 5 },
      { itemId: 400, amount: 90 },
    ]);
  });

  it("ranks anything makeable now above anything that is not", () => {
    const s = suggestGear(base({
      balances: { 400: 5000, 14: 1, 300: 50 },
      owned: [own({ GAME_ITEM_ID_CID: 12, EQUIPPED_TO_SLOT_CID: 2 })],
    }));
    const firstBlocked = s.findIndex((x) => !x.affordable);
    const lastAffordable = s.map((x) => x.affordable).lastIndexOf(true);
    if (firstBlocked !== -1) expect(lastAffordable).toBeLessThan(firstBlocked);
  });

  // One token in, a random piece out — the output is unknown until it opens,
  // so it cannot be presented as a craft with a predictable result.
  it("ignores loot boxes", () => {
    const box = recipe({
      ID_CID: "b", NAME_CID: "Mystery Box",
      INPUT_ID_CID_array: [999], INPUT_AMOUNT_CID_array: [1],
      LOOT_ID_CID_array: [14],
    });
    const s = suggestGear(base({ recipes: [box], owned: [] }));
    expect(s).toEqual([]);
  });

  it("reads balances keyed by string, which is how the app stores them", () => {
    const s = suggestGear(base({ balances: { "400": 5000, "212": 100 }, owned: [] }));
    expect(s.find((x) => x.outputItemId === 298)?.affordable).toBe(true);
  });
});

describe("a dead slot with nothing to replace it", () => {
  it("is surfaced separately, because silence would read as nothing to do", () => {
    const input = base({
      recipes: [],
      owned: [own({ GAME_ITEM_ID_CID: 214, DURABILITY_CID: 0, REPAIR_COUNT_CID: 2, EQUIPPED_TO_SLOT_CID: 6 })],
    });
    const dead = deadSlotsWithoutOptions(input, suggestGear(input));
    expect(dead).toEqual([{ slot: 6, itemName: "Soulmint Necklace" }]);
  });

  it("stays quiet when the slot has a craftable replacement", () => {
    const input = base({
      owned: [own({ GAME_ITEM_ID_CID: 214, DURABILITY_CID: 0, REPAIR_COUNT_CID: 2, EQUIPPED_TO_SLOT_CID: 6 })],
    });
    expect(deadSlotsWithoutOptions(input, suggestGear(input))).toEqual([]);
  });
});

describe("what counts as part of an activity's kit", () => {
  // The trigger is the marker, not the effect list — which is the only reason
  // a rod survives into the suggestions at all.
  it("counts a piece with an empty effect list under its own trigger", () => {
    expect(servesPurpose(WOOD_ROD, "fishing")).toBe(true);
    expect(servesPurpose(WOOD_ROD, "dungeon")).toBe(false);
  });

  it("keeps dungeon and fishing kit apart", () => {
    expect(servesPurpose(RED_ROBE_HEAD, "dungeon")).toBe(true);
    expect(servesPurpose(RED_ROBE_HEAD, "fishing")).toBe(false);
    expect(servesPurpose(GIGAPENGU, "fishing")).toBe(true);
  });

  it("says no for an unknown definition", () => {
    expect(servesPurpose(undefined, "fishing")).toBe(false);
  });
});
