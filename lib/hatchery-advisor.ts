// Hatchery advisor: turns the eggs currently incubating, plus what is in the
// inventory, into an ordered list of feeds and a set of alerts.
//
// Three rules do most of the work, and all three come from the same fact —
// Temperature drives Progress, and Comfort plus Progress drive Quality:
//
//   1. Comfort is funded before Temperature. A cold egg is slow; an
//      uncomfortable egg is permanently worse, because Quality is banked as
//      Progress accrues and cannot be re-earned later.
//   2. Comfort goes to the youngest eggs first. An egg at 10% progress has 90%
//      of its Quality still to bank, so a unit of Comfort buys nine times what
//      it buys on an egg at 90%.
//   3. Temperature goes to the oldest eggs first. Temperature only buys speed,
//      so it is worth most where it finishes something and frees the slot.
//
// What a feed costs is not guessed here. Each egg's incubation block quotes the
// item and quantity that buys its next increment, and the quote does not always
// name the cheap grade — an egg at 72/100 temperature was quoted 3x Biofuel+
// while plain Biofuel sat unused in the bag. Only that next increment is
// quoted, so a plan spanning several of them assumes the price holds and says
// so.

import {
  EGGSPEDITORS,
  HATCHERY_MATERIALS,
  MAX_INFLUENCES,
  materialById,
  planFate,
  type EggStat,
  type EggState,
  type FatePlan,
  type HatcheryConfig,
} from "./hatchery";

export interface Feed {
  itemId: number;
  name: string;
  stat: EggStat;
  /** Units to feed — the game's quoted price, times the increments planned */
  amount: number;
  /** Increments of the stat those units buy */
  increments: number;
  reason: string;
}

export interface EggPlan {
  petId: string;
  name: string;
  eggType: string | null;
  progress: number | null;
  quality: number | null;
  temperature: number | null;
  comfort: number | null;
  /** Daily progress and quality gain at the egg's current stats */
  progressPerDay: number | null;
  qualityPerDay: number | null;
  feeds: Feed[];
  /**
   * The game's quote for the next increment of each stat.
   *
   * The plan spends it, but the manual controls need it too: a hand-driven feed
   * has to name the same item and quantity the game asked for.
   */
  nextIncrement: EggState["nextIncrement"];
  fate: FatePlan | null;
  /** Influences already banked, by faction id — what the next one extends. */
  fateCurrent: Record<number, number>;
  /** The game's own quote for the next influence, per faction. */
  fateStatus: EggState["fateStatus"];
  status: "ready" | "incubating" | "stalled" | "unreadable" | "idle";
  alerts: string[];
  notes: string[];
  /** Which field each reading came from, and what else matched */
  readings: EggState["readings"];
  /** Stats whose field could not be identified unambiguously */
  ambiguous: EggState["ambiguous"];
  /** The entity as it arrived, for the field inspector */
  raw: unknown;
}

export interface CraftSuggestion {
  recipeId: string;
  /** What the trade mints */
  itemId: number;
  name: string;
  /** Completions to run */
  runs: number;
  input: { itemId: number; name: string; amount: number };
  /** Base material the runs consume in total */
  inputTotal: number;
  /** Base material actually on hand */
  inputHeld: number;
  reason: string;
}

export interface HatcheryAdvice {
  eggs: EggPlan[];
  /** Eggs at full progress — these are the "go hatch it" alerts */
  readyToHatch: EggPlan[];
  /** Every feed across every egg, in the order they should be applied */
  feedOrder: { petId: string; feed: Feed }[];
  /** Net material spend the whole plan implies */
  spend: { itemId: number; name: string; amount: number }[];
  craft: CraftSuggestion[];
  notes: string[];
  warnings: string[];
}

export interface HatcheryAdvisorInput {
  eggs: EggState[];
  /** Item balances keyed by item id */
  balances: Record<number, number>;
  config: HatcheryConfig;
  /**
   * Which faction the Giglings should hatch as, or "any" for the cheap route to
   * a guaranteed faction trait.
   */
  fateTarget: number | "any";
}

