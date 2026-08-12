import { describe, expect, it, vi } from "vitest";
import {
  nodeIdForGame,
  pendingCatchCards,
  normalizeActionResponse,
  normalizeCaughtFish,
  normalizeExchangeRates,
  normalizeFishingState,
} from "./fishing-state";
import type { FishingCard, WireFishingGameState } from "./types";

describe("the wire's seaweedEarned is renamed at the boundary", () => {
  it("becomes currencyEarned and the old name does not survive", () => {
    const fish = normalizeCaughtFish({
      gameItemId: 933,
      name: "Glimmerfin",
      rarity: 3,
      quality: 2,
      size: "Large",
      sizes: { weight: 4, length: 2, girth: 1 },
      seaweedEarned: 120,
    });
    expect(fish?.currencyEarned).toBe(120);
    // The point of the rename: nothing downstream can read a field called
    // "seaweed" off a Grove catch and believe it earned seaweed.
    expect("seaweedEarned" in (fish as object)).toBe(false);
  });

  it("passes undefined through", () => {
    expect(normalizeCaughtFish(undefined)).toBeUndefined();
  });
});

describe("exchange rates must name their pond", () => {
  it("keeps rows that have a pondId", () => {
    const rates = normalizeExchangeRates([
      { id: 290, tier: 2, baseVal: 100, value: 75, pondId: 1 },
      { id: 533, tier: 3, baseVal: 250, value: 250, pondId: 2 },
    ]);
    expect(rates).toHaveLength(2);
    expect(rates![1].pondId).toBe(2);
  });

  it("drops a row with no pondId and reports it, rather than calling it pond 1", () => {
    // /api/fishing/sell fails without pondId, and guessing sends the fish to
    // the wrong stall for the wrong currency. Losing the row loudly is better.
    const onDropped = vi.fn();
    const rates = normalizeExchangeRates(
      [
        { id: 1, tier: 1, baseVal: 10, value: 12, pondId: 1 },
        { id: 2, tier: 1, baseVal: 10, value: 12 },
      ],
      onDropped
    );
    expect(rates).toHaveLength(1);
    expect(onDropped).toHaveBeenCalledOnce();
    expect(onDropped.mock.calls[0][0]).toEqual([{ id: 2, tier: 1, baseVal: 10, value: 12 }]);
  });
});

describe("a game states its own cast node", () => {
  it("reads ID_CID", () => {
    // Confirmed live on 2026-08-11: a Grove game reports ID_CID "5".
    expect(nodeIdForGame({ ID_CID: "5" })).toBe("5");
    expect(nodeIdForGame({ ID_CID: "0" })).toBe("0");
  });

  it("reports nothing rather than a default when the field is missing", () => {
    expect(nodeIdForGame({})).toBeUndefined();
    expect(nodeIdForGame(null)).toBeUndefined();
    expect(nodeIdForGame({ ID_CID: "" })).toBeUndefined();
  });
});

describe("whole-response normalisation", () => {
  const wire = {
    gameState: {
      docId: "12855151",
      COMPLETE_CID: true,
      SUCCESS_CID: true,
      LEVEL_CID: 0,
      ID_CID: "5",
      MULTIPLIER_CID: 1,
      data: {
        deckCardData: [],
        playerMaxHp: 5,
        playerHp: 3,
        fishHp: 0,
        fishMaxHp: 40,
        fishPosition: [2, 2],
        previousFishPosition: [1, 2],
        gridSize: 4,
        hand: [],
        discard: [],
        fullDeck: [],
        nextCardIndex: 0,
        cardInDrawPile: 0,
        nextPosition: null,
        caughtFish: {
          gameItemId: 933,
          name: "Glimmerfin",
          rarity: 3,
          quality: 2,
          size: "Large",
          sizes: { weight: 4, length: 2, girth: 1 },
          seaweedEarned: 120,
        },
      },
    },
    dayDoc: { UINT256_CID: 0 },
    dayDocs: [{ pondId: 2, doc: { UINT256_CID: 9 } }],
    maxPerDay: 10,
    maxPerDayJuiced: 20,
    node0Energy: 12,
    node1Energy: 16,
    node2Energy: 20,
    exchangeRates: [{ id: 533, tier: 3, baseVal: 250, value: 250, pondId: 2 }],
  } as unknown as WireFishingGameState;

  it("renames the catch and keeps the node and multiplier", () => {
    const state = normalizeFishingState(wire);
    expect(state.gameState.data.caughtFish?.currencyEarned).toBe(120);
    expect(state.gameState.ID_CID).toBe("5");
    expect(state.gameState.MULTIPLIER_CID).toBe(1);
    expect(state.exchangeRates?.[0].pondId).toBe(2);
  });

  it("normalises an action response's doc the same way", () => {
    const res = normalizeActionResponse({
      success: true,
      data: { doc: wire.gameState },
      gameItemBalanceChanges: [{ id: 845, amount: 12 }],
    });
    expect(res.data.doc.data.caughtFish?.currencyEarned).toBe(120);
    expect(res.gameItemBalanceChanges?.[0]).toEqual({ id: 845, amount: 12 });
  });
});

describe("a catch already collected is not a catch still owed", () => {
  const cards = [{ id: 38 }, { id: 49 }, { id: 9 }] as FishingCard[];
  const game = (
    over: Record<string, unknown> = {},
    data: Record<string, unknown> = {}
  ) => ({
    COMPLETE_CID: true,
    SUCCESS_CID: true,
    ...over,
    data: { cardsToAdd: cards, ...data },
  });

  it("offers the cards while none has been taken", () => {
    expect(pendingCatchCards(game())?.map((c) => c.id)).toEqual([38, 49, 9]);
    expect(pendingCatchCards(game({}, { cardChosenId: null }))).not.toBeNull();
    expect(pendingCatchCards(game({}, { cardChosenId: 0 }))).not.toBeNull();
  });

  it("owes nothing once a spell has been taken", () => {
    // The live case: a Grove catch collected in the game client kept all three
    // cards on the document, so every loot the runner sent was answered
    // "Card already chosen" — twenty casts that never started.
    expect(pendingCatchCards(game({}, { cardChosenId: 38 }))).toBeNull();
  });

  it("owes nothing on a game that is unfinished, lost, or absent", () => {
    expect(pendingCatchCards(game({ COMPLETE_CID: false }))).toBeNull();
    expect(pendingCatchCards(game({ SUCCESS_CID: false }))).toBeNull();
    expect(pendingCatchCards(null)).toBeNull();
    expect(pendingCatchCards(undefined)).toBeNull();
  });

  it("owes nothing when the game carries no cards at all", () => {
    expect(pendingCatchCards({ COMPLETE_CID: true, SUCCESS_CID: true, data: {} })).toBeNull();
    expect(pendingCatchCards({ COMPLETE_CID: true, SUCCESS_CID: true })).toBeNull();
  });
});
