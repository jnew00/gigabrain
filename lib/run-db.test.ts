import { describe, expect, it } from "vitest";
import { getDungeonPerformance, getPondYields } from "./run-db";

/**
 * These run without DATABASE_URL, which is the configuration most checkouts are
 * in. Both queries must degrade to "no data" rather than throwing, because the
 * advisor calls them on every render and treats an empty result as "unmeasured".
 */
describe("yield queries with no database configured", () => {
  it("return empty rather than throwing", async () => {
    // If DATABASE_URL is set locally this test is not meaningful, so skip.
    if (process.env.DATABASE_URL) return;
    await expect(getPondYields("0xabc", 845)).resolves.toEqual([]);
    await expect(getDungeonPerformance("0xabc", 845)).resolves.toEqual([]);
  });
});

/**
 * The averaging rule, checked directly.
 *
 * `avg_item_amount` has to be per attempt, not per successful attempt. An
 * escaped fish earns no Cores and that is a real outcome of spending the
 * energy, not a gap in the data — averaging only over casts that paid out
 * reads high by exactly the escape rate, and the advisor would over-fund the
 * pond on the strength of it. This mirrors the accumulation in getPondYields.
 */
describe("cast yield averaging", () => {
  const casts = [
    { items: [{ id: 845, amount: 12 }], multiplier: 1 },
    { items: [], multiplier: 1 },                         // escaped, earned nothing
    { items: [{ id: 845, amount: 12 }], multiplier: 1 },
    { items: [], multiplier: 1 },                         // escaped, earned nothing
  ];

  const averageOverAll = (rows: typeof casts) =>
    rows.reduce(
      (s, r) => s + (r.items.find((i) => i.id === 845)?.amount ?? 0) / r.multiplier, 0
    ) / rows.length;

  it("counts casts that paid nothing", () => {
    // 24 Cores over 4 casts, not over the 2 that landed.
    expect(averageOverAll(casts)).toBe(6);
    expect(averageOverAll(casts)).not.toBe(12);
  });

  it("normalises a paid offering back to a tier-1 cast", () => {
    // A 4x offering ring quadruples the Cores. Averaging that in raw would
    // make the pond look four times as productive as the next free cast.
    const boosted = [{ items: [{ id: 845, amount: 48 }], multiplier: 4 }];
    expect(averageOverAll(boosted)).toBe(12);
  });
});
