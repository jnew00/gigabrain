import { describe, expect, it } from "vitest";
import {
  cellToCoord,
  coordToCell,
  focusZone,
  inferGrid,
  pickGroveMove,
  predictGroveCoords,
  resolveGrid,
  scoreGroveHand,
} from "./fishing-ai";
import type { FishingCard } from "./types";

function card(over: Partial<FishingCard> = {}): FishingCard {
  return {
    id: 1,
    name: "test",
    manaCost: 1,
    hitZones: [5],
    critZones: [],
    hitEffects: [{ type: "dmg", amount: 10 }],
    missEffects: [],
    critEffects: [],
    rarity: 0,
    isDayCard: false,
    earnable: true,
    ...over,
  } as FishingCard;
}

describe("the board comes from the server, not from the deck", () => {
  it("trusts gridSize over anything inferred", () => {
    // The Grove reports gridSize 4 while its starting deck only reaches zone 9.
    // Inferring from the deck reads a 4x4 pond as 3x3 and mistargets every card.
    const grid = resolveGrid({ gridSize: 4, deckCardData: [card({ hitZones: [1, 9] })] });
    expect(grid).toEqual({ cols: 4, rows: 4 });
  });

  it("falls back to inference only when gridSize is absent", () => {
    expect(resolveGrid({ deckCardData: [card({ hitZones: [9] })] })).toEqual({ cols: 3, rows: 3 });
    expect(inferGrid([card({ hitZones: [16] })])).toEqual({ cols: 4, rows: 4 });
  });
});

describe("coordinates are [row, col], 1-based", () => {
  it("maps row-major on a 3x3", () => {
    // A fish at [2,3] renders in column 3 of row 2 — cell 6, not the transpose.
    expect(coordToCell([2, 3], { cols: 3, rows: 3 })).toBe(6);
    expect(coordToCell([1, 1], { cols: 3, rows: 3 })).toBe(1);
    expect(coordToCell([3, 3], { cols: 3, rows: 3 })).toBe(9);
  });

  it("maps row-major on a 4x4 too", () => {
    expect(coordToCell([2, 3], { cols: 4, rows: 4 })).toBe(7);
    expect(coordToCell([4, 4], { cols: 4, rows: 4 })).toBe(16);
  });

  it("round-trips through cellToCoord on both board sizes", () => {
    for (const grid of [{ cols: 3, rows: 3 }, { cols: 4, rows: 4 }]) {
      for (let cell = 1; cell <= grid.cols * grid.rows; cell++) {
        expect(coordToCell(cellToCoord(cell, grid), grid)).toBe(cell);
      }
    }
  });
});

describe("Grove cards are lure-anchored stamps", () => {
  it("puts the lure itself at zone 5", () => {
    expect(focusZone([2, 2], [2, 2])).toBe(5);
  });

  it("maps the eight neighbours around the lure", () => {
    expect(focusZone([1, 1], [2, 2])).toBe(1);
    expect(focusZone([1, 2], [2, 2])).toBe(2);
    expect(focusZone([3, 3], [2, 2])).toBe(9);
  });

  it("reports anything further than one cell as unreachable", () => {
    // Not "zone 0" or a clamped edge — out of reach is a different answer from
    // a zone, and scoring a card against a clamped zone invents hits.
    expect(focusZone([4, 2], [2, 2])).toBeNull();
    expect(focusZone([2, 4], [2, 2])).toBeNull();
  });
});

describe("Grove fish movement", () => {
  it("spreads evenly over orthogonal neighbours and never reverses", () => {
    const preds = predictGroveCoords([2, 2], [1, 2], 4);
    const coords = preds.map((p) => p.coord.join(","));
    expect(coords).not.toContain("1,2"); // the cell it came from
    expect(coords.sort()).toEqual(["2,1", "2,3", "3,2"]);
    for (const p of preds) expect(p.p).toBeCloseTo(1 / 3);
  });

  it("stays on the board at a corner", () => {
    const preds = predictGroveCoords([1, 1], undefined, 4);
    expect(preds.map((p) => p.coord.join(",")).sort()).toEqual(["1,2", "2,1"]);
  });

  it("uses the board it was given, not a fixed 4x4", () => {
    const onThree = predictGroveCoords([3, 3], undefined, 3);
    expect(onThree.map((p) => p.coord.join(",")).sort()).toEqual(["2,3", "3,2"]);
  });

  it("states the answer outright when Fintuition fires", () => {
    const preds = predictGroveCoords([2, 2], [1, 2], 4, [4, 4]);
    expect(preds).toEqual([{ coord: [4, 4], p: 1 }]);
  });
});

describe("pickGroveMove refuses to guess the board", () => {
  const base = {
    hand: [1],
    deckCardData: [card()],
    fishPosition: [2, 2],
    previousFishPosition: [1, 2],
    playerHp: 5,
    focusMeter: 3,
  };

  it("returns null with no gridSize rather than assuming 4", () => {
    // A silent default of 4 is the Grove's size and nothing else's; on another
    // lure pond it would score every card against the wrong board and still
    // return a confident answer.
    expect(pickGroveMove({ ...base, focusPoint: [2, 2] })).toBeNull();
  });

  it("returns null with no focusPoint rather than assuming the centre", () => {
    // [2,2] is the centre of a 3x3 and off-centre on a 4x4.
    expect(pickGroveMove({ ...base, gridSize: 4 })).toBeNull();
  });

  it("plays when the board and lure are both stated", () => {
    const move = pickGroveMove({ ...base, gridSize: 4, focusPoint: [2, 2] });
    expect(move).not.toBeNull();
    expect(move!.handIndex).toBe(0);
  });

  it("agrees with the hand scorer the UI shows", () => {
    // The "BEST" badge and the bot must name the same card. They disagreed
    // while the badge scored Grove cards as board addresses.
    const gd = {
      ...base,
      gridSize: 4,
      focusPoint: [2, 2],
      hand: [1, 2],
      deckCardData: [
        card({ id: 1, hitZones: [1] }),
        card({ id: 2, hitZones: [2, 4, 6, 8], hitEffects: [{ type: "dmg", amount: 30 }] }),
      ],
    };
    const move = pickGroveMove(gd)!;
    const scores = scoreGroveHand(gd);
    const best = scores.reduce((a, b) => (b.ev > a.ev ? b : a));
    expect(move.handIndex).toBe(best.handIndex);
    expect(move.ev).toBeCloseTo(best.ev);
  });

  it("scores an unaffordable card as unplayable rather than as a bad card", () => {
    const scores = scoreGroveHand({
      ...base,
      gridSize: 4,
      focusPoint: [2, 2],
      playerHp: 1,
      hand: [1],
      deckCardData: [card({ id: 1, manaCost: 5 })],
    });
    expect(scores[0].playable).toBe(false);
    expect(scores[0].reason).toContain("mana");
  });

  it("returns nothing at all without a board or a lure", () => {
    expect(scoreGroveHand({ ...base, focusPoint: [2, 2] })).toEqual([]);
    expect(scoreGroveHand({ ...base, gridSize: 4 })).toEqual([]);
  });

  it("prefers the cheaper lure move when two options score the same", () => {
    // Focus is a budget for the whole cast, and the fish moves every turn.
    const move = pickGroveMove({
      ...base,
      gridSize: 4,
      focusPoint: [2, 2],
      deckCardData: [card({ hitZones: [1, 2, 3, 4, 5, 6, 7, 8, 9] })],
    });
    expect(move!.focusCost).toBe(0);
  });
});
