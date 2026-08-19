import { describe, expect, it } from "vitest";
import { buildHatcheryAdvice, type HatcheryAdvisorInput } from "./hatchery-advisor";
import { HATCHERY_FALLBACK_CONFIG, type EggState } from "./hatchery";

const noReading = { value: null, chosen: null, ambiguous: false, candidates: [] };

function egg(over: Partial<EggState> & { petId: string }): EggState {
  const fate = over.fate ?? {};
  return {
    name: `#${over.petId}`,
    eggType: "ROM Egg",
    temperature: 100,
    comfort: 5,
    progress: 50,
    quality: 40,
    hatched: false,
    incubating: true,
    // The plain grades at one unit per increment, which is the simplest quote
    // the game can give. Tests that care about the quote override it.
    nextIncrement: {
      temperature: { itemId: 576, amount: 1 },
      comfort: { itemId: 578, amount: 1 },
    },
    progressPerDay: null,
    qualityPerDay: null,
    fateStatus: null,
    missing: [],
    readings: {
      temperature: noReading,
      comfort: noReading,
      progress: noReading,
      quality: noReading,
    },
    ambiguous: [],
    raw: null,
    ...over,
    fate,
    influences: Object.values(fate).reduce((s, n) => s + n, 0),
  };
}

function advise(over: Partial<HatcheryAdvisorInput> = {}) {
  return buildHatcheryAdvice({
    eggs: [],
    balances: {},
    config: HATCHERY_FALLBACK_CONFIG,
    fateTarget: "any",
    ...over,
  });
}

describe("an empty hatchery", () => {
  it("says so rather than emitting an empty plan", () => {
    const advice = advise();
    expect(advice.eggs).toHaveLength(0);
    expect(advice.notes[0]).toContain("No eggs");
  });

  it("ignores eggs that already hatched", () => {
    const advice = advise({ eggs: [egg({ petId: "1", hatched: true })] });
    expect(advice.eggs).toHaveLength(0);
  });
});

describe("hatch alerts", () => {
  it("flags a full-progress egg and does not feed it", () => {
    const advice = advise({
      eggs: [egg({ petId: "1", progress: 100, temperature: 0, comfort: 0 })],
      balances: { 576: 50, 578: 50 },
    });
    expect(advice.readyToHatch).toHaveLength(1);
    // Feeding a finished egg is pure waste, so nothing is drawn from the pool.
    expect(advice.eggs[0].feeds).toHaveLength(0);
    expect(advice.eggs[0].alerts[0]).toContain("Ready to hatch");
  });

  it("warns when a ready egg would hatch factionless", () => {
    const advice = advise({ eggs: [egg({ petId: "1", progress: 100, fate: { 1: 4 } })] });
    expect(advice.eggs[0].alerts.join(" ")).toContain("factionless");
  });

  it("does not warn about fate on a ready egg that already has all 20", () => {
    const advice = advise({ eggs: [egg({ petId: "1", progress: 100, fate: { 1: 20 } })] });
    expect(advice.eggs[0].alerts.join(" ")).not.toContain("factionless");
  });
});

describe("comfort is funded before temperature", () => {
  it("spends a short pool on comfort and leaves temperature cold", () => {
    // Enough Incube for the comfort gap, and Biofuel that will go unused
    // because the pool is drawn in priority order.
    const advice = advise({
      eggs: [egg({ petId: "1", comfort: 3, temperature: 20 })],
      balances: { 578: 2, 576: 0 },
    });
    const plan = advice.eggs[0];
    expect(plan.feeds.filter((f) => f.stat === "comfort")[0].amount).toBe(2);
    expect(plan.feeds.filter((f) => f.stat === "temperature")).toHaveLength(0);
    expect(advice.warnings.join(" ")).toContain("progress running slower");
  });

  it("orders every comfort feed ahead of every temperature feed", () => {
    const advice = advise({
      eggs: [egg({ petId: "1", comfort: 4, temperature: 50 })],
      balances: { 578: 5, 576: 5 },
    });
    const stats = advice.feedOrder.map((f) => f.feed.stat);
    expect(stats.indexOf("comfort")).toBeLessThan(stats.indexOf("temperature"));
  });

  it("calls a comfort shortfall a permanent loss and a temperature one a delay", () => {
    const advice = advise({
      eggs: [egg({ petId: "1", comfort: 1, temperature: 10 })],
      balances: {},
    });
    const text = advice.warnings.join(" ");
    expect(text).toContain("quality being lost");
    expect(text).toContain("not a permanent loss");
  });
});

