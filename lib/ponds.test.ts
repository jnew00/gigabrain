import { describe, expect, it } from "vitest";
import {
  PONDS,
  UnknownCastNodeError,
  UnknownPondError,
  castNodeById,
  castsUsedByPond,
  castsUsedToday,
  findPond,
  findPondForNode,
  isPondOpen,
  openCastNodes,
  openPonds,
  pondById,
  pondCurrencyItemId,
  pondCurrencyLabel,
  pondEntryOptions,
  pondForCurrencyItem,
  pondForNode,
} from "./ponds";
import { AWAKENING } from "./game-data";

// Inside and outside the Awakening window, so event-gated ponds can be tested
// from both sides without waiting two months.
const DURING_EVENT = AWAKENING.startTimestamp + 60;
const AFTER_EVENT = AWAKENING.endTimestamp + 60;

describe("pond lookups fail loudly", () => {
  it("throws rather than defaulting an unknown pond to pond 1", () => {
    expect(() => pondById(3)).toThrow(UnknownPondError);
    expect(() => pondById(undefined)).toThrow(UnknownPondError);
    expect(() => pondCurrencyItemId(99)).toThrow(UnknownPondError);
  });

  it("throws rather than assigning an unknown cast node to a pond", () => {
    expect(() => pondForNode("9")).toThrow(UnknownCastNodeError);
    expect(() => pondForNode(undefined)).toThrow(UnknownCastNodeError);
    expect(() => castNodeById("nope")).toThrow(UnknownCastNodeError);
  });

  it("names an unknown pond's currency instead of calling it Seaweed", () => {
    // A render pass must not crash, but it must not lie either.
    expect(pondCurrencyLabel(3)).not.toMatch(/seaweed/i);
    expect(pondCurrencyLabel(3)).toContain("3");
    expect(pondCurrencyLabel(undefined)).not.toMatch(/seaweed/i);
  });

  it("resolves the declared ponds", () => {
    expect(pondById(1).currencyLabel).toBe("Seaweed");
    expect(pondById(2).currencyLabel).toBe("Infused Sediment");
    expect(findPond(3)).toBeUndefined();
    expect(findPondForNode("5")?.pondId).toBe(2);
    expect(pondForNode("0").pondId).toBe(1);
    expect(castNodeById("5").cost).toBe(12);
  });

  it("keeps the two fishing currencies distinct", () => {
    // 333 feeds Fishing Skills, 935 feeds Dendren Fishing. Summing them was the
    // original bug; sharing an id would let it back in.
    expect(pondCurrencyItemId(1)).toBe(333);
    expect(pondCurrencyItemId(2)).toBe(935);
    expect(pondForCurrencyItem(333)?.pondId).toBe(1);
    expect(pondForCurrencyItem(935)?.pondId).toBe(2);
    expect(pondForCurrencyItem(846)).toBeUndefined();
  });

  it("gives every pond a unique id and every node a unique owner", () => {
    const ids = PONDS.map((p) => p.pondId);
    expect(new Set(ids).size).toBe(ids.length);
    const nodes = PONDS.flatMap((p) => p.nodes.map((n) => n.nodeId));
    expect(new Set(nodes).size).toBe(nodes.length);
  });
});

describe("event ponds close on their own date", () => {
  it("offers the Grove during the event and not after", () => {
    expect(openPonds(DURING_EVENT).map((p) => p.pondId)).toEqual([1, 2]);
    expect(openPonds(AFTER_EVENT).map((p) => p.pondId)).toEqual([1]);
    expect(isPondOpen(pondById(2), AFTER_EVENT)).toBe(false);
    expect(isPondOpen(pondById(1), AFTER_EVENT)).toBe(true);
  });

  it("drops the Grove node from the cast list once the window closes", () => {
    expect(openCastNodes(DURING_EVENT).map((n) => n.nodeId)).toContain("5");
    expect(openCastNodes(AFTER_EVENT).map((n) => n.nodeId)).not.toContain("5");
    expect(openCastNodes(AFTER_EVENT)).toHaveLength(3);
  });
});