/** What a stat gap needs that the inventory could not cover. */
interface Shortfall {
  itemId: number;
  name: string;
  /** Units still missing */
  units: number;
}

function itemName(itemId: number): string {
  return materialById(itemId)?.name ?? `#${itemId}`;
}

/**
 * Draw units for one egg's stat from the shared pool at the game's quoted price.
 *
 * The quote covers one increment. Closing the whole gap therefore assumes the
 * same item at the same price for every increment left, which is what makes the
 * "trade for this much" advice possible at all — but it is an assumption, and
 * the item can plainly change with grade, so the plan says which part of it was
 * quoted and which was extrapolated.
 */
function drawFeeds(
  stat: EggStat,
  egg: EggState,
  deficit: number,
  increment: number,
  pool: Record<number, number>,
  reason: string
): { feeds: Feed[]; closed: number; short: Shortfall | null } {
  const quote = egg.nextIncrement[stat];
  if (!quote || quote.amount <= 0 || increment <= 0) {
    return { feeds: [], closed: 0, short: null };
  }

  const steps = Math.ceil(deficit / increment);
  const needed = steps * quote.amount;
  const held = pool[quote.itemId] ?? 0;
  const take = Math.min(steps, Math.floor(held / quote.amount));
  const name = itemName(quote.itemId);

  // What is short is what the gap needs beyond the whole stock, not beyond the
  // increments the stock can complete: two of the three Incube+ an increment
  // costs are still two fewer to trade for.
  const short: Shortfall | null =
    needed > held ? { itemId: quote.itemId, name, units: needed - held } : null;

  // A remainder too small to buy an increment is left earmarked rather than
  // offered to the next egg, since it is already part-paid toward this one.
  pool[quote.itemId] = short ? 0 : held - needed;

  if (take <= 0) return { feeds: [], closed: 0, short };
  return {
    feeds: [
      {
        itemId: quote.itemId,
        name,
        stat,
        amount: take * quote.amount,
        increments: take,
        reason,
      },
    ],
    closed: Math.min(deficit, take * increment),
    short,
  };
}

function statLine(value: number | null, max: number): string {
  return value === null ? "unknown" : `${value}/${max}`;
}

