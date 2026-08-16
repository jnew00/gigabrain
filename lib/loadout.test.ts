import { describe, expect, it } from "vitest";
import {
  buildLoadout,
  emptyWoodsSlots,
  isWoodsSlot,
  loadoutWarnings,
  slotLabel,
  usableHands,
  type GearPiece,
} from "./loadout";
import type { GearItemDef } from "./gear";

// Definitions and instances below are Jason's real gear, read from
// /api/gear/items and /api/gear/instances on 2026-08-15.

const def = (over: Partial<GearItemDef> & { GAME_ITEM_ID_CID: number }): GearItemDef => ({
  REPAIR_COUNT_CID: 2,
  repairCost: { RESET_INPUT_ID_CID_array: [], RESET_INPUT_AMOUNT_CID_array: [] },
  ...over,
});

const DEFS: Record<number, GearItemDef> = {
  228: def({ GAME_ITEM_ID_CID: 228, NAME_CID: "Silver Ring", EQUIPPABLE_TO_CID: 6, DURABILITY_CID_array: [20, 22, 24, 26] }),
  214: def({ GAME_ITEM_ID_CID: 214, NAME_CID: "Soulmint Necklace", EQUIPPABLE_TO_CID: 6, DURABILITY_CID_array: [20, 22, 24, 26] }),
  14: def({ GAME_ITEM_ID_CID: 14, NAME_CID: "Black Robe: Head", EQUIPPABLE_TO_CID: 2, REPAIR_COUNT_CID: 5, DURABILITY_CID_array: [40, 50, 60, 70], repairCost: { RESET_INPUT_ID_CID_array: [250], RESET_INPUT_AMOUNT_CID_array: [1] } }),
  70: def({ GAME_ITEM_ID_CID: 70, NAME_CID: "Fanatic: Head", EQUIPPABLE_TO_CID: 2, REPAIR_COUNT_CID: 5, DURABILITY_CID_array: [40, 50, 60, 70], repairCost: { RESET_INPUT_ID_CID_array: [250], RESET_INPUT_AMOUNT_CID_array: [1] } }),
  71: def({ GAME_ITEM_ID_CID: 71, NAME_CID: "Crimson Knight: Body", EQUIPPABLE_TO_CID: 3, REPAIR_COUNT_CID: 5, DURABILITY_CID_array: [60, 70, 80, 90], repairCost: { RESET_INPUT_ID_CID_array: [250], RESET_INPUT_AMOUNT_CID_array: [1] } }),
  234: def({ GAME_ITEM_ID_CID: 234, NAME_CID: "Paper Hands", EQUIPPABLE_TO_CID: 7, REPAIR_COUNT_CID: 1, DURABILITY_CID_array: [12, 16, 20, 24] }),
  235: def({ GAME_ITEM_ID_CID: 235, NAME_CID: "Rock Hands", EQUIPPABLE_TO_CID: 7, REPAIR_COUNT_CID: 2, DURABILITY_CID_array: [24, 28, 32, 36] }),
};

const NAMES: Record<number, string> = Object.fromEntries(
  Object.values(DEFS).map((d) => [d.GAME_ITEM_ID_CID, d.NAME_CID!])
);
const itemName = (id: number) => NAMES[id] ?? `#${id}`;

const piece = (over: Partial<GearPiece> & { docId: string; GAME_ITEM_ID_CID: number }): GearPiece => ({
  DURABILITY_CID: 20, EQUIPPED_TO_SLOT_CID: -1, EQUIPPED_TO_INDEX_CID: -1,
  RARITY_CID: 0, REPAIR_COUNT_CID: 0, ...over,
});

/** The live loadout: hands owned and usable, but sitting in the bag. */
const REAL: GearPiece[] = [
  piece({ docId: "ring-a", GAME_ITEM_ID_CID: 228, DURABILITY_CID: 0, EQUIPPED_TO_SLOT_CID: 6, EQUIPPED_TO_INDEX_CID: 1, REPAIR_COUNT_CID: 2 }),
  piece({ docId: "ring-b", GAME_ITEM_ID_CID: 228, DURABILITY_CID: 0, REPAIR_COUNT_CID: 1 }),
  piece({ docId: "neck", GAME_ITEM_ID_CID: 214, DURABILITY_CID: 0, EQUIPPED_TO_SLOT_CID: 6, EQUIPPED_TO_INDEX_CID: 0, RARITY_CID: 2, REPAIR_COUNT_CID: 2 }),
  piece({ docId: "head", GAME_ITEM_ID_CID: 14, DURABILITY_CID: 44, EQUIPPED_TO_SLOT_CID: 2, EQUIPPED_TO_INDEX_CID: 0, RARITY_CID: 1, REPAIR_COUNT_CID: 4 }),
  piece({ docId: "head-b", GAME_ITEM_ID_CID: 70, DURABILITY_CID: 0, REPAIR_COUNT_CID: 0 }),
  piece({ docId: "body", GAME_ITEM_ID_CID: 71, DURABILITY_CID: 3, EQUIPPED_TO_SLOT_CID: 3, EQUIPPED_TO_INDEX_CID: 0, REPAIR_COUNT_CID: 1 }),
  piece({ docId: "paper", GAME_ITEM_ID_CID: 234, DURABILITY_CID: 6, REPAIR_COUNT_CID: 1 }),
  piece({ docId: "rock", GAME_ITEM_ID_CID: 235, DURABILITY_CID: 10, REPAIR_COUNT_CID: 1 }),
];