describe("the daily cast pool is shared across ponds", () => {
  // Shape verified against /api/fishing/state on 2026-08-11.
  const state = {
    dayDoc: { UINT256_CID: 1 },
    dayDocs: [
      { pondId: 1, doc: { UINT256_CID: 1 } },
      { pondId: 2, doc: { UINT256_CID: 19 } },
    ],
  };

  it("sums every pond's counter, not just the first", () => {
    // Reading dayDoc alone reported 1 while the server had counted 20, so the
    // plan believed a full allowance remained and every start_run was refused.
    expect(castsUsedToday(state)).toBe(20);
    expect(state.dayDoc.UINT256_CID).toBe(1);
  });

  it("reports the per-pond split", () => {
    const byPond = castsUsedByPond(state);
    expect(byPond.get(1)).toBe(1);
    expect(byPond.get(2)).toBe(19);
  });

  it("falls back to the singular doc as pond 1 for pre-Grove responses", () => {
    expect(castsUsedToday({ dayDoc: { UINT256_CID: 4 } })).toBe(4);
    expect(castsUsedByPond({ dayDoc: { UINT256_CID: 4 } }).get(1)).toBe(4);
  });

  it("treats missing state as no casts spent", () => {
    expect(castsUsedToday(null)).toBe(0);
    expect(castsUsedToday(undefined)).toBe(0);
    expect(castsUsedToday({})).toBe(0);
  });
});

describe("pond entry offerings", () => {
  // Verified shape from pondEntryTiers on 2026-08-11: three Grove tiers with
  // dropMultiplier 1, 2 and 4; tiers 2 and 3 each want one faction ring.
  const tiers = [
    { name: "t1", tier: 1, pondId: 2, inputItems: [], inputAmounts: [], inputsBasedOnFactionDay: false, dropMultiplier: 1, startDay: 20675, endDay: 20735 },
    { name: "t2", tier: 2, pondId: 2, inputItems: [137, 138], inputAmounts: [1, 1], inputsBasedOnFactionDay: true, dropMultiplier: 2, startDay: 20675, endDay: 20735 },
    { name: "t3", tier: 3, pondId: 2, inputItems: [243, 246], inputAmounts: [1, 1], inputsBasedOnFactionDay: true, dropMultiplier: 4, startDay: 20675, endDay: 20735 },
  ];

  it("returns tier 0 for a pond with no offering system", () => {
    const { free, payable } = pondEntryOptions(tiers, 1, {});
    expect(free?.tier).toBe(0);
    expect(payable).toBeNull();
  });

  it("offers the free tier when no ring is held", () => {
    const { free, payable } = pondEntryOptions(tiers, 2, {});
    expect(free?.tier).toBe(1);
    expect(free?.dropMultiplier).toBe(1);
    expect(payable).toBeNull();
  });

  it("reports no free tier at all rather than dressing a paid one up as free", () => {
    // A pond where every tier wants an item has no free entry. Falling back to
    // the lowest-numbered tier would hand the caller a paid tier labelled
    // "free" and spend a faction ring on every cast with nobody opting in.
    const allPaid = tiers.filter((t) => t.inputItems.length > 0);
    const { free, payable } = pondEntryOptions(allPaid, 2, { "243": 1 });
    expect(free).toBeNull();
    expect(payable?.tier).toBe(3);
  });

  it("reports the best payable tier by payout, not by tier number", () => {
    const { payable } = pondEntryOptions(tiers, 2, { "138": 1, "243": 1 });
    expect(payable?.tier).toBe(3);
    expect(payable?.dropMultiplier).toBe(4);
  });

  it("keeps the free tier separate so rings are never spent implicitly", () => {
    // Holding a ring must not change what a caller that didn't opt in sends.
    const { free } = pondEntryOptions(tiers, 2, { "243": 1 });
    expect(free?.tier).toBe(1);
    expect(free?.costsItems).toEqual([]);
  });

  it("ignores a tier the player cannot fully pay for", () => {
    const { payable } = pondEntryOptions(tiers, 2, { "137": 0 });
    expect(payable).toBeNull();
  });

  it("ignores tiers outside their day window", () => {
    expect(pondEntryOptions(tiers, 2, { "243": 1 }, 20800).payable).toBeNull();
    expect(pondEntryOptions(tiers, 2, { "243": 1 }, 20676).payable?.tier).toBe(3);
  });
});
