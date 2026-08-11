// Everything the app knows about ponds, in one table keyed by pondId.
//
// The code this replaces was written when there was exactly one pond, so "the
// pond" was never a parameter — it was the shape of the world. The Dendren
// Grove made that assumption wrong in about a dozen independent places, each
// of which failed quietly and separately: casts counted against the wrong
// counter, catches reported in the wrong currency, fish sold at the wrong
// stall, cards aimed at the wrong board.
//
// So the rule here is that a pond is always named, never assumed. Every lookup
// below either finds the pond it was asked for or fails. Nothing falls back to
// pond 1 — a third pond should stop the app with a legible error rather than
// quietly sell its fish to the Grove.

import { AWAKENING } from "./game-data";

/** Thrown when a pondId reaches code that has no table entry for it. */
export class UnknownPondError extends Error {
  constructor(pondId: number | undefined) {
    super(
      `Unknown pondId ${pondId}. Ponds must be declared in lib/ponds.ts — ` +
        `this is deliberately fatal so a new pond cannot silently be treated as pond 1.`
    );
    this.name = "UnknownPondError";
  }
}

/** Thrown when a cast node reaches code that cannot say which pond it belongs to. */
export class UnknownCastNodeError extends Error {
  constructor(nodeId: string | undefined) {
    super(
      `Cast node "${nodeId}" belongs to no declared pond. Add it to the pond's ` +
        `\`nodes\` in lib/ponds.ts before casting on it.`
    );
    this.name = "UnknownCastNodeError";
  }
}

export interface CastNode {
  /** Wire value for the `nodeId` field on start_run */
  nodeId: string;
  label: string;
  /** Energy per cast */
  cost: number;
}

export interface PondDef {
  pondId: number;
  name: string;
  /**
   * Item the stall pays out for this pond's fish, and the currency its skill
   * tree spends. These are genuinely different currencies — Seaweed and
   * Infused Sediment feed separate trees and must never be summed.
   */
  currencyItemId: number;
  currencyLabel: string;
  /** Cast nodes that fish this pond, cheapest first. */
  nodes: readonly CastNode[];
  /**
   * Cards are 3x3 stamps anchored on the lure rather than board addresses, and
   * the lure is moved through `focusPoint`. Mirrors `focusMechanicEnabled` on
   * the live game state, which stays authoritative for a game in progress.
   */
  lureAnchored: boolean;
  /**
   * Board edge length when no game is in progress. `gameState.data.gridSize` is
   * authoritative whenever there is a game — this is only for planning UI.
   */
  fallbackGridSize: number;
  /**
   * Castable only inside this window, in unix seconds. Absent means permanent.
   * Verified against /api/offchain/static (liveEvent) on 2026-08-11.
   */
  openWindow?: { startTimestamp: number; endTimestamp: number };
}

/**
 * The ponds, verified against /api/fishing/state on 2026-08-11: `exchangeRates`
 * carries pondId 1 and 2 (39 and 24 fish respectively), `dayDocs` carries a
 * counter for each, and `pondEntryTiers` covers pond 2 only.
 */
export const PONDS: readonly PondDef[] = [
  {
    pondId: 1,
    name: "Classic Pond",
    currencyItemId: 333,
    currencyLabel: "Seaweed",
    nodes: [
      { nodeId: "0", label: "Small", cost: 12 },
      { nodeId: "1", label: "Normal", cost: 16 },
      { nodeId: "2", label: "Big", cost: 20 },
    ],
    lureAnchored: false,
    fallbackGridSize: 3,
  },
  {
    pondId: 2,
    name: "Dendren Grove",
    currencyItemId: 935,
    currencyLabel: "Infused Sediment",
    // One node, and it has no nodeNEnergy field of its own in the state
    // response the way the classic three do, so the cost lives here.
    nodes: [{ nodeId: "5", label: "Grove", cost: 12 }],
    lureAnchored: true,
    fallbackGridSize: 4,
    openWindow: {
      startTimestamp: AWAKENING.startTimestamp,
      endTimestamp: AWAKENING.endTimestamp,
    },
  },
] as const;