export function buildHatcheryAdvice(input: HatcheryAdvisorInput): HatcheryAdvice {
  const { config } = input;
  const pool: Record<number, number> = { ...input.balances };
  const startingPool: Record<number, number> = { ...input.balances };
  const notes: string[] = [];
  const warnings: string[] = [];
  /** Units of each item the whole plan came up short on, for the trade advice */
  const shortByItem = new Map<number, number>();
  /** The same shortfalls grouped by stat, because the two mean different things */
  const shortByStat = new Map<EggStat, { eggs: number; units: number; names: Set<string> }>();
  const noteShortfall = (stat: EggStat, short: Shortfall | null) => {
    if (!short) return;
    shortByItem.set(short.itemId, (shortByItem.get(short.itemId) ?? 0) + short.units);
    const bucket = shortByStat.get(stat) ?? { eggs: 0, units: 0, names: new Set<string>() };
    bucket.eggs += 1;
    bucket.units += short.units;
    bucket.names.add(short.name);
    shortByStat.set(stat, bucket);
  };

  const live = input.eggs.filter((e) => !e.hatched);
  const plans = new Map<string, EggPlan>();
  for (const egg of live) {
    plans.set(egg.petId, {
      petId: egg.petId,
      name: egg.name,
      eggType: egg.eggType,
      progress: egg.progress,
      quality: egg.quality,
      temperature: egg.temperature,
      comfort: egg.comfort,
      progressPerDay: egg.progressPerDay,
      qualityPerDay: egg.qualityPerDay,
      feeds: [],
      nextIncrement: egg.nextIncrement,
      fate: null,
      fateCurrent: egg.fate,
      fateStatus: egg.fateStatus,
      status: "incubating",
      alerts: [],
      notes: [],
      readings: egg.readings,
      ambiguous: egg.ambiguous,
      raw: egg.raw,
    });
  }

  if (live.length === 0) {
    return {
      eggs: [],
      readyToHatch: [],
      feedOrder: [],
      spend: [],
      craft: [],
      notes: ["No eggs are incubating. Nothing to maintain."],
      warnings: [],
    };
  }

  if (live.length > config.maxPetsInHatchery) {
    warnings.push(
      `${live.length} eggs are in the hatchery but it holds ${config.maxPetsInHatchery}.`
    );
  }

  /* ── Ready to hatch, and eggs the response didn't describe ── */

  const readable: EggState[] = [];
  for (const egg of live) {
    const plan = plans.get(egg.petId)!;

    if (egg.progress !== null && egg.progress >= config.maxProgress) {
      plan.status = "ready";
      plan.alerts.push(
        `Ready to hatch at ${config.maxProgress}% progress` +
          (egg.quality !== null ? `, quality ${egg.quality}/${config.maxQuality}` : "") +
          `. Feeding it more does nothing — hatch it and free the slot.`
      );
      if (egg.influences < MAX_INFLUENCES) {
        plan.alerts.push(
          `Fate is only ${egg.influences}/${MAX_INFLUENCES}, so this Gigling can still hatch factionless. Dust has to go in before the hatch, not after.`
        );
      }
      continue;
    }

    // An egg in the bag that was never placed in the hatchery. It has no stats
    // because it has no incubation, which is a different thing from a response
    // this app failed to read — and the fix is a click in game, not a parser.
    if (!egg.incubating) {
      plan.status = "idle";
      plan.alerts.push(
        `Not in the hatchery — this egg is sitting in the inventory and gains nothing until it's placed.`
      );
      continue;
    }

    // An egg whose stats didn't come back is left alone on purpose. Reading a
    // missing Comfort as 0 would spend the whole Incube stock on an egg that
    // may already be at 5.
    if (egg.missing.includes("temperature") && egg.missing.includes("comfort")) {
      plan.status = "unreadable";
      plan.alerts.push(
        `No temperature or comfort in the hatchery response for this egg, so it gets no feed plan — guessing would spend materials on stats that may already be full.`
      );
      continue;
    }

    // A stat that more than one in-range field could have supplied is a guess,
    // and a wrong guess here spends materials on a stat that is already full.
    // Say which field was believed rather than presenting the number as fact.
    for (const key of egg.ambiguous) {
      const reading = egg.readings[key];
      plan.notes.push(
        `${key} was read from \`${reading.chosen}\`, but ${reading.candidates.length} fields matched (${reading.candidates
          .map((c) => `${c.path}=${c.value}`)
          .join(", ")}). If the number looks wrong, this is why.`
      );
    }

    readable.push(egg);
  }

  /* ── 1. Comfort, youngest eggs first ── */

  const byProgressAsc = [...readable].sort(
    (a, b) => (a.progress ?? 0) - (b.progress ?? 0)
  );
  for (const egg of byProgressAsc) {
    if (egg.comfort === null) continue;
    const deficit = config.comfort.maxValue - egg.comfort;
    if (deficit <= 0) continue;

    const remainingProgress =
      egg.progress === null ? null : config.maxProgress - egg.progress;
    const reason =
      remainingProgress === null
        ? "Comfort decides the quality banked as the egg progresses."
        : `${remainingProgress}% of progress still to bank at this comfort.`;

    const { feeds, closed, short } = drawFeeds(
      "comfort",
      egg,
      deficit,
      config.comfort.increment,
      pool,
      reason
    );
    const plan = plans.get(egg.petId)!;
    plan.feeds.push(...feeds);
    noteShortfall("comfort", short);
    if (short) {
      plan.notes.push(
        `Comfort stops at ${(egg.comfort + closed).toFixed(0)}/${config.comfort.maxValue} — ${short.units} more ${short.name} would finish it.`
      );
    }
  }

  /* ── 2. Temperature, oldest eggs first ── */

  const byProgressDesc = [...readable].sort(
    (a, b) => (b.progress ?? 0) - (a.progress ?? 0)
  );
  for (const egg of byProgressDesc) {
    if (egg.temperature === null) continue;
    const deficit = config.temperature.maxValue - egg.temperature;
    const plan = plans.get(egg.petId)!;

    if (egg.temperature <= config.temperature.minValue) {
      plan.status = "stalled";
      plan.alerts.push(
        `Temperature is at ${egg.temperature} — progress has stopped entirely until it's fuelled.`
      );
    }
    if (deficit <= 0) continue;

    const { feeds, closed, short } = drawFeeds(
      "temperature",
      egg,
      deficit,
      config.temperature.increment,
      pool,
      egg.progressPerDay !== null
        ? `Progress is running at ${egg.progressPerDay}%/day at this temperature.`
        : "Temperature is what makes progress move at all.",
    );
    plan.feeds.push(...feeds);
    noteShortfall("temperature", short);
    if (short) {
      plan.notes.push(
        `Temperature stops at ${egg.temperature + closed}/${config.temperature.maxValue} — ${short.units} more ${short.name} would finish it.`
      );
    }
  }

  /* ── 3. Fate, eggs closest to hatching first ── */
  // Dust is a separate pool from the incubation materials, so this competes
  // only with the other eggs. Nearest to hatching goes first because that is
  // the egg whose window to spend dust at all closes soonest.

  for (const egg of byProgressDesc) {
    const plan = plans.get(egg.petId)!;
    const fate = planFate({
      current: egg.fate,
      balances: pool,
      target: input.fateTarget,
    });
    plan.fate = fate;

    for (const buy of fate.buys) {
      pool[buy.itemId] = (pool[buy.itemId] ?? 0) - buy.dust;
    }

    if (egg.missing.includes("fate") && egg.influences === 0 && !egg.fateStatus) {
      plan.notes.push(
        `The response carried no fate data, so this plan assumes no dust has gone in yet. If some has, it will cost less than shown.`
      );
    }

    // Two gates the game applies to influencing that no amount of dust gets
    // around, so a plan that ignores them reads as buyable when it isn't.
    // The in-game tooltip ties the daily one to progress: fate "only can be
    // increased on a day Progress will increase", which is why a cold egg is
    // also a locked one.
    if (egg.fateStatus && !egg.fateStatus.canInfluenceToday && fate.influencesGained > 0) {
      plan.notes.push(
        `The game is refusing influences on this egg today, so the dust above can't go in yet. Fate only moves on a day progress moves.`
      );
    }
    if (egg.fateStatus && !egg.fateStatus.meetsTemperatureRequirement) {
      plan.alerts.push(
        `Fate is locked until temperature reaches ${egg.fateStatus.temperatureRequirement} — dust can't go in at ${egg.temperature ?? "?"}.`
      );
    }

    if (!fate.guaranteed && egg.progress !== null && egg.progress >= config.maxProgress * 0.75) {
      plan.alerts.push(
        `This egg is ${egg.progress}% along with fate at ${fate.influencesAfter}/${MAX_INFLUENCES} — buy the rest of the influences now or it may hatch factionless.`
      );
    }
  }

  /* ── Eggspeditors already in the bag ── */

  for (const egg of readable) {
    const plan = plans.get(egg.petId)!;
    if (egg.quality === null) continue;
    const useful = EGGSPEDITORS.filter(
      (e) => (pool[e.itemId] ?? 0) > 0 && e.qualityFloor > egg.quality!
    );
    if (useful.length === 0) continue;
    const best = useful[useful.length - 1];
    plan.notes.push(
      `You hold ${best.name}, which would finish this egg and lift quality from ${egg.quality} to ${best.qualityFloor}.`
    );
  }

  /* ── Spend, shortfalls and what to trade for ── */

  const spendById = new Map<number, number>();
  for (const plan of plans.values()) {
    for (const feed of plan.feeds) {
      spendById.set(feed.itemId, (spendById.get(feed.itemId) ?? 0) + feed.amount);
    }
  }
  const spend = Array.from(spendById, ([itemId, amount]) => ({
    itemId,
    name: HATCHERY_MATERIALS.find((m) => m.itemId === itemId)?.name ?? `#${itemId}`,
    amount,
  })).sort((a, b) => a.name.localeCompare(b.name));

  for (const stat of ["comfort", "temperature"] as const) {
    const bucket = shortByStat.get(stat);
    if (!bucket) continue;
    warnings.push(
      `${bucket.eggs} egg${bucket.eggs === 1 ? "" : "s"} can't reach full ${stat} — ${bucket.units} more ${[...bucket.names].join(" / ")} short.` +
        (stat === "comfort"
          ? " That is quality being lost while they progress, not just time."
          : " That is progress running slower than it could, not a permanent loss.")
    );
  }

  // One trade per item that ran out, sized to the shortfall. The item is the
  // game's choice rather than this app's, so there is nothing to pick between
  // grades here — only the question of whether the base material is on hand.
  const craft: CraftSuggestion[] = [];
  for (const [itemId, units] of shortByItem) {
    const material = materialById(itemId);
    if (!material) continue;
    const runs = Math.ceil(units / material.output);
    const inputTotal = runs * material.input.amount;
    const inputHeld = startingPool[material.input.itemId] ?? 0;
    craft.push({
      recipeId: material.recipeId,
      itemId: material.itemId,
      name: material.name,
      runs,
      input: material.input,
      inputTotal,
      inputHeld,
      reason:
        inputHeld >= inputTotal
          ? `Covers the ${units} you're short from ${material.input.name} you already hold.`
          : `Covers the ${units} you're short, but you are ${inputTotal - inputHeld} ${material.input.name} short of running it — the dungeon is where that comes from.`,
    });
  }

  /* ── Summary ── */

  const eggs = Array.from(plans.values());
  const ready = eggs.filter((e) => e.status === "ready");
  const feedOrder: { petId: string; feed: Feed }[] = [];
  // Comfort across every egg before any temperature, so a short inventory
  // spends itself on the permanent stat first.
  for (const stat of ["comfort", "temperature"] as const) {
    for (const plan of eggs) {
      for (const feed of plan.feeds.filter((f) => f.stat === stat)) {
        feedOrder.push({ petId: plan.petId, feed });
      }
    }
  }

  if (ready.length > 0) {
    notes.push(
      `${ready.length} egg${ready.length === 1 ? " is" : "s are"} at full progress and waiting to be hatched.`
    );
  }

  const totalDust = eggs.reduce((s, e) => s + (e.fate?.totalDust ?? 0), 0);
  if (totalDust > 0) {
    const guaranteed = eggs.filter((e) => e.fate?.guaranteed).length;
    notes.push(
      input.fateTarget === "any"
        ? `${totalDust} faction dust across the cheap rungs of several factions takes ${guaranteed}/${eggs.length} eggs to a guaranteed faction trait. Concentrating on one faction costs about 2.5x as much for the same guarantee, and is only worth it if you want that specific faction.`
        : `${totalDust} dust of the target faction. Every influence has to come from the same ladder, which is why this costs far more than "any faction".`
    );
  }

  const extrapolated = eggs.some((e) => e.feeds.some((f) => f.increments > 1));
  if (extrapolated) {
    notes.push(
      `The game quotes the price of the next increment only. Any plan longer than one increment assumes that item and price hold for the rest, so re-check after feeding — if the grade steps up, the later feeds cost something else.`
    );
  }

  for (const plan of eggs) {
    for (const alert of plan.alerts) {
      if (plan.status === "ready") continue;
      warnings.push(`${plan.name}: ${alert}`);
    }
  }

  const unreadable = eggs.filter((e) => e.status === "unreadable").length;
  if (unreadable > 0) {
    warnings.push(
      `${unreadable} egg${unreadable === 1 ? "" : "s"} came back with no temperature or comfort. Check that the hatchery response is being read correctly before trusting anything else on this page.`
    );
  }

  const statSummary = readable
    .map(
      (e) =>
        `${e.name} ${statLine(e.progress, config.maxProgress)} progress, ` +
        `${statLine(e.temperature, config.temperature.maxValue)} temp, ` +
        `${statLine(e.comfort, config.comfort.maxValue)} comfort`
    )
    .join("; ");
  if (statSummary) notes.push(statSummary);

  return { eggs, readyToHatch: ready, feedOrder, spend, craft, notes, warnings };
}
