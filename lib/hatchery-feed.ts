// Finding the shape of POST /api/pets/feed without burning materials.
//
// The endpoint is authenticated, so its request shape could never be observed
// from outside. Two guesses have now been answered by the server itself:
//
//   {petId, itemId, amount}      -> 400 {"success":false,"error":"items are required"}
//
// which is worth more than it looks: `petId` drew no complaint, and the item
// list field is named `items`. What remains unknown is the shape of the entries
// in it. `{id, amount}` is the house tuple everywhere else in this API — it is
// what `gameItemBalanceChanges` returns — so that is tried first.
//
// Rather than shipping one more guess and waiting for another report, the
// candidates are tried in order until one is accepted. That is only safe
// because of two properties, and both are enforced here:
//
//   1. A rejected payload is a validation error. Nothing is consumed, so a
//      wrong guess costs a round trip and nothing else.
//   2. Every candidate feeds exactly one unit. If a shape is accepted but a
//      field means something other than what we assumed, the blast radius is
//      one material rather than a stack.
//
// The ladder is only climbed on complaints about the *request*. A refusal about
// the game — no materials, egg already complete — stops it dead, because trying
// four spellings of a request the server understood perfectly well would just
// ask the same question four times.

export interface FeedPayloadShape {
  /** Shown in the log when a shape is accepted, so the winner can be pinned. */
  name: string;
  build(petId: string, itemId: number): Record<string, unknown>;
}

/**
 * Candidate request bodies, most likely first.
 *
 * All of them keep the amount at one. None of them omits `items`, since the
 * server has already named that field.
 */
export const FEED_PAYLOAD_SHAPES: FeedPayloadShape[] = [
  {
    name: "items:[{id,amount}]",
    build: (petId, itemId) => ({ petId, items: [{ id: itemId, amount: 1 }] }),
  },
  {
    name: "items:[{itemId,amount}]",
    build: (petId, itemId) => ({ petId, items: [{ itemId, amount: 1 }] }),
  },
  {
    name: "items:[id]",
    build: (petId, itemId) => ({ petId, items: [itemId] }),
  },
  {
    name: "numeric petId, items:[{id,amount}]",
    build: (petId, itemId) => ({ petId: Number(petId), items: [{ id: itemId, amount: 1 }] }),
  },
];

/**
 * Is this the server complaining about the request, or about the game?
 *
 * The distinction is what keeps the ladder honest. "items are required" is a
 * malformed body and the next candidate is worth trying. "Not enough Incube" is
 * a perfectly understood request with a real answer, and re-sending it in four
 * spellings would be nonsense.
 *
 * Deliberately narrow: anything unrecognised is treated as a game refusal and
 * stops the ladder. Guessing again is the costly direction, so it has to be
 * earned by a message that actually reads like a validation error.
 */
export function isRequestShapeComplaint(message: string | null | undefined): boolean {
  if (!message) return false;
  return /\b(required|must be|expected|malformed|unrecognized|unrecognised|unknown field|missing)\b|invalid (body|payload|request|parameter|field)/i.test(
    message
  );
}

const STORAGE_KEY = "giga-hatchery-feed-shape";

/** The shape index that last worked, so the ladder isn't re-climbed each feed. */
export function loadKnownShapeIndex(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw === null ? 0 : Number(raw);
    return Number.isInteger(n) && n >= 0 && n < FEED_PAYLOAD_SHAPES.length ? n : 0;
  } catch {
    return 0;
  }
}

export function saveKnownShapeIndex(index: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, String(index));
  } catch {
    // A shape that can't be remembered is rediscovered next time, which costs
    // a few round trips and nothing else.
  }
}

/**
 * Order to try, starting from the one already known to work.
 *
 * The known shape goes first and the rest follow, so a server-side change to
 * the contract still recovers instead of failing permanently on a stale memory.
 */
export function shapeOrder(startIndex: number): number[] {
  const order = [startIndex];
  for (let i = 0; i < FEED_PAYLOAD_SHAPES.length; i++) {
    if (i !== startIndex) order.push(i);
  }
  return order;
}