/** The pond, or undefined. Prefer `pondById` anywhere a miss is a bug. */
export function findPond(pondId: number | undefined): PondDef | undefined {
  return PONDS.find((p) => p.pondId === pondId);
}

/** The pond, or a thrown error. Use from anything that acts on a pond. */
export function pondById(pondId: number | undefined): PondDef {
  const pond = findPond(pondId);
  if (!pond) throw new UnknownPondError(pondId);
  return pond;
}

/** The pond a cast node fishes, or undefined. */
export function findPondForNode(nodeId: string | undefined): PondDef | undefined {
  if (nodeId === undefined) return undefined;
  return PONDS.find((p) => p.nodes.some((n) => n.nodeId === nodeId));
}

/** The pond a cast node fishes, or a thrown error. */
export function pondForNode(nodeId: string | undefined): PondDef {
  const pond = findPondForNode(nodeId);
  if (!pond) throw new UnknownCastNodeError(nodeId);
  return pond;
}

/** The node definition, or a thrown error. */
export function castNodeById(nodeId: string | undefined): CastNode {
  const node = findPondForNode(nodeId)?.nodes.find((n) => n.nodeId === nodeId);
  if (!node) throw new UnknownCastNodeError(nodeId);
  return node;
}

/** Is this pond castable right now? Permanent ponds always are. */
export function isPondOpen(pond: PondDef, nowSeconds: number = Date.now() / 1000): boolean {
  if (!pond.openWindow) return true;
  return (
    nowSeconds >= pond.openWindow.startTimestamp && nowSeconds < pond.openWindow.endTimestamp
  );
}

/** Ponds castable right now. Event ponds drop out on their own end date. */
export function openPonds(nowSeconds: number = Date.now() / 1000): PondDef[] {
  return PONDS.filter((p) => isPondOpen(p, nowSeconds));
}

/** Every castable node across every open pond, tagged with its pond. */
export function openCastNodes(
  nowSeconds: number = Date.now() / 1000
): (CastNode & { pondId: number; pondName: string })[] {
  return openPonds(nowSeconds).flatMap((p) =>
    p.nodes.map((n) => ({ ...n, pondId: p.pondId, pondName: p.name }))
  );
}

/**
 * Currency name for display.
 *
 * Deliberately does not throw — a render pass should not blow up the page over
 * an unrecognised pond — but it never guesses "Seaweed" either. An unknown pond
 * says so on screen, which is how a third pond announces itself.
 */
export function pondCurrencyLabel(pondId: number | undefined): string {
  return findPond(pondId)?.currencyLabel ?? `pond ${pondId ?? "?"} currency`;
}

/** Currency item id. Throws — callers use this to move real balances around. */
export function pondCurrencyItemId(pondId: number | undefined): number {
  return pondById(pondId).currencyItemId;
}

/** Which pond pays in this item, for pairing a skill tree to its pond. */
export function pondForCurrencyItem(itemId: number | undefined): PondDef | undefined {
  return PONDS.find((p) => p.currencyItemId === itemId);
}

/* ─── Daily cast pool ──────────────────────────────────────── */

/**
 * The shape the state endpoint returns per-pond cast counters in.
 *
 * Confirmed on 2026-08-11: `dayDocs` is `[{pondId, doc:{UINT256_CID}}]`, and the
 * singular `dayDoc` is pond 1's document (`ID_CID: "player-day-data"`) with no
 * pondId field of its own.
 */
export interface DayCountState {
  dayDoc?: { UINT256_CID: number };
  dayDocs?: { pondId: number; doc: { UINT256_CID: number } }[];
}

/** Casts spent today, per pond. */
export function castsUsedByPond(state: DayCountState | null | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!state) return out;
  if (state.dayDocs?.length) {
    for (const d of state.dayDocs) out.set(d.pondId, d.doc?.UINT256_CID ?? 0);
    return out;
  }
  // Pre-Grove responses carried only the singular doc, which is pond 1's.
  if (state.dayDoc) out.set(1, state.dayDoc.UINT256_CID ?? 0);
  return out;
}

