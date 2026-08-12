import { describe, expect, it } from "vitest";
import {
  HATCHERY_FALLBACK_CONFIG,
  MAX_INFLUENCES,
  collectEggs,
  findFate,
  findNumber,
  findNumberCandidates,
  pickStat,
  influenceCost,
  influenceLadderCost,
  materialsFor,
  normalizeEgg,
  planFate,
  readHatcheryConfig,
} from "./hatchery";

describe("bounds come from the API, field by field", () => {
  it("reads the live hatchery block", () => {
    const config = readHatcheryConfig({
      hatchery: {
        maxProgress: 100,
        maxRarity: 100,
        maxPetsInHatchery: 300,
        comfortConfig: { minValue: 0, maxValue: 5, increment: 1 },
        temperatureConfig: { minValue: 0, maxValue: 100, increment: 10 },
      },
    });
    expect(config.temperature.maxValue).toBe(100);
    expect(config.temperature.increment).toBe(10);
    expect(config.comfort.maxValue).toBe(5);
    expect(config.maxQuality).toBe(100);
  });

  it("falls back per field, not wholesale, when the API partly changes", () => {
    const config = readHatcheryConfig({ hatchery: { maxProgress: 200 } });
    expect(config.maxProgress).toBe(200);
    // The rest still has to be usable rather than undefined.
    expect(config.comfort.maxValue).toBe(HATCHERY_FALLBACK_CONFIG.comfort.maxValue);
  });

  it("refuses an increment of zero, which would make every step count infinite", () => {
    const config = readHatcheryConfig({
      hatchery: { temperatureConfig: { minValue: 0, maxValue: 100, increment: 0 } },
    });
    expect(config.temperature.increment).toBe(10);
  });

  it("survives static data that has no hatchery block at all", () => {
    expect(readHatcheryConfig(null).comfort.maxValue).toBe(5);
    expect(readHatcheryConfig({}).temperature.maxValue).toBe(100);
  });
});

describe("the influence ladder resets per faction", () => {
  it("charges 5 for the first rung and one more each time", () => {
    expect(influenceCost(1)).toBe(5);
    expect(influenceCost(2)).toBe(6);
    expect(influenceCost(20)).toBe(24);
  });

  it("costs 290 to take one faction all the way to 20", () => {
    expect(influenceLadderCost(MAX_INFLUENCES)).toBe(290);
  });
});

describe("fate planning", () => {
  const plenty = Object.fromEntries([73, 74, 75, 76, 77, 78, 79].map((id) => [id, 1000]));

  it("spreads across factions for 'any', and that is what makes it cheap", () => {
    const plan = planFate({ current: {}, balances: plenty, target: "any" });
    expect(plan.influencesAfter).toBe(20);
    expect(plan.guaranteed).toBe(true);
    // 6 factions x 3 rungs (18 dust each) + 1 faction x 2 rungs (11) = 119.
    expect(plan.totalDust).toBe(119);
    expect(plan.buys).toHaveLength(7);
  });

  it("charges the full single ladder when a specific faction is wanted", () => {
    const plan = planFate({ current: {}, balances: plenty, target: 3 });
    expect(plan.totalDust).toBe(290);
    expect(plan.buys).toHaveLength(1);
    expect(plan.buys[0].faction).toBe("Athena");
    expect(plan.guaranteed).toBe(true);
  });

  it("reaches 100% faction chance at the cap", () => {
    const plan = planFate({ current: {}, balances: plenty, target: "any" });
    // 20 x 4.75% faction, and the missing 5% is the Gigus share.
    expect(plan.factionChanceAfter).toBe(95);
    expect(plan.guaranteed).toBe(true);
  });

  it("counts influences already fed and only buys the remainder", () => {
    const plan = planFate({ current: { 1: 18 }, balances: plenty, target: "any" });
    expect(plan.influencesGained).toBe(2);
    expect(plan.influencesAfter).toBe(20);
    // The two cheapest rungs left are the first rungs of two fresh factions.
    expect(plan.totalDust).toBe(10);
  });

  it("stops at the dust it has and says what ran out", () => {
    const plan = planFate({ current: {}, balances: { 73: 11 }, target: 1 });
    // 5 + 6 = 11 buys two rungs; the third would cost 7.
    expect(plan.influencesAfter).toBe(2);
    expect(plan.totalDust).toBe(11);
    expect(plan.guaranteed).toBe(false);
    expect(plan.shortfall).toContain("Crusader");
  });

  it("never spends more of a dust than the balance holds", () => {
    const balances = { 73: 5, 74: 5, 75: 5 };
    const plan = planFate({ current: {}, balances, target: "any" });
    for (const buy of plan.buys) {
      expect(buy.dust).toBeLessThanOrEqual(balances[buy.itemId as 73]);
    }
    expect(plan.influencesAfter).toBe(3);
  });

  it("respects a lower cap so one egg cannot drain the dust", () => {
    const plan = planFate({
      current: {},
      balances: plenty,
      target: "any",
      maxInfluences: 5,
    });
    expect(plan.influencesAfter).toBe(5);
    expect(plan.guaranteed).toBe(false);
  });
});

