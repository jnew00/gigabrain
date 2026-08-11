import { describe, expect, it } from "vitest";
import { buildSkillAdvice } from "./skill-advisor";
import type { SkillProgressEntity, SkillStat, SkillTree } from "./types";

function stat(id: number, name: string, increaseValue: number, unit = "%"): SkillStat {
  return {
    id,
    name,
    desc: `${name} +${increaseValue}${unit} per Upgrade.`,
    // The live curve: upgrades 2-4 cost two tree levels, 5-8 cost three.
    levelsPerPoint: [1, 1, 1, 2, 2, 2, 2, 3, 3, 3],
    unit,
    increaseKey: name,
    increaseValue,
  };
}

/**
 * The two fishing trees as /api/offchain/skills returns them on 2026-08-11:
 * identical stat NAMES, different rates, and XP curves that are not remotely
 * comparable — level 5 costs 161 in one and 8 in the other.
 */
function fishingTree(over: {
  docId: string;
  name: string;
  currency: number;
  maxLvl: number;
  xpPerLvl: number[];
  fintuitionRate: number;
}): SkillTree {
  // The live arrays run the full length of the tree. Padding matters: a short
  // array makes upgradeCost bail, which reads like a ladder decision but isn't.
  const xpPerLvl = [...over.xpPerLvl];
  while (xpPerLvl.length <= over.maxLvl) {
    xpPerLvl.push(xpPerLvl[xpPerLvl.length - 1] + 40);
  }
  return {
    docId: over.docId,
    name: over.name,
    LEVEL_CID: over.maxLvl,
    GAME_ITEM_ID_CID: over.currency,
    xpPerLvl,
    usesSkillPoints: false,
    stats: [
      { ...stat(0, "Stamana", 1, " Mana"), levelsPerPoint: [1, 2, 2, 2, 3, 3, 3, 3, 4, 4] },
      stat(1, "Rod Control", 2),
      stat(2, "Jebaitor", 2.25),
      stat(3, "Weed Dealer", 5),
      stat(4, "Taste", 2),
      stat(5, "Luck", 1.25),
      stat(6, "Fintuition", over.fintuitionRate),
      stat(7, "Dual Yielding", 2),
    ],
  };
}

const CLASSIC = fishingTree({
  docId: "3",
  name: "Fishing Skills",
  currency: 333,
  maxLvl: 100,
  xpPerLvl: [0, 10, 40, 90, 161, 258, 382, 537, 723, 942, 1197, 1490, 1822, 2194, 2608],
  fintuitionRate: 2.5,
});

const DENDREN = fishingTree({
  docId: "6",
  name: "Dendren Fishing",
  currency: 935,
  maxLvl: 80,
  xpPerLvl: [0, 2, 4, 6, 8, 11, 13, 16, 19, 22, 25, 28, 31, 48, 53],
  fintuitionRate: 1.5,
});

const noProgress: SkillProgressEntity[] = [];

