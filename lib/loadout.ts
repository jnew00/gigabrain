// What is actually equipped, and what is wrong with it.
//
// The gear panels that existed before this answered "what is broken" by
// scanning every owned piece. That misses the question a player actually asks
// before a run, which is "is my kit on". A pair of hands sitting in the bag at
// full durability is not broken and never appeared anywhere, but it is the
// reason a pot does not open.
//
// Slot numbers are the API's only identifier — `EQUIPPABLE_TO_CID` on the
// definition and `EQUIPPED_TO_SLOT_CID` on the instance — and nothing in
// `/api/offchain/static` publishes names for them. The labels below were read
// off live gear on 2026-08-15 by seeing which pieces declare which slot; a slot
// with no evidence is shown by number rather than guessed at, the same way an
// unknown pond names itself instead of defaulting to Seaweed.

import { isRestorable, repairsLeft, type GearItemDef } from "./gear";

/**
 * There are TWO loadouts, not one, and they use different slot numbers.
 *
 * The Gear Station dresses you for normal dungeons; the Forest Shrine dresses
 * you for the Forbidden Woods, and the two share nothing but the Toolbar. Slots
 * 11-15 stood empty for an entire event because nothing surfaced that the
 * second set existed — 36 Forbidden Woods runs averaging room 1.9 against 9.2
 * in Dungetron, with no head, body, charm or rod equipped for any of them.
 *
 * Every label is read off `EQUIPPABLE_TO_CID` in /api/gear/items on 2026-08-15:
 * slot 11 holds Warmshroom/Coolshroom/Toxishroom Head, slot 14 holds Shroom,
 * Golkan and Makeshift Rod, slot 15 holds the six Lures, and so on. A slot with
 * no such evidence is shown by number rather than guessed at.
 */
const SLOT_LABELS: Record<number, string> = {
  // Gear Station — normal dungeons
  2: "Head",
  3: "Body",
  6: "Charm",
  8: "Rod",
  10: "Lure",
  // Shared across both
  7: "Toolbar",
  // Forest Shrine — the Forbidden Woods
  11: "Woods head",
  12: "Woods body",
  13: "Woods charm",
  14: "Woods rod",
  15: "Woods lure",
};

/** The Forbidden Woods loadout, which the Forest Shrine fills. */
const WOODS_SLOTS = [11, 12, 13, 14, 15];

/**
 * The Toolbar, whose contents this API does not publish.
 *
 * Every other slot reports through `EQUIPPED_TO_SLOT_CID` — equipping a
 * Toxishroom Head at the Forest Shrine set slot 11 within seconds. Tools do
 * not: with three tools visibly sitting in the game's Toolbar, no instance
 * reports slot 7 and both owned pairs of hands have been untouched for days.
 *
 * So an empty Toolbar here means "not published", not "not equipped", and
 * warning about it told the player to go fix something that was already fine.
 * Nothing is claimed about this slot until the game publishes it somewhere.
 */
const UNOBSERVABLE_SLOTS = [7];

export function slotLabel(slot: number): string {
  return SLOT_LABELS[slot] ?? `Slot ${slot}`;
}

export function isWoodsSlot(slot: number): boolean {
  return WOODS_SLOTS.includes(slot);
}

export interface GearPiece {
  docId: string;
  GAME_ITEM_ID_CID: number;
  DURABILITY_CID: number;
  EQUIPPED_TO_SLOT_CID: number;
  EQUIPPED_TO_INDEX_CID?: number;
  RARITY_CID?: number;
  REPAIR_COUNT_CID?: number;
}

export interface LoadoutEntry {
  docId: string;
  name: string;
  slot: number;
  index: number;
  durability: number;
  maxDurability: number | null;
  repairsLeft: number | null;
  restorable: boolean;
  /** Broken, out of repairs, and no restore recipe — the slot needs a new piece. */
  dead: boolean;
}

export interface LoadoutSlot {
  slot: number;
  label: string;
  equipped: LoadoutEntry[];
  /** Owned, fits this slot, not equipped. */
  benched: LoadoutEntry[];
}

function entry(
  g: GearPiece,
  def: GearItemDef | undefined,
  itemName: (id: number) => string
): LoadoutEntry {
  const rarity = g.RARITY_CID ?? 0;
  const left = repairsLeft(g, def);
  return {
    docId: g.docId,
    name: itemName(g.GAME_ITEM_ID_CID),
    slot: def?.EQUIPPABLE_TO_CID ?? g.EQUIPPED_TO_SLOT_CID,
    index: g.EQUIPPED_TO_INDEX_CID ?? 0,
    durability: g.DURABILITY_CID,
    maxDurability: def?.DURABILITY_CID_array?.[rarity] ?? null,
    repairsLeft: left,
    restorable: isRestorable(def),
    dead: g.DURABILITY_CID <= 0 && left != null && left <= 0 && !isRestorable(def),
  };
}

/**
 * Every slot the player has gear for, equipped and benched together.
 *
 * Keyed on the definition's `EQUIPPABLE_TO_CID` rather than the instance's
 * equipped slot, because an unequipped piece reports -1 — and the whole point
 * is to show the bench beside the slot it belongs to.
 */