describe("reading incubation fields out of an unknown response shape", () => {
  it("matches whichever casing the API uses", () => {
    expect(findNumber({ TEMPERATURE_CID: 40 }, /^(temperature|temp)/i)).toBe(40);
    expect(findNumber({ temperature: 40 }, /^(temperature|temp)/i)).toBe(40);
    expect(findNumber({ data: { comfort: 3 } }, /comfort/i)).toBe(3);
  });

  it("returns null rather than a zero when the field is absent", () => {
    expect(findNumber({ progress: 10 }, /comfort/i)).toBeNull();
    expect(findNumber(null, /comfort/i)).toBeNull();
  });

  it("does not hang on a response that references itself", () => {
    const cyclic: Record<string, unknown> = { comfort: 2 };
    cyclic.self = cyclic;
    expect(findNumber(cyclic, /comfort/i)).toBe(2);
  });

  it("reads fate from a keyed map", () => {
    expect(findFate({ fate: { "1": 3, "5": 2 } })).toEqual({ 1: 3, 5: 2 });
  });

  it("reads fate from the parallel-array style used elsewhere in this API", () => {
    expect(
      findFate({ FACTION_ID_CID_array: [1, 4], INFLUENCE_AMOUNT_CID_array: [3, 1] })
    ).toEqual({ 1: 3, 4: 1 });
  });
});

describe("a stale column must not beat the live value", () => {
  it("collects every matching field, not just the first", () => {
    const found = findNumberCandidates(
      { TEMPERATURE_CID: 0, data: { temperature: 60 } },
      /^(temperature|temp)/i
    );
    expect(found).toEqual([
      { path: "TEMPERATURE_CID", value: 0 },
      { path: "data.temperature", value: 60 },
    ]);
  });

  it("discards an out-of-range candidate — this is what separates rarity from quality", () => {
    const reading = pickStat(
      [
        { path: "RARITY_CID", value: 3 },
        { path: "quality", value: 62 },
      ],
      { minValue: 10, maxValue: 100, increment: 1 }
    );
    expect(reading.value).toBe(62);
    expect(reading.chosen).toBe("quality");
    expect(reading.ambiguous).toBe(false);
  });

  it("reads the 1-6 rarity trait as quality only when nothing better matched", () => {
    // A pet NFT's RARITY_CID is the Gigling's trait tier, not the 0-100 bar.
    const withQuality = normalizeEgg({ docId: "1", RARITY_CID: 3, quality: 62 });
    expect(withQuality.quality).toBe(62);
  });

  it("flags a stat two in-range fields could have supplied instead of asserting one", () => {
    const egg = normalizeEgg({ docId: "1", TEMPERATURE_CID: 0, data: { temperature: 60 } });
    expect(egg.ambiguous).toContain("temperature");
    expect(egg.readings.temperature.candidates).toHaveLength(2);
    // Both are legal temperatures, so bounds cannot separate them and the
    // reading has to be reported as a guess rather than as fact.
    expect(egg.readings.temperature.chosen).toBe("TEMPERATURE_CID");
  });

  it("stays unambiguous when only one field matches", () => {
    const egg = normalizeEgg({ docId: "1", temperature: 60, comfort: 4 });
    expect(egg.ambiguous).toHaveLength(0);
    expect(egg.temperature).toBe(60);
  });

  it("uses the live bounds, so a comfort of 60 cannot be read off a 0-5 stat", () => {
    const egg = normalizeEgg({
      docId: "1",
      COMFORT_PCT_CID: 60,
      data: { comfort: 4 },
    });
    expect(egg.comfort).toBe(4);
  });

  it("keeps the raw entity so the inspector can show what arrived", () => {
    const raw = { docId: "1", temperature: 60 };
    expect(normalizeEgg(raw).raw).toBe(raw);
  });
});