/**
 * Casts spent today across every pond.
 *
 * The daily cap is one shared pool but the server counts per pond, and `dayDoc`
 * reports only the first. Reading that alone under-counted by the entire Grove
 * — 19 casts invisible — so the plan believed a full allowance remained while
 * the server refused every start_run.
 */
export function castsUsedToday(state: DayCountState | null | undefined): number {
  let sum = 0;
  for (const used of castsUsedByPond(state).values()) sum += used;
  return sum;
}

/* ─── Entry tiers ──────────────────────────────────────────── */

/**
 * A pond's offering tiers, as returned in `pondEntryTiers`.
 *
 * Verified for the Grove on 2026-08-11: three tiers with `dropMultiplier` 1, 2
 * and 4. Tier 1 is free; tiers 2 and 3 each want a single faction ring, and
 * `inputsBasedOnFactionDay` means the server picks WHICH of the listed rings
 * from your faction and the day — a mapping that is not documented anywhere.
 */
export interface PondEntryTier {
  name: string;
  tier: number;
  pondId: number;
  inputItems: number[];
  inputAmounts: number[];
  inputsBasedOnFactionDay: boolean;
  /** Cores per cast, relative to tier 1 */
  dropMultiplier: number;
  startDay: number;
  endDay: number;
}

export interface EntryTierChoice {
  tier: number;
  dropMultiplier: number;
  /** Items that may be consumed. Empty for a free tier. */
  costsItems: number[];
}

/**
 * Cheapest tier that gets a cast started, and the best tier the player could
 * pay for out of inventory.
 *
 * These are returned together on purpose. Tiers 2 and 3 multiply Cores by 2x
 * and 4x, but they are paid for with faction rings, which are Legendary
 * collectables — whether a ring is worth 4x Cores on one cast is a market
 * question, not a rule, so nothing here spends one unless the caller has
 * explicitly opted in. `payable` is the offer; `free` is what gets sent
 * otherwise.
 *
 * A pond with no tiers at all (the classic ponds) takes tier 0. A pond whose
 * every tier costs an item has no free entry and returns `free: null` — the
 * caller must then either opt in to paying or not cast.
 */
export function pondEntryOptions(
  tiers: PondEntryTier[] | undefined,
  pondId: number,
  balances: Record<string, number>,
  currentDay?: number
): { free: EntryTierChoice | null; payable: EntryTierChoice | null } {
  const mine = (tiers ?? []).filter(
    (t) =>
      t.pondId === pondId &&
      (currentDay === undefined || (currentDay >= t.startDay && currentDay <= t.endDay))
  );
  if (!mine.length) {
    // No offering system on this pond — the wire field still has to be sent.
    return { free: { tier: 0, dropMultiplier: 1, costsItems: [] }, payable: null };
  }

  const byTier = [...mine].sort((a, b) => a.tier - b.tier);
  // `free` means free. A pond whose every tier wants an item has no free entry,
  // and the honest answer is null — falling back to the lowest-numbered tier
  // handed the caller a paid tier labelled "free", which would spend a faction
  // ring on every cast without anyone opting in.
  const freeTier = byTier.find((t) => !t.inputItems?.length);
  const free: EntryTierChoice | null = freeTier
    ? {
        tier: freeTier.tier,
        dropMultiplier: freeTier.dropMultiplier ?? 1,
        costsItems: [],
      }
    : null;

  // Best payable tier by what it actually pays out, not by tier number.
  let payable: EntryTierChoice | null = null;
  for (const t of byTier) {
    if (!t.inputItems?.length) continue;
    // `inputsBasedOnFactionDay` means only one of the listed rings will be
    // accepted and we cannot tell which, so holding any of them is treated as
    // payable. A rejected start_run consumes neither a ring nor a daily cast.
    const canPay = t.inputItems.some((itemId, i) => {
      const need = t.inputAmounts?.[i] ?? 1;
      return (balances[String(itemId)] ?? 0) >= need;
    });
    if (!canPay) continue;
    const mult = t.dropMultiplier ?? 1;
    if (!payable || mult > payable.dropMultiplier) {
      payable = { tier: t.tier, dropMultiplier: mult, costsItems: t.inputItems };
    }
  }
  return { free, payable };
}
