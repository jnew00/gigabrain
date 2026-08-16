import { describe, expect, it } from "vitest";
import {
  burnYield,
  indexGearDefs,
  isRepairExhausted,
  isRestorable,
  repairCost,
  repairsLeft,
  restoreCost,
  restoreVerdict,
  type GearItemDef,
} from "./gear";

// Both taken verbatim from /api/gear/items on 2026-08-13.
const SOULMINT_NECKLACE: GearItemDef = {
  GAME_ITEM_ID_CID: 214,
  NAME_CID: "Soulmint Necklace [GEAR]",
  GEAR_TYPE_CID: 3,
  REPAIR_COUNT_CID: 2,
  repairCost: {
    INPUT_ID_CID_array: [7],
    INPUT_AMOUNT_CID_array: [10],
    RESET_INPUT_ID_CID_array: [],
    RESET_INPUT_AMOUNT_CID_array: [],
  },
  LOOT_ID_CID: 250,
  LOOT_AMOUNT_CID: 1,
};

const RED_ROBE_HEAD: GearItemDef = {
  GAME_ITEM_ID_CID: 12,
  NAME_CID: "Red Robe Head [GEAR]",
  GEAR_TYPE_CID: 1,
  REPAIR_COUNT_CID: 5,
  repairCost: {
    INPUT_ID_CID_array: [7],
    INPUT_AMOUNT_CID_array: [10],
    RESET_INPUT_ID_CID_array: [250],
    RESET_INPUT_AMOUNT_CID_array: [1],
  },
  LOOT_ID_CID: 250,
  LOOT_AMOUNT_CID: 1,
};

const names: Record<number, string> = { 7: "Steel Pipe", 250: "Gear Ember" };
const itemName = (id: number) => names[id] ?? `#${id}`;

describe("restorability is a per-item fact", () => {
  it("reads an empty reset array as 'cannot be restored'", () => {
    // This is what the server means by "Reset items not found" — not that the
    // player is out of Ember, but that no reset recipe exists for the item.
    expect(restoreCost(SOULMINT_NECKLACE)).toEqual([]);
    expect(isRestorable(SOULMINT_NECKLACE)).toBe(false);
  });

  it("reads a populated reset array as restorable, with its cost", () => {
    expect(restoreCost(RED_ROBE_HEAD)).toEqual([{ itemId: 250, amount: 1 }]);
    expect(isRestorable(RED_ROBE_HEAD)).toBe(true);
  });

  it("does not infer restorability from the gear type", () => {
    // Both are gear with the same repair input; only the reset arrays differ.
    // Of the 18 type-3 charms in live data, 5 restore and 13 do not.
    expect(repairCost(SOULMINT_NECKLACE)).toEqual(repairCost(RED_ROBE_HEAD));
    expect(isRestorable(SOULMINT_NECKLACE)).not.toBe(isRestorable(RED_ROBE_HEAD));
  });

  it("treats an unknown definition as not restorable rather than assuming", () => {
    expect(isRestorable(undefined)).toBe(false);
    expect(restoreCost({ GAME_ITEM_ID_CID: 1 })).toEqual([]);
  });
});

describe("the verdict separates the two failures that look alike", () => {
  it("tells you to stop and burn when there is no restore recipe", () => {
    const v = restoreVerdict(SOULMINT_NECKLACE, { 250: 999 }, itemName);
    expect(v.kind).toBe("not-restorable");
    // Holding a mountain of Ember must not change this verdict.
    expect(v.kind === "not-restorable" && v.burn).toEqual({ itemId: 250, amount: 1 });
    expect(v.kind === "not-restorable" && v.reason).toContain("2 repairs");
    expect(v.kind === "not-restorable" && v.reason).toContain("Gear Ember");
  });

  it("tells you what to farm when the recipe exists but the items don't", () => {
    const v = restoreVerdict(RED_ROBE_HEAD, { 250: 0 }, itemName);
    expect(v.kind).toBe("short");
    expect(v.kind === "short" && v.missing).toEqual([{ itemId: 250, amount: 1 }]);
    expect(v.kind === "short" && v.reason).toContain("1 more Gear Ember");
  });

  it("clears the restore when the cost is covered", () => {
    const v = restoreVerdict(RED_ROBE_HEAD, { 250: 3 }, itemName);
    expect(v.kind).toBe("ready");
    expect(v.kind === "ready" && v.cost).toEqual([{ itemId: 250, amount: 1 }]);
  });

  it("says the cost is unknown rather than guessing when no definition loaded", () => {
    expect(restoreVerdict(undefined, {}, itemName).kind).toBe("unknown");
  });

  it("reads balances keyed by string, which is how the app stores them", () => {
    const v = restoreVerdict(RED_ROBE_HEAD, { "250": 5 }, itemName);
    expect(v.kind).toBe("ready");
  });
});