describe("naming slots", () => {
  it("uses the labels the live gear confirms", () => {
    expect(slotLabel(7)).toBe("Toolbar");
    expect(slotLabel(8)).toBe("Rod");
  });

  // Same rule as an unknown pond: say the number, never invent a name.
  it("shows an unconfirmed slot by number", () => {
    expect(slotLabel(99)).toBe("Slot 99");
  });
});

describe("building the loadout", () => {
  const slots = buildLoadout(REAL, DEFS, itemName);

  it("files gear under the slot it fits, equipped or not", () => {
    const hands = slots.find((s) => s.slot === 7)!;
    expect(hands.equipped).toHaveLength(0);
    expect(hands.benched.map((b) => b.name)).toEqual(["Rock Hands", "Paper Hands"]);
  });

  it("keeps multiple pieces in one slot in index order", () => {
    const charm = slots.find((s) => s.slot === 6)!;
    expect(charm.equipped.map((e) => e.name)).toEqual(["Soulmint Necklace", "Silver Ring"]);
  });

  it("reads durability against the rarity's own ceiling", () => {
    const head = slots.find((s) => s.slot === 2)!.equipped[0];
    expect(head.durability).toBe(44);
    expect(head.maxDurability).toBe(50); // rarity 1
  });

  it("marks a piece dead only when broken, spent and unrestorable", () => {
    const charm = slots.find((s) => s.slot === 6)!;
    expect(charm.equipped.every((e) => e.dead)).toBe(true);
    // Same condition, but this one has a restore recipe.
    const benchHead = slots.find((s) => s.slot === 2)!.benched[0];
    expect(benchHead.name).toBe("Fanatic: Head");
    expect(benchHead.dead).toBe(false);
  });
});

describe("what is wrong with the kit", () => {
  const warnings = loadoutWarnings(buildLoadout(REAL, DEFS, itemName));

  // The case every other panel misses: healthy gear is not "worn", so a full
  // pair of hands in the bag never showed up anywhere, and the empty slot is
  // why the pot does not open.
  // The Toolbar is the one slot the API never publishes: three tools sit in
  // it in game while no instance reports slot 7. Reporting it empty sent the
  // player to fix something that was already fine.
  it("stays silent about the Toolbar, whose contents are not published", () => {
    expect(warnings.some((x) => x.slot === 7)).toBe(false);
  });

  it("flags equipped gear that is finished", () => {
    const dead = warnings.filter((x) => x.kind === "equipped-dead");
    expect(dead.map((d) => d.message)).toEqual([
      expect.stringContaining("Soulmint Necklace"),
      expect.stringContaining("Silver Ring"),
    ]);
  });

  it("flags equipped gear about to break", () => {
    // Crimson Knight: Body at 3 of 60 — five percent left.
    const low = warnings.find((x) => x.kind === "equipped-low");
    expect(low?.message).toContain("3 of 60 uses left");
  });

  it("does not call healthy gear low", () => {
    // Black Robe: Head at 44 of 50.
    expect(warnings.some((w) => w.message.includes("Black Robe"))).toBe(false);
  });

  it("says nothing about a slot that is empty with nothing to put in it", () => {
    const bare = buildLoadout(
      [piece({ docId: "x", GAME_ITEM_ID_CID: 234, DURABILITY_CID: 0 })],
      DEFS, itemName
    );
    expect(loadoutWarnings(bare).filter((w) => w.kind === "slot-empty-with-bench")).toEqual([]);
  });

  it("spots a usable bench piece behind a spent equipped one", () => {
    const swap = buildLoadout([
      piece({ docId: "worn", GAME_ITEM_ID_CID: 14, DURABILITY_CID: 0, EQUIPPED_TO_SLOT_CID: 2, REPAIR_COUNT_CID: 5 }),
      piece({ docId: "fresh", GAME_ITEM_ID_CID: 70, DURABILITY_CID: 30 }),
    ], DEFS, itemName);
    const w = loadoutWarnings(swap).find((x) => x.kind === "bench-beats-equipped");
    expect(w?.message).toContain("Fanatic: Head sits in your bag with 30");
  });
});