export function buildLoadout(
  owned: GearPiece[],
  defs: Record<number, GearItemDef>,
  itemName: (id: number) => string
): LoadoutSlot[] {
  const bySlot = new Map<number, LoadoutSlot>();
  for (const g of owned) {
    const def = defs[g.GAME_ITEM_ID_CID];
    const e = entry(g, def, itemName);
    if (e.slot < 0) continue;
    let s = bySlot.get(e.slot);
    if (!s) {
      s = { slot: e.slot, label: slotLabel(e.slot), equipped: [], benched: [] };
      bySlot.set(e.slot, s);
    }
    if (g.EQUIPPED_TO_SLOT_CID >= 0) s.equipped.push(e);
    else s.benched.push(e);
  }
  for (const s of bySlot.values()) {
    s.equipped.sort((a, b) => a.index - b.index);
    s.benched.sort((a, b) => b.durability - a.durability);
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
}

export type LoadoutWarningKind =
  | "woods-slot-empty"
  | "slot-empty-with-bench"
  | "equipped-dead"
  | "equipped-low"
  | "bench-beats-equipped";

export interface LoadoutWarning {
  kind: LoadoutWarningKind;
  slot: number;
  label: string;
  message: string;
}

/** Below this share of max durability a piece is about to fail mid-activity. */
const LOW_DURABILITY = 0.15;

/**
 * What is wrong with the kit, in the order it will bite.
 *
 * The first case is the one nothing else catches: a slot standing empty while
 * usable gear for it sits in the bag. Every other panel scans for damage, so a
 * healthy unequipped pair of hands is invisible to all of them — and an empty
 * hands slot is exactly why a pot refuses to open.
 */
export function loadoutWarnings(
  slots: LoadoutSlot[],
  /** Woods slots with no gear at all, which owning nothing cannot explain away. */
  emptyWoodsSlots: number[] = []
): LoadoutWarning[] {
  const out: LoadoutWarning[] = [];

  // Ahead of everything else: an event run made in an empty loadout costs the
  // same energy as a geared one and expires with the event.
  for (const slot of emptyWoodsSlots) {
    out.push({
      kind: "woods-slot-empty",
      slot,
      label: slotLabel(slot),
      message: `${slotLabel(slot)} is empty. The Forbidden Woods uses its own loadout at the Forest Shrine — gear from the Gear Station does not carry over.`,
    });
  }

  for (const s of slots) {
    const usableBench = s.benched.filter((b) => b.durability > 0);

    // An unpublished slot cannot be reported as empty — see UNOBSERVABLE_SLOTS.
    if (UNOBSERVABLE_SLOTS.includes(s.slot)) continue;

    if (s.equipped.length === 0 && usableBench.length > 0) {
      out.push({
        kind: "slot-empty-with-bench",
        slot: s.slot,
        label: s.label,
        message:
          `${s.label} is empty, but you own ${usableBench
            .map((b) => `${b.name} (${b.durability} uses)`)
            .join(" and ")}. Equip it in the game — nothing here equips gear for you.`,
      });
      continue;
    }

    for (const e of s.equipped) {
      if (e.dead) {
        out.push({
          kind: "equipped-dead",
          slot: s.slot,
          label: s.label,
          message: `${e.name} is finished — broken, out of repairs, no restore. It occupies ${s.label} without doing anything.`,
        });
      } else if (
        e.maxDurability != null &&
        e.durability > 0 &&
        e.durability / e.maxDurability <= LOW_DURABILITY
      ) {
        out.push({
          kind: "equipped-low",
          slot: s.slot,
          label: s.label,
          message: `${e.name} has ${e.durability} of ${e.maxDurability} uses left. It will break mid-run.`,
        });
      }
    }

    // A benched piece with durability, behind an equipped one with none.
    const bestBench = usableBench[0];
    const worstEquipped = s.equipped.find((e) => e.durability <= 0);
    if (bestBench && worstEquipped) {
      out.push({
        kind: "bench-beats-equipped",
        slot: s.slot,
        label: s.label,
        message: `${worstEquipped.name} is at 0 uses while ${bestBench.name} sits in your bag with ${bestBench.durability}. Swap them.`,
      });
    }
  }
  return out;
}

/**
 * Forbidden Woods slots with nothing equipped.
 *
 * Derived from the slot list rather than from owned gear, because the failure
 * being reported is an absence: a slot the player has never filled has no
 * instance to scan, so anything that walks the inventory cannot see it.
 */
export function emptyWoodsSlots(slots: LoadoutSlot[]): number[] {
  const filled = new Set(
    slots.filter((s) => s.equipped.length > 0).map((s) => s.slot)
  );
  return WOODS_SLOTS.filter((s) => !filled.has(s));
}

/**
 * Hands the game will accept for a pot right now.
 *
 * A pot call takes a gear instance id, so the hands do not have to be worn —
 * but they do have to have durability left. Matching on name alone returned
 * whichever pair was found first, including one at zero uses, and the plan then
 * reported the pot ready and watched the break fail.
 */
export function usableHands(
  owned: GearPiece[],
  defs: Record<number, GearItemDef>,
  itemName: (id: number) => string,
  match: string
): GearPiece | null {
  const wanted = match.toLowerCase();
  const candidates = owned.filter((g) => {
    if (g.DURABILITY_CID <= 0) return false;
    return itemName(g.GAME_ITEM_ID_CID).toLowerCase().includes(wanted);
  });
  if (candidates.length === 0) return null;
  // Spend the most worn usable pair first, so a fresher one is kept in reserve.
  return candidates.sort((a, b) => {
    void defs;
    return a.DURABILITY_CID - b.DURABILITY_CID;
  })[0];
}