describe("the live incubation block", () => {
  // Verbatim from /api/pets/player?id= on 2026-08-12, for an egg the game was
  // showing as Temp 72/100, Comfort 2/5, Fate 12/20, Quality 8.65%.
  const liveIncubating = {
    docId: "4442",
    NAME_CID: "#4442",
    DESCRIPTION_CID: "Egg",
    TYPE_CID: "Steed",
    data: {
      eggType: "Inaugural Steed",
      hatcheryStatus: {
        progress: 29,
        rarity: 8.65,
        temperature: {
          current: 72,
          max: 100,
          nextDayIncreaseRate: 2.5,
          itemsForNextIncrement: { ID_CID: 577, BALANCE_CID: 3 },
        },
        comfort: {
          current: 2,
          max: 5,
          nextDayIncreaseRate: 1,
          itemsForNextIncrement: { ID_CID: 579, BALANCE_CID: 2 },
        },
        fate: {
          probabilities: [40, 0, 0, 57, 0, 0, 0, 0, 3],
          upgrades: [0, 0, 0, 12, 0, 0, 0, 0, 0],
          lastInfluenceDay: 20663,
          interactionCount: 12,
          temperatureRequirement: 0,
          meetsTemperatureRequirement: true,
          max: 20,
          canInfluenceToday: true,
          canInfluence: true,
          incPerInput: 4.75,
          gigusIncPerInput: 0.25,
          itemsForNextIncrement: [
            { FACTION_CID: 1, ID_CID: 73, BALANCE_CID: 5 },
            { FACTION_CID: 3, ID_CID: 75, BALANCE_CID: 17 },
          ],
        },
      },
    },
  };

  it("reads the stats the page was reporting as missing", () => {
    // The stats are objects, so the old key-name scan walked into
    // `temperature` and found only `current`, `max` and `nextDayIncreaseRate`.
    const e = normalizeEgg(liveIncubating);
    expect(e.temperature).toBe(72);
    expect(e.comfort).toBe(2);
    expect(e.progress).toBe(29);
    expect(e.quality).toBe(8.65);
    expect(e.missing).toHaveLength(0);
    expect(e.ambiguous).toHaveLength(0);
  });

  it("names the exact path each stat came from, so the inspector still explains", () => {
    const e = normalizeEgg(liveIncubating);
    expect(e.readings.temperature.chosen).toBe("data.hatcheryStatus.temperature.current");
    expect(e.readings.quality.chosen).toBe("data.hatcheryStatus.rarity");
  });

  it("carries the game's price for the next increment of each stat", () => {
    const e = normalizeEgg(liveIncubating);
    // Biofuel+, not the plain Biofuel a grade-order plan would have reached for.
    expect(e.nextIncrement.temperature).toEqual({ itemId: 577, amount: 3 });
    expect(e.nextIncrement.comfort).toEqual({ itemId: 579, amount: 2 });
  });

  it("reads the daily rates the game prints beside the two bars", () => {
    const e = normalizeEgg(liveIncubating);
    expect(e.progressPerDay).toBe(2.5);
    expect(e.qualityPerDay).toBe(1);
  });

  it("indexes fate by faction id rather than packing the array densely", () => {
    const e = normalizeEgg(liveIncubating);
    // upgrades[3] = 12 is Athena's, and the arithmetic proves the indexing:
    // probabilities[3] = 57 is 12 x 4.75, and probabilities[8] = 3 is 12 x 0.25.
    expect(e.fate).toEqual({ 3: 12 });
    expect(e.influences).toBe(12);
    expect(e.fateStatus?.max).toBe(20);
    expect(e.fateStatus?.nextCost[3]).toEqual({ itemId: 75, amount: 17 });
  });

  it("agrees with the influence ladder this app computes independently", () => {
    // 12 influences already in means the 13th costs 17, which is exactly what
    // the API quoted for that faction.
    expect(influenceCost(13)).toBe(17);
  });

  it("marks an egg with no incubation block as not incubating", () => {
    const inBag = {
      docId: "24679",
      NAME_CID: "#24679",
      DESCRIPTION_CID: "Egg",
      data: { eggType: "Silver ROM" },
    };
    expect(normalizeEgg(inBag).incubating).toBe(false);
    expect(normalizeEgg(liveIncubating).incubating).toBe(true);
  });

  it("finds both eggs in a pets response with no separate hatchery read", () => {
    const eggs = collectEggs({ entities: [liveIncubating] }, null);
    expect(eggs).toHaveLength(1);
    expect(eggs[0].temperature).toBe(72);
    expect(eggs[0].incubating).toBe(true);
  });

  it("does not let an inventory-only overlay blank a fully read egg", () => {
    const eggs = collectEggs(
      { entities: [liveIncubating] },
      { entities: [{ docId: "4442", NAME_CID: "#4442" }] }
    );
    expect(eggs[0].temperature).toBe(72);
    expect(eggs[0].missing).toHaveLength(0);
  });
});

