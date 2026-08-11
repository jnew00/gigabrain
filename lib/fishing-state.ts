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
