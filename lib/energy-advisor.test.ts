import { describe, expect, it } from "vitest";
import { buildRecommendation, type AdvisorInput, type AdvisorPond } from "./energy-advisor";
import { AWAKENING } from "./game-data";

const DURING_EVENT = AWAKENING.startTimestamp + 60;
const AFTER_EVENT = AWAKENING.endTimestamp + 60;

const CLASSIC: AdvisorPond = {
  pondId: 1,
  name: "Classic Pond",
  nodes: [
    { nodeId: "0", label: "Small", cost: 12 },
    { nodeId: "1", label: "Normal", cost: 16 },
    { nodeId: "2", label: "Big", cost: 20 },
  ],
};

const GROVE: AdvisorPond = {
  pondId: 2,
  name: "Dendren Grove",
  nodes: [{ nodeId: "5", label: "Grove", cost: 12 }],
  eventPriority: true,
};

function input(over: Partial<AdvisorInput> = {}): AdvisorInput {
  return {
    currentEnergy: 240,
    maxEnergy: 240,
    regenPerHour: 10,
    isJuiced: false,
    romEnergyAvailable: 0,
    dungeons: [],
    fishingCastsLeft: 10,
    ponds: [CLASSIC, GROVE],
    now: DURING_EVENT,
    ...over,
  };
}

const totalCasts = (r: { fishing: { casts: number }[] }) =>
  r.fishing.reduce((s, f) => s + f.casts, 0);

describe("casts come out of one shared pool", () => {
  it("never plans more casts than the pool holds, across all ponds", () => {
    const r = buildRecommendation(input({ currentEnergy: 1000, fishingCastsLeft: 10 }));
    expect(totalCasts(r)).toBeLessThanOrEqual(10);
  });

  it("can split the pool between two ponds", () => {
    // The Grove takes what the energy allows; the rest of the pool is still
    // available to the classic pond. A single {nodeId, casts} could not say
    // this, which is why the whole pool used to go to one pond.
    const r = buildRecommendation(
      input({ currentEnergy: 1000, fishingCastsLeft: 10, ponds: [CLASSIC, { ...GROVE, coresPerCast: 100 }] })
    );
    const ponds = r.fishing.filter((f) => f.casts > 0).map((f) => f.pondId);
    expect(ponds).toContain(2);
    expect(totalCasts(r)).toBe(10);
  });

  it("leaves the classic pond nothing when the Grove takes the whole pool", () => {
    const r = buildRecommendation(input({ currentEnergy: 120, fishingCastsLeft: 10 }));
    const grove = r.fishing.find((f) => f.pondId === 2);
    expect(grove?.casts).toBe(10);
    expect(r.fishing.find((f) => f.pondId === 1)?.casts ?? 0).toBe(0);
  });

  it("stops treating the Grove as priority once the event ends", () => {
    const r = buildRecommendation(input({ now: AFTER_EVENT, ponds: [CLASSIC] }));
    expect(r.fishing.every((f) => f.pondId === 1)).toBe(true);
  });

  it("names each pond's casts separately in the notes", () => {
    const r = buildRecommendation(
      input({ currentEnergy: 1000, ponds: [CLASSIC, { ...GROVE, coresPerCast: 100 }] })
    );
    expect(r.notes.some((n) => n.includes("Dendren Grove"))).toBe(true);
  });
});