describe("normalizing one egg", () => {
  // Shape taken from a live /api/pets/player?id= response.
  const liveEgg = {
    docId: "4111",
    NAME_CID: "#4111",
    DESCRIPTION_CID: "Egg",
    TYPE_CID: "Steed",
    data: { eggType: "Inaugural Steed" },
  };

  it("keeps the identity fields that a feed call needs", () => {
    const egg = normalizeEgg(liveEgg);
    expect(egg.petId).toBe("4111");
    expect(egg.eggType).toBe("Inaugural Steed");
    expect(egg.hatched).toBe(false);
  });

  it("reports what it could not read instead of defaulting to zero", () => {
    const egg = normalizeEgg(liveEgg);
    expect(egg.temperature).toBeNull();
    expect(egg.comfort).toBeNull();
    expect(egg.missing).toContain("comfort");
    expect(egg.missing).toContain("temperature");
  });

  it("treats a hatched pet as hatched from either signal", () => {
    expect(normalizeEgg({ docId: "1", COMPLETE_CID: true }).hatched).toBe(true);
    expect(
      normalizeEgg({ docId: "2", data: { hatchedAt: "2025-12-09T03:18:33.274Z" } }).hatched
    ).toBe(true);
  });
});

describe("merging the pet inventory with the hatchery response", () => {
  const pets = {
    entities: [
      { docId: "1", NAME_CID: "#1", DESCRIPTION_CID: "Egg", data: { eggType: "ROM Egg" } },
      { docId: "2", NAME_CID: "#2", COMPLETE_CID: true, data: { hatchedAt: "2026-01-01" } },
    ],
  };

  it("layers incubation detail onto the inventory without losing egg type", () => {
    const eggs = collectEggs(pets, {
      entities: [{ docId: "1", temperature: 60, comfort: 4, progress: 30, quality: 22 }],
    });
    expect(eggs).toHaveLength(1);
    expect(eggs[0].eggType).toBe("ROM Egg");
    expect(eggs[0].temperature).toBe(60);
    expect(eggs[0].comfort).toBe(4);
  });

  it("drops hatched pets — they are not incubation targets", () => {
    expect(collectEggs(pets, null).map((e) => e.petId)).toEqual(["1"]);
  });

  it("still lists eggs when the hatchery response is missing entirely", () => {
    const eggs = collectEggs(pets, null);
    expect(eggs).toHaveLength(1);
    expect(eggs[0].missing).toContain("temperature");
  });

  it("keeps an egg that only the hatchery knows about", () => {
    const eggs = collectEggs(
      { entities: [] },
      { entities: [{ docId: "9", temperature: 10, comfort: 1, progress: 5 }] }
    );
    expect(eggs.map((e) => e.petId)).toEqual(["9"]);
  });
});

describe("material catalogue", () => {
  it("orders each stat's materials from the cheap grade upward", () => {
    expect(materialsFor("comfort").map((m) => m.name)).toEqual([
      "Incube",
      "Incube+",
      "Incube++",
    ]);
    expect(materialsFor("temperature").map((m) => m.name)).toEqual(["Biofuel", "Biofuel+"]);
  });

  it("carries the Vilhelm trade that mints each one", () => {
    const incube = materialsFor("comfort")[0];
    expect(incube.recipeId).toBe("500003");
    expect(incube.input).toEqual({ itemId: 23, name: "Bone", amount: 2 });
  });
});
