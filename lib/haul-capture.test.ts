import { describe, expect, it, beforeEach } from "vitest";
import {
  beginHaulCapture,
  endHaulCapture,
  peekHaulCapture,
  recordHaul,
} from "./use-gigaverse";

describe("the run haul accumulates every item delta", () => {
  beforeEach(() => {
    endHaulCapture(); // clear anything a previous test left open
    beginHaulCapture();
  });

  it("folds the balance changes off a response", () => {
    recordHaul({ gameItemBalanceChanges: [{ id: 845, amount: 48 }] });
    expect(peekHaulCapture()).toEqual([{ id: 845, amount: 48 }]);
  });

  it("sums repeated drops of the same item", () => {
    recordHaul({ gameItemBalanceChanges: [{ id: 845, amount: 48 }] });
    recordHaul({ gameItemBalanceChanges: [{ id: 845, amount: 22 }] });
    expect(peekHaulCapture()).toEqual([{ id: 845, amount: 70 }]);
  });

  // Pots and chests go through /api/offchain/recipes/start, which does not
  // itemise loot. useRecipe derives it from a balance diff AFTER proxy() has
  // returned, so unless that diff is handed back to the capture explicitly the
  // haul pane misses it — "Tan Pot broken — 3x Wood, 1x Stone" appeared in the
  // activity log and nowhere else.
  it("takes a derived delta, which is how pot and chest loot arrives", () => {
    recordHaul({ gameItemBalanceChanges: [{ id: 212, amount: 3 }, { id: 216, amount: 1 }] });
    expect(peekHaulCapture()).toEqual([
      { id: 212, amount: 3 },
      { id: 216, amount: 1 },
    ]);
  });

  // A merchant trade spends items to gain them, and it routes through the same
  // derived path. Counting only the gains would make the haul an advert.
  it("keeps losses, so a trade nets out", () => {
    recordHaul({ gameItemBalanceChanges: [{ id: 212, amount: 5 }, { id: 400, amount: -10 }] });
    expect(peekHaulCapture()).toEqual([
      { id: 212, amount: 5 },
      { id: 400, amount: -10 },
    ]);
  });

  it("drops an item that nets back to zero", () => {
    recordHaul({ gameItemBalanceChanges: [{ id: 400, amount: 10 }] });
    recordHaul({ gameItemBalanceChanges: [{ id: 400, amount: -10 }] });
    expect(peekHaulCapture()).toEqual([]);
  });

  it("ignores responses that carry no changes", () => {
    recordHaul({ entities: [] });
    recordHaul(null);
    recordHaul({ gameItemBalanceChanges: "nope" });
    expect(peekHaulCapture()).toEqual([]);
  });

  it("skips malformed entries rather than recording NaN", () => {
    recordHaul({ gameItemBalanceChanges: [{ id: "845", amount: 3 }, { id: 846, amount: 5 }] });
    expect(peekHaulCapture()).toEqual([{ id: 846, amount: 5 }]);
  });

  // Reading must not disturb: an early end would hand the run summary an empty
  // haul and lose everything collected after the peek.
  it("peeks without closing the capture", () => {
    recordHaul({ gameItemBalanceChanges: [{ id: 845, amount: 10 }] });
    expect(peekHaulCapture()).toHaveLength(1);
    recordHaul({ gameItemBalanceChanges: [{ id: 845, amount: 5 }] });
    expect(endHaulCapture()).toEqual([{ id: 845, amount: 15 }]);
  });

  it("records nothing once the capture is closed", () => {
    endHaulCapture();
    recordHaul({ gameItemBalanceChanges: [{ id: 845, amount: 10 }] });
    expect(peekHaulCapture()).toEqual([]);
  });
});