describe("comfort goes to the youngest eggs", () => {
  it("gives the single unit to the egg with the most progress left to bank", () => {
    const advice = advise({
      eggs: [
        egg({ petId: "old", progress: 90, comfort: 4 }),
        egg({ petId: "young", progress: 10, comfort: 4 }),
      ],
      balances: { 578: 1 },
    });
    const young = advice.eggs.find((e) => e.petId === "young")!;
    const old = advice.eggs.find((e) => e.petId === "old")!;
    expect(young.feeds).toHaveLength(1);
    expect(old.feeds).toHaveLength(0);
    expect(young.feeds[0].reason).toContain("90%");
  });
});

describe("temperature goes to the eggs closest to finishing", () => {
  it("fuels the oldest egg first when there is only one unit", () => {
    const advice = advise({
      eggs: [
        egg({ petId: "old", progress: 90, temperature: 0 }),
        egg({ petId: "young", progress: 10, temperature: 0 }),
      ],
      balances: { 576: 1 },
    });
    expect(advice.eggs.find((e) => e.petId === "old")!.feeds).toHaveLength(1);
    expect(advice.eggs.find((e) => e.petId === "young")!.feeds).toHaveLength(0);
  });

  it("calls a cold egg stalled, because progress has actually stopped", () => {
    const advice = advise({ eggs: [egg({ petId: "1", temperature: 0 })], balances: {} });
    expect(advice.eggs[0].status).toBe("stalled");
    expect(advice.eggs[0].alerts[0]).toContain("progress has stopped");
  });
});

describe("the game's quote decides what gets fed", () => {
  it("feeds the item the egg asks for, not the cheap grade sitting in the bag", () => {
    // The live case this was written for: an egg at 72/100 quoted 3x Biofuel+
    // while three plain Biofuel went unused. Feeding the plain grade is a call
    // the game rejects, so the cheap stock is not a substitute.
    const advice = advise({
      eggs: [
        egg({
          petId: "1",
          temperature: 90,
          nextIncrement: {
            temperature: { itemId: 577, amount: 3 },
            comfort: { itemId: 579, amount: 2 },
          },
        }),
      ],
      balances: { 576: 50, 577: 3 },
    });
    const feed = advice.eggs[0].feeds.find((f) => f.stat === "temperature")!;
    expect(feed.name).toBe("Biofuel+");
    expect(feed.amount).toBe(3);
    expect(feed.increments).toBe(1);
  });

  it("multiplies the quote across the increments the gap needs", () => {
    const advice = advise({
      eggs: [
        egg({
          petId: "1",
          comfort: 2,
          nextIncrement: {
            temperature: null,
            comfort: { itemId: 579, amount: 2 },
          },
        }),
      ],
      balances: { 579: 10 },
    });
    const feed = advice.eggs[0].feeds[0];
    // Three increments to reach 5, at two units each.
    expect(feed.increments).toBe(3);
    expect(feed.amount).toBe(6);
    expect(advice.notes.join(" ")).toContain("next increment only");
  });

  it("plans nothing for a stat the egg quoted no price for", () => {
    const advice = advise({
      eggs: [
        egg({
          petId: "1",
          temperature: 0,
          nextIncrement: { temperature: null, comfort: null },
        }),
      ],
      balances: { 576: 50 },
    });
    expect(advice.eggs[0].feeds).toHaveLength(0);
  });
});

describe("an egg that was never placed in the hatchery", () => {
  it("says to place it rather than blaming the parser", () => {
    const advice = advise({
      eggs: [
        egg({
          petId: "1",
          incubating: false,
          temperature: null,
          comfort: null,
          missing: ["temperature", "comfort"],
        }),
      ],
      balances: { 576: 50, 578: 50 },
    });
    expect(advice.eggs[0].status).toBe("idle");
    expect(advice.eggs[0].feeds).toHaveLength(0);
    expect(advice.warnings.join(" ")).toContain("Not in the hatchery");
    expect(advice.warnings.join(" ")).not.toContain("read correctly");
  });
});

describe("an egg the API did not describe", () => {
  it("gets no feed plan rather than a plan built on zeros", () => {
    const advice = advise({
      eggs: [
        egg({
          petId: "1",
          temperature: null,
          comfort: null,
          missing: ["temperature", "comfort"],
        }),
      ],
      balances: { 576: 50, 578: 50 },
    });
    expect(advice.eggs[0].status).toBe("unreadable");
    expect(advice.eggs[0].feeds).toHaveLength(0);
    expect(advice.warnings.join(" ")).toContain("no temperature or comfort");
  });

  it("still plans the half it can read", () => {
    const advice = advise({
      eggs: [egg({ petId: "1", comfort: 2, temperature: null, missing: ["temperature"] })],
      balances: { 578: 10 },
    });
    expect(advice.eggs[0].status).not.toBe("unreadable");
    expect(advice.eggs[0].feeds.filter((f) => f.stat === "comfort")).toHaveLength(1);
  });
});