describe("burn yield", () => {
  it("reports what the gear turns into", () => {
    expect(burnYield(RED_ROBE_HEAD)).toEqual({ itemId: 250, amount: 1 });
  });

  it("returns null when nothing is published", () => {
    expect(burnYield({ GAME_ITEM_ID_CID: 1 })).toBeNull();
    expect(burnYield(undefined)).toBeNull();
  });
});

describe("indexing the definitions", () => {
  it("keys by game item id", () => {
    const idx = indexGearDefs({ entities: [SOULMINT_NECKLACE, RED_ROBE_HEAD] });
    expect(idx[214].NAME_CID).toBe("Soulmint Necklace [GEAR]");
    expect(Object.keys(idx)).toHaveLength(2);
  });

  it("survives a missing or malformed response", () => {
    expect(indexGearDefs(null)).toEqual({});
    expect(indexGearDefs({ entities: [{} as GearItemDef] })).toEqual({});
  });
});

describe("telling a repairable piece from a spent one", () => {
  it("counts repairs left as the ceiling minus the ones already spent", () => {
    expect(repairsLeft({ REPAIR_COUNT_CID: 0 }, SOULMINT_NECKLACE)).toBe(2);
    expect(repairsLeft({ REPAIR_COUNT_CID: 1 }, SOULMINT_NECKLACE)).toBe(1);
    expect(repairsLeft({ REPAIR_COUNT_CID: 2 }, SOULMINT_NECKLACE)).toBe(0);
  });

  it("treats a never-repaired instance as having spent none", () => {
    // The field is absent until the first repair, which is what a spent-count
    // starts at — a remaining-count would have been published from the start.
    expect(repairsLeft({}, RED_ROBE_HEAD)).toBe(5);
    expect(repairsLeft(undefined, RED_ROBE_HEAD)).toBe(5);
  });

  it("never reports negative repairs when the counter overshoots", () => {
    expect(repairsLeft({ REPAIR_COUNT_CID: 9 }, SOULMINT_NECKLACE)).toBe(0);
  });

  it("answers null when no definition is loaded", () => {
    expect(repairsLeft({ REPAIR_COUNT_CID: 1 }, undefined)).toBeNull();
    expect(repairsLeft({ REPAIR_COUNT_CID: 1 }, { GAME_ITEM_ID_CID: 1 })).toBeNull();
  });

  // The asymmetry is the point: a wrong "exhausted" hides gear from the daily
  // plan until someone notices, while a wrong "repairable" costs one request
  // that teaches the truth. So unknown stays repairable.
  it("only calls a piece exhausted when the definitions prove it", () => {
    expect(isRepairExhausted({ REPAIR_COUNT_CID: 2 }, SOULMINT_NECKLACE)).toBe(true);
    expect(isRepairExhausted({ REPAIR_COUNT_CID: 1 }, SOULMINT_NECKLACE)).toBe(false);
    expect(isRepairExhausted({ REPAIR_COUNT_CID: 5 }, undefined)).toBe(false);
    expect(isRepairExhausted(undefined, undefined)).toBe(false);
  });

  // The two halves of the answer the UI needs: repair is refused, and restore
  // is not on offer either, so the only move left is to burn and replace.
  it("pairs with restorability to identify a finished piece", () => {
    expect(isRepairExhausted({ REPAIR_COUNT_CID: 2 }, SOULMINT_NECKLACE)).toBe(true);
    expect(isRestorable(SOULMINT_NECKLACE)).toBe(false);

    expect(isRepairExhausted({ REPAIR_COUNT_CID: 5 }, RED_ROBE_HEAD)).toBe(true);
    expect(isRestorable(RED_ROBE_HEAD)).toBe(true);
  });
});
