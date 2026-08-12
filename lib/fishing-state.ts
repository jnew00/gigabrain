// The boundary between what the fishing API sends and what the app works with.
//
// Two things get fixed here and nowhere else:
//
//   1. `caughtFish.seaweedEarned` is renamed to `currencyEarned`. The field
//      name predates the Grove and is now actively misleading — a Grove catch
//      reports Infused Sediment through it. Renaming at the edge means no UI or
//      accounting code can read a field called "seaweed" and believe it.
//
//   2. `exchangeRates` rows are checked for `pondId`. The pond decides which
//      stall buys the fish, and /api/fishing/sell rejects a call without it. A
//      row that somehow arrives without one is dropped and reported rather than
//      attributed to pond 1, which would sell a third pond's fish to the wrong
//      stall for the wrong currency.

import type {
  FishExchangeRate,
  FishingActionResponse,
  FishingCard,
  FishingGameDoc,
  FishingGameData,
  FishingGameState,
  WireFishExchangeRate,
  WireFishingActionResponse,
  WireFishingGameDoc,
  WireFishingGameData,
  WireFishingGameState,
} from "./types";

export function normalizeCaughtFish(
  wire: WireFishingGameData["caughtFish"]
): FishingGameData["caughtFish"] {
  if (!wire) return undefined;
  const { seaweedEarned, ...rest } = wire;
  return { ...rest, currencyEarned: seaweedEarned ?? 0 };
}

export function normalizeGameData(wire: WireFishingGameData): FishingGameData {
  return { ...wire, caughtFish: normalizeCaughtFish(wire.caughtFish) };
}

export function normalizeGameDoc(wire: WireFishingGameDoc): FishingGameDoc {
  // `data` is absent on a freshly created doc the server has not filled in yet.
  return {
    ...wire,
    data: wire.data ? normalizeGameData(wire.data) : (wire.data as unknown as FishingGameData),
  };
}

/**
 * Keep only rates that name their pond.
 *
 * `onDropped` exists so a dropped row is loud somewhere rather than a fish that
 * quietly stops being sellable.
 */
export function normalizeExchangeRates(
  wire: WireFishExchangeRate[] | undefined,
  onDropped?: (dropped: WireFishExchangeRate[]) => void
): FishExchangeRate[] | undefined {
  if (!wire) return undefined;
  const kept: FishExchangeRate[] = [];
  const dropped: WireFishExchangeRate[] = [];
  for (const r of wire) {
    if (typeof r.pondId === "number") kept.push(r as FishExchangeRate);
    else dropped.push(r);
  }
  if (dropped.length && onDropped) onDropped(dropped);
  return kept;
}

export function normalizeFishingState(
  wire: WireFishingGameState,
  onDropped?: (dropped: WireFishExchangeRate[]) => void
): FishingGameState {
  return {
    ...wire,
    gameState: wire.gameState
      ? normalizeGameDoc(wire.gameState)
      : (wire.gameState as unknown as FishingGameDoc),
    exchangeRates: normalizeExchangeRates(wire.exchangeRates, onDropped),
  };
}

export function normalizeActionResponse(
  wire: WireFishingActionResponse
): FishingActionResponse {
  return {
    ...wire,
    data: {
      ...wire.data,
      doc: wire.data?.doc
        ? normalizeGameDoc(wire.data.doc)
        : (wire.data?.doc as unknown as FishingGameDoc),
    },
  };
}

/* ─── Reading the pond off a game ──────────────────────────── */

/**
 * Which cast node a game is being played on.
 *
 * `gameState.ID_CID` carries it — confirmed on 2026-08-11, where a Grove game
 * reported "5". Everything that needs the pond of an in-flight or just-finished
 * cast should go through here rather than testing `focusMechanicEnabled`, which
 * describes a mechanic and not a pond.
 */
export function nodeIdForGame(
  game: { ID_CID?: string } | null | undefined
): string | undefined {
  const id = game?.ID_CID;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/* ─── Is a catch still owed? ───────────────────────────────── */

/**
 * The spells a finished game still owes the player, or null if it owes nothing.
 *
 * A completed, successful game is not the same thing as an uncollected one. The
 * payout is claimed by taking one of the three spells, and the game records
 * which was taken in `cardChosenId` — but it keeps `cardsToAdd` either way, as
 * the record of what was offered. Reading `cardsToAdd` alone therefore reports
 * every catch ever made as outstanding.
 *
 * That is not hypothetical: on 2026-08-12 a Grove catch whose spell had been
 * picked in the game client still carried all three cards, so the runner opened
 * every cast with a `loot` the server answered "Card already chosen" — twenty
 * casts, no energy spent, no fish. The check is `cardChosenId`, not the
 * presence of cards.
 */
export function pendingCatchCards(
  game:
    | {
        COMPLETE_CID?: boolean;
        SUCCESS_CID?: boolean;
        data?: { cardsToAdd?: FishingCard[]; cardChosenId?: number | null };
      }
    | null
    | undefined
): FishingCard[] | null {
  if (!game?.COMPLETE_CID || !game.SUCCESS_CID) return null;
  // 0 is not a card id anywhere in the deck, so it reads as "none chosen"
  // alongside null and undefined rather than as a chosen card.
  if (game.data?.cardChosenId) return null;
  const cards = game.data?.cardsToAdd;
  return cards && cards.length > 0 ? cards : null;
}