describe("fate across several eggs", () => {
  const dust = Object.fromEntries([73, 74, 75, 76, 77, 78, 79].map((id) => [id, 1000]));

  it("takes each egg to a guaranteed faction trait when dust allows", () => {
    const advice = advise({
      eggs: [egg({ petId: "1" }), egg({ petId: "2" })],
      balances: dust,
    });
    expect(advice.eggs.every((e) => e.fate?.guaranteed)).toBe(true);
  });

  it("spends the shared dust on the egg closest to hatching first", () => {
    const advice = advise({
      eggs: [egg({ petId: "young", progress: 5 }), egg({ petId: "old", progress: 95 })],
      // Enough for one full spread (119) and no more.
      balances: Object.fromEntries([73, 74, 75, 76, 77, 78, 79].map((id) => [id, 18])),
    });
    const old = advice.eggs.find((e) => e.petId === "old")!;
    const young = advice.eggs.find((e) => e.petId === "young")!;
    expect(old.fate!.influencesAfter).toBeGreaterThan(young.fate!.influencesAfter);
  });

  it("raises the alarm on a nearly-done egg whose fate cannot be finished", () => {
    const advice = advise({ eggs: [egg({ petId: "1", progress: 80 })], balances: {} });
    expect(advice.eggs[0].alerts.join(" ")).toContain("may hatch factionless");
  });

  it("explains that 'any faction' is the cheap route", () => {
    const advice = advise({ eggs: [egg({ petId: "1" })], balances: dust });
    expect(advice.notes.join(" ")).toContain("2.5x");
  });
});

describe("shortfalls point at a Vilhelm trade", () => {
  it("names the trade and the base material it consumes", () => {
    const advice = advise({
      eggs: [egg({ petId: "1", comfort: 0 })],
      // No Incube, but plenty of Bone to trade for some.
      balances: { 23: 100 },
    });
    const craft = advice.craft.find((c) => c.itemId === 578);
    expect(craft).toBeDefined();
    // The docId the trade endpoint wants, not the bare ID_CID.
    expect(craft!.recipeId).toBe("Recipe#Hatchery#500003");
    expect(craft!.runs).toBe(5);
    expect(craft!.inputTotal).toBe(10);
    expect(craft!.reason).toContain("already hold");
  });

  it("says how short the base material is when even the trade cannot run", () => {
    const advice = advise({ eggs: [egg({ petId: "1", comfort: 0 })], balances: { 23: 2 } });
    const craft = advice.craft.find((c) => c.itemId === 578)!;
    expect(craft.reason).toContain("short");
  });

  it("suggests nothing to craft when every stat is already full", () => {
    const advice = advise({ eggs: [egg({ petId: "1" })], balances: {} });
    expect(advice.craft).toHaveLength(0);
  });
});

describe("spend accounting", () => {
  it("totals the materials the plan actually consumes", () => {
    const advice = advise({
      eggs: [egg({ petId: "1", comfort: 3, temperature: 80 })],
      balances: { 578: 10, 576: 10 },
    });
    const incube = advice.spend.find((s) => s.itemId === 578)!;
    const biofuel = advice.spend.find((s) => s.itemId === 576)!;
    expect(incube.amount).toBe(2);
    expect(biofuel.amount).toBe(2);
  });

  it("never plans to spend more than the balance holds across all eggs", () => {
    const advice = advise({
      eggs: [egg({ petId: "1", comfort: 0 }), egg({ petId: "2", comfort: 0 })],
      balances: { 578: 6 },
    });
    const total = advice.spend.find((s) => s.itemId === 578)?.amount ?? 0;
    expect(total).toBeLessThanOrEqual(6);
  });
});

describe("eggspeditors already in the bag", () => {
  it("points out one that would finish the egg and lift its quality", () => {
    const advice = advise({
      eggs: [egg({ petId: "1", quality: 20, progress: 40 })],
      balances: { 586: 1 },
    });
    expect(advice.eggs[0].notes.join(" ")).toContain("Eggspeditor 3");
    expect(advice.eggs[0].notes.join(" ")).toContain("50");
  });

  it("stays quiet about one that would not raise quality at all", () => {
    const advice = advise({
      eggs: [egg({ petId: "1", quality: 80 })],
      balances: { 586: 1 },
    });
    expect(advice.eggs[0].notes.join(" ")).not.toContain("Eggspeditor");
  });
});