describe("picking hands for a pot", () => {
  it("ignores a pair with no uses left", () => {
    const spent = [piece({ docId: "p", GAME_ITEM_ID_CID: 234, DURABILITY_CID: 0 })];
    expect(usableHands(spent, DEFS, itemName, "paper")).toBeNull();
  });

  it("finds the usable pair regardless of whether it is equipped", () => {
    expect(usableHands(REAL, DEFS, itemName, "paper")?.docId).toBe("paper");
    expect(usableHands(REAL, DEFS, itemName, "rock")?.docId).toBe("rock");
  });

  // Burning the nearly-spent pair first keeps the fresher one in reserve.
  it("spends the most worn usable pair first", () => {
    const two = [
      piece({ docId: "fresh", GAME_ITEM_ID_CID: 234, DURABILITY_CID: 12 }),
      piece({ docId: "worn", GAME_ITEM_ID_CID: 234, DURABILITY_CID: 2 }),
    ];
    expect(usableHands(two, DEFS, itemName, "paper")?.docId).toBe("worn");
  });

  it("returns null when no such hands are owned", () => {
    expect(usableHands(REAL, DEFS, itemName, "iron")).toBeNull();
  });
});

describe("the Forbidden Woods loadout is a second, separate set", () => {
  // Slots 11-15 are the Forest Shrine's; 2/3/6/8/10 are the Gear Station's.
  // Confirmed off EQUIPPABLE_TO_CID in /api/gear/items on 2026-08-15.
  it("labels the woods slots apart from the dungeon ones", () => {
    expect(slotLabel(2)).toBe("Head");
    expect(slotLabel(11)).toBe("Woods head");
    expect(slotLabel(12)).toBe("Woods body");
    expect(slotLabel(14)).toBe("Woods rod");
    expect(slotLabel(15)).toBe("Woods lure");
  });

  it("knows which slots belong to the woods", () => {
    expect(isWoodsSlot(11)).toBe(true);
    expect(isWoodsSlot(2)).toBe(false);
    expect(isWoodsSlot(7)).toBe(false); // toolbar is shared
  });

  // The exact state after equipping only the woods head: one of five filled.
  it("reports every unfilled woods slot", () => {
    const slots = buildLoadout(
      [piece({ docId: "wh", GAME_ITEM_ID_CID: 300, DURABILITY_CID: 40, EQUIPPED_TO_SLOT_CID: 11, EQUIPPED_TO_INDEX_CID: 0 })],
      { 300: { GAME_ITEM_ID_CID: 300, NAME_CID: "Toxishroom: Head", EQUIPPABLE_TO_CID: 11, REPAIR_COUNT_CID: 5 } },
      (id) => (id === 300 ? "Toxishroom: Head" : `#${id}`)
    );
    expect(emptyWoodsSlots(slots)).toEqual([12, 13, 14, 15]);
  });

  it("reports nothing once every woods slot is filled", () => {
    const defs: Record<number, GearItemDef> = {};
    const owned = [11, 12, 13, 14, 15].map((slot, i) => {
      defs[400 + i] = { GAME_ITEM_ID_CID: 400 + i, EQUIPPABLE_TO_CID: slot, REPAIR_COUNT_CID: 5 };
      return piece({ docId: `w${slot}`, GAME_ITEM_ID_CID: 400 + i, DURABILITY_CID: 40, EQUIPPED_TO_SLOT_CID: slot, EQUIPPED_TO_INDEX_CID: 0 });
    });
    expect(emptyWoodsSlots(buildLoadout(owned, defs, (id) => `#${id}`))).toEqual([]);
  });

  // An empty event slot outranks a worn dungeon piece: the run costs the same
  // energy either way and the event's rewards expire.
  it("warns about empty woods slots before anything else", () => {
    const slots = buildLoadout(REAL, DEFS, itemName);
    const w = loadoutWarnings(slots, [12, 13]);
    expect(w[0].kind).toBe("woods-slot-empty");
    expect(w[0].message).toContain("Forest Shrine");
    expect(w[1].kind).toBe("woods-slot-empty");
  });

  it("says nothing extra when no woods slots are passed", () => {
    const slots = buildLoadout(REAL, DEFS, itemName);
    expect(loadoutWarnings(slots).some((x) => x.kind === "woods-slot-empty")).toBe(false);
  });
});