describe("event spends are ordered by measured yield", () => {
  const woods = {
    dungeonId: 7,
    name: "Forbidden Woods",
    energyCost: 20,
    runsLeft: 12,
    winRate: 0.5,
    avgRooms: 8,
    totalRuns: 20,
    eventPriority: true,
  };

  it("funds the dungeon first when it measures better per energy", () => {
    // 210 Cores / 20E = 10.5 per energy, against a Grove cast at 12 / 12E = 1.
    const r = buildRecommendation(
      input({
        currentEnergy: 300,
        dungeons: [{ ...woods, coresPerRun: 210 }],
        ponds: [CLASSIC, { ...GROVE, coresPerCast: 12 }],
      })
    );
    expect(r.dungeonRuns.find((d) => d.dungeonId === 7)?.runs).toBe(12);
    // 12 runs take 240E of the 300, and the Grove gets the 60E left over —
    // funded second because it measures worse, not skipped.
    expect(r.fishing.find((f) => f.pondId === 2)?.casts).toBe(5);
  });

  it("funds the pond first when the pond measures better per energy", () => {
    // The ordering is not a rule about dungeons outranking ponds — flip the
    // numbers and the plan flips with them.
    const r = buildRecommendation(
      input({
        currentEnergy: 300,
        fishingCastsLeft: 10,
        dungeons: [{ ...woods, coresPerRun: 20 }],
        ponds: [CLASSIC, { ...GROVE, coresPerCast: 200 }],
      })
    );
    expect(r.fishing.find((f) => f.pondId === 2)?.casts).toBe(10);
    expect(r.dungeonRuns.find((d) => d.dungeonId === 7)?.runs).toBe(9);
  });

  it("ranks a measured source above an unmeasured one and says so", () => {
    const r = buildRecommendation(
      input({
        currentEnergy: 240,
        dungeons: [{ ...woods, coresPerRun: 210 }],
        ponds: [CLASSIC, GROVE], // Grove yield never measured
      })
    );
    expect(r.dungeonRuns.find((d) => d.dungeonId === 7)?.runs).toBe(12);
    expect(r.notes.some((n) => /no recorded Core yield/i.test(n))).toBe(true);
  });

  it("admits when nothing is measured instead of implying the order is advice", () => {
    const r = buildRecommendation(
      input({ currentEnergy: 240, dungeons: [woods], ponds: [CLASSIC, GROVE] })
    );
    expect(r.notes.some((n) => /ordered by cost, not by return/i.test(n))).toBe(true);
  });

  it("reports the measured rate in the note it acts on", () => {
    const r = buildRecommendation(
      input({ currentEnergy: 240, dungeons: [{ ...woods, coresPerRun: 210 }], ponds: [] })
    );
    expect(r.notes.some((n) => n.includes("Cores/E measured"))).toBe(true);
  });
});

describe("energy accounting", () => {
  it("never plans more energy than it has", () => {
    const r = buildRecommendation(
      input({
        currentEnergy: 100,
        dungeons: [
          { dungeonId: 1, name: "Dungetron 5000: Normal", energyCost: 40, runsLeft: 10, winRate: 0.6, avgRooms: 9, totalRuns: 10 },
        ],
      })
    );
    const spend =
      r.dungeonRuns.reduce((s, d) => s + d.runs * 40, 0) +
      r.fishing.reduce((s, f) => s + f.casts * (f.pondId === 2 ? 12 : 12), 0);
    expect(spend).toBeLessThanOrEqual(100);
    expect(r.leftover).toBeGreaterThanOrEqual(0);
  });

  it("warns when the pool has casts but no energy for one", () => {
    const r = buildRecommendation(input({ currentEnergy: 5, fishingCastsLeft: 8 }));
    expect(r.warnings.some((w) => /isn't 12E for even one/.test(w))).toBe(true);
  });

  it("only calls the day done when the shared pool is empty too", () => {
    // Enough energy to spend the whole pool: caps really are filled.
    const filled = buildRecommendation(
      input({ currentEnergy: 1000, maxEnergy: 1000, fishingCastsLeft: 10, now: AFTER_EVENT, ponds: [CLASSIC] })
    );
    expect(filled.fishing.reduce((s, f) => s + f.casts, 0)).toBe(10);
    expect(filled.notes.some((n) => /all daily caps filled/.test(n))).toBe(true);

    // Energy to spare but casts still unspent is NOT "all caps filled" — the
    // cast cap is the one that expires overnight.
    const withCasts = buildRecommendation(
      input({ currentEnergy: 60, maxEnergy: 1000, fishingCastsLeft: 10, now: AFTER_EVENT, ponds: [CLASSIC] })
    );
    expect(withCasts.notes.some((n) => /all daily caps filled/.test(n))).toBe(false);
  });
});
