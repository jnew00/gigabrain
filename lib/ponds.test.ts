import { describe, expect, it } from "vitest";
import {
  PONDS,
  UnknownCastNodeError,
  UnknownPondError,
  castNodeById,
  castsUsedByPond,
  castsUsedToday,
  castAllowance,
  clampRestoredCasts,
  findPond,
  findPondForNode,
  isDailyCapError,
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

describe("an unknown cast allowance is not a full one", () => {
  const CAPS = { maxCastsPerDay: 10, juicedMaxCastsPerDay: 20 };
  // Real counters from /api/fishing/state on 2026-08-15: the Grove's twenty
  // casts spent, the classic pond untouched.
  const spent = {
    maxPerDay: 10,
    maxPerDayJuiced: 20,
    dayDocs: [
      { pondId: 1, doc: { UINT256_CID: 0 } },
      { pondId: 2, doc: { UINT256_CID: 20 } },
    ],
  };

  // The bug this function exists for. Nothing fetches the fishing state on the
  // way into the app, so `null` is the state callers routinely hold, and the
  // arithmetic on it — cap minus zero-counters-seen — handed back a confident
  // full allowance. The plan then showed twenty Grove casts the server had been
  // refusing since the first one.
  it("reports 0 left and known=false when the state has not loaded", () => {
    for (const missing of [null, undefined]) {
      const a = castAllowance(missing, true, CAPS);
      expect(a.known).toBe(false);
      expect(a.left).toBe(0);
      expect(a.used).toBe(0);
    }
  });

  it("still reports the cap while unknown, so the UI can say which cap applies", () => {
    expect(castAllowance(null, true, CAPS).max).toBe(20);
    expect(castAllowance(null, false, CAPS).max).toBe(10);
  });

  it("subtracts every pond's casts once the state is in", () => {
    const a = castAllowance(spent, true, CAPS);
    expect(a.known).toBe(true);
    expect(a.used).toBe(20);
    expect(a.left).toBe(0);
  });

  it("counts a state with counters but no casts spent as a full allowance", () => {
    const a = castAllowance({ ...spent, dayDocs: [] }, true, CAPS);
    expect(a.known).toBe(true);
    expect(a.left).toBe(20);
  });

  it("uses the juiced cap only when juiced", () => {
    const fresh = { ...spent, dayDocs: [{ pondId: 1, doc: { UINT256_CID: 3 } }] };
    expect(castAllowance(fresh, true, CAPS).left).toBe(17);
    expect(castAllowance(fresh, false, CAPS).left).toBe(7);
  });

  it("prefers the server's caps over the fallback constants", () => {
    const generous = { maxPerDay: 12, maxPerDayJuiced: 24, dayDocs: [] };
    expect(castAllowance(generous, true, CAPS).max).toBe(24);
    expect(castAllowance(generous, false, CAPS).max).toBe(12);
  });

  it("never reports a negative allowance when the counters exceed the cap", () => {
    const over = { ...spent, dayDocs: [{ pondId: 2, doc: { UINT256_CID: 25 } }] };
    expect(castAllowance(over, true, CAPS).left).toBe(0);
  });

  // The two readings the app actually makes have to agree: the planner's
  // number and the executor's recount are the same call on different states,
  // and they disagreeing is precisely what put an impossible plan on screen.
  it("feeds clampRestoredCasts a budget that zeroes a spent day", () => {
    const saved = [{ casts: 20, castCost: 12 }];
    const left = castAllowance(spent, true, CAPS).left;
    expect(clampRestoredCasts(saved, { energy: 10_000, castsLeftToday: left })).toEqual([]);
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

describe("telling a spent allowance apart from a transient failure", () => {
  it("recognises the server's own cap refusal", () => {
    // Verbatim from a run that burned all 18 planned casts on this message.
    expect(isDailyCapError("Player has reached max runs for fishing")).toBe(true);
  });

  it("recognises the other phrasings the server uses for a spent allowance", () => {
    expect(isDailyCapError("Daily limit reached")).toBe(true);
    expect(isDailyCapError("no runs left today")).toBe(true);
    expect(isDailyCapError("max casts reached")).toBe(true);
  });

  it("does not stop the run for a failure that a retry could clear", () => {
    // These have to stay retryable: treating them as terminal would abandon
    // the day's remaining casts over one stale token.
    expect(isDailyCapError("Invalid action token")).toBe(false);
    expect(isDailyCapError("Not enough energy")).toBe(false);
    expect(isDailyCapError("fetch failed")).toBe(false);
  });

  it("treats a missing message as retryable rather than terminal", () => {
    expect(isDailyCapError(null)).toBe(false);
    expect(isDailyCapError(undefined)).toBe(false);
    expect(isDailyCapError("")).toBe(false);
  });
});

describe("a restored plan is clamped by the day, not just by energy", () => {
  it("drops casts that were already spent since the plan was saved", () => {
    // The failure from the log: 18 Grove casts saved from an earlier run that
    // day, still affordable, and every one already spent. Clamping on energy
    // alone restored all 18 and the server refused all 18.
    const restored = clampRestoredCasts([{ casts: 18, castCost: 12 }], {
      energy: 500,
      castsLeftToday: 0,
    });
    expect(restored).toHaveLength(0);
  });

  it("restores the part of the plan the day can still pay for", () => {
    const restored = clampRestoredCasts([{ casts: 18, castCost: 12 }], {
      energy: 500,
      castsLeftToday: 5,
    });
    expect(restored[0].casts).toBe(5);
  });

  it("still clamps by energy when the allowance is untouched", () => {
    const restored = clampRestoredCasts([{ casts: 18, castCost: 12 }], {
      energy: 36,
      castsLeftToday: 20,
    });
    expect(restored[0].casts).toBe(3);
  });

  it("spends the allowance as one pool across ponds", () => {
    // Not four casts each: the daily cap is shared, so the first entry takes
    // what it needs and the second gets the remainder.
    const restored = clampRestoredCasts(
      [
        { casts: 4, castCost: 10 },
        { casts: 4, castCost: 10 },
      ],
      { energy: 1000, castsLeftToday: 6 }
    );
    expect(restored.map((r) => r.casts)).toEqual([4, 2]);
  });

  it("returns nothing rather than negatives when both budgets are gone", () => {
    expect(
      clampRestoredCasts([{ casts: 9, castCost: 10 }], { energy: 0, castsLeftToday: -3 })
    ).toEqual([]);
  });

  it("preserves the other fields on each entry", () => {
    const restored = clampRestoredCasts(
      [{ casts: 5, castCost: 10, castNodeId: "5", pondId: 2 }],
      { energy: 1000, castsLeftToday: 2 }
    );
    expect(restored[0]).toMatchObject({ castNodeId: "5", pondId: 2, casts: 2 });
  });
});