describe("the two fishing trees get different advice", () => {
  it("pairs each tree to its pond by the currency it spends", () => {
    // Not by matching "dendren" in the name: the tree's GAME_ITEM_ID_CID is the
    // same number the pond's stall pays out, so both sides already agree.
    const advice = buildSkillAdvice([CLASSIC, DENDREN], noProgress, { "333": 99999, "935": 99999 }, 8);
    expect(advice.upgrades.some((u) => u.treeName === "Fishing Skills")).toBe(true);
    expect(advice.upgrades.some((u) => u.treeName === "Dendren Fishing")).toBe(true);
    // Neither tree is flagged as belonging to no pond.
    expect(advice.nextGoals.some((g) => /belongs to no pond/.test(g))).toBe(false);
  });

  it("leads with Fintuition on the classic pond and mana in the Grove", () => {
    // A dead hand still gets a swing on the classic board. In the Grove a
    // redraw costs a mana per card held, so mana is the way out of one.
    const advice = buildSkillAdvice([CLASSIC, DENDREN], noProgress, { "333": 99999, "935": 99999 }, 8);
    const first = (tree: string) => advice.upgrades.find((u) => u.treeName === tree)?.statName;
    expect(first("Fishing Skills")).toBe("Fintuition");
    expect(first("Dendren Fishing")).toBe("Stamana");
  });

  it("buys the same effect in both trees, not the same number of levels", () => {
    // "Fintuition to 5" means 12.5% at 2.5%/upgrade and 7.5% at 1.5% — the same
    // ladder step buying two different things. Targeting the effect instead
    // makes the trees comparable: ceil(12.5/2.5)=5 upgrades against
    // ceil(12.5/1.5)=9. Asserted through the stated reason, because the queued
    // count is also bounded by the per-tree upgrade cap.
    const classic = buildSkillAdvice([CLASSIC], noProgress, { "333": 99999 }, 8);
    const dend = buildSkillAdvice([DENDREN], noProgress, { "935": 99999 }, 8);
    const reason = (a: typeof classic) =>
      a.upgrades.find((u) => u.statName === "Fintuition")?.reason ?? "";
    expect(reason(classic)).toContain("5 upgrades buys ~12.5%");
    expect(reason(dend)).toContain("9 upgrades buys ~12.5%");
    // The classic tree leads with Fintuition, so it queues the full 5.
    expect(classic.upgrades.filter((u) => u.statName === "Fintuition")).toHaveLength(5);
  });

  it("quotes each tree's real rate in the reason", () => {
    const advice = buildSkillAdvice([CLASSIC, DENDREN], noProgress, { "333": 99999, "935": 99999 }, 8);
    const classicFint = advice.upgrades.find(
      (u) => u.treeName === "Fishing Skills" && u.statName === "Fintuition"
    );
    expect(classicFint?.reason).toContain("2.5%/upgrade");
  });

  it("charges each tree's own currency", () => {
    const advice = buildSkillAdvice([CLASSIC, DENDREN], noProgress, { "333": 99999, "935": 99999 }, 8);
    expect(advice.upgrades.find((u) => u.treeName === "Fishing Skills")?.currencyItemId).toBe(333);
    expect(advice.upgrades.find((u) => u.treeName === "Dendren Fishing")?.currencyItemId).toBe(935);
    // Two separate budgets, never one figure.
    expect(Object.keys(advice.totalCostByCurrency).sort()).toEqual(["333", "935"]);
  });

  it("flags a fishing tree whose currency belongs to no declared pond", () => {
    const orphan = fishingTree({
      docId: "7", name: "Mystery Fishing", currency: 4242,
      maxLvl: 80, xpPerLvl: [0, 2, 4, 6, 8], fintuitionRate: 2,
    });
    const advice = buildSkillAdvice([orphan], noProgress, { "4242": 100 }, 8);
    expect(advice.nextGoals.some((g) => /belongs to no pond/.test(g))).toBe(true);
  });
});

describe("an upgrade can cost more than one tree level", () => {
  const tree: SkillTree = {
    docId: "9",
    name: "Fishing Skills",
    LEVEL_CID: 100,
    GAME_ITEM_ID_CID: 333,
    xpPerLvl: [0, 10, 20, 30, 40, 50, 60, 70, 80],
    usesSkillPoints: false,
    stats: [
      { ...stat(0, "Stamana", 1, " Mana"), levelsPerPoint: [1, 2, 2] },
      { ...stat(6, "Fintuition", 100), levelsPerPoint: [1, 1, 1] },
    ],
  };

  it("prices an upgrade as the sum of the levels it consumes", () => {
    // levelsPerPoint climbs, so the second Stamana upgrade costs two levels at
    // xpPerLvl[2] + xpPerLvl[3]. Charging one level per upgrade under-priced
    // every ladder past the third step.
    const advice = buildSkillAdvice([tree], noProgress, { "333": 99999 }, 8);
    const stam = advice.upgrades.filter((u) => u.statName === "Stamana");
    // Fintuition at 100%/upgrade needs exactly one upgrade, taking level 1.
    expect(advice.upgrades[0].statName).toBe("Fintuition");
    expect(advice.upgrades[0].cost).toBe(10);
    expect(stam[0].cost).toBe(20);           // one level: xpPerLvl[2]
    expect(stam[1].cost).toBe(30 + 40);      // two levels: xpPerLvl[3] + [4]
    expect(stam[2].cost).toBe(50 + 60);      // two levels: xpPerLvl[5] + [6]
  });

  it("stops when the budget runs out and says what to save for", () => {
    const advice = buildSkillAdvice([tree], noProgress, { "333": 25 }, 8);
    expect(advice.upgrades).toHaveLength(1);
    expect(advice.nextGoals[0]).toContain("save 20");
  });
});
