import type {
  DungeonAction,
  DungeonActionResponse,
  Player,
  LootOption,
  RewardPathOption,
  EnemyPathOption,
} from "./types";
import { predictEnemyMove, readEnemyCharges, spendCharge, enemyMoveAtk } from "./enemy-predict";
import type { CombatMove, EnemyCharges } from "./enemy-predict";

type LootAction = "loot_one" | "loot_two" | "loot_three" | "loot_four";
type RewardAction = "reward_one" | "reward_two" | "reward_three";
type PathAction = "path_one" | "path_two" | "path_three";

const COMBAT_MOVES: CombatMove[] = ["rock", "paper", "scissor"];

/** Below this, a prediction is a guess rather than information and is ignored. */
const USABLE_CONFIDENCE = 0.4;
const LOOT_ACTIONS: LootAction[] = ["loot_one", "loot_two", "loot_three", "loot_four"];
const REWARD_ACTIONS: RewardAction[] = ["reward_one", "reward_two", "reward_three"];
const PATH_ACTIONS: PathAction[] = ["path_one", "path_two", "path_three"];

/** Rooms in a full Awakening run — matches maxRoom on /api/game/dungeon/today. */
const TOTAL_ROOMS = 16;

/**
 * Points per Hard Core when weighed against a boon's score.
 *
 * Cores are collected at a reward screen after every room clear, so a boon that
 * buys another room is itself worth Cores. This constant sets where the two
 * meet: at 4, a typical spread between reward options (~8 Cores) is worth about
 * 32 points, which loses to a typical boon gap early in a run and wins late,
 * crossing over around room 9. It is an estimate — the honest way to tune it is
 * against recorded Cores-per-run, which the run history already stores.
 */
const CORE_WEIGHT = 4;

export const MOVE_LABELS: Record<string, string> = {
  rock: "Sword",
  paper: "Shield",
  scissor: "Spell",
};

/* ─── Scoring ──────────────────────────────────────────────── */

export function evaluateState(state: DungeonActionResponse): number {
  const run = state.data?.run;
  const entity = state.data?.entity;
  if (!run || !run.players?.[0]) return 0;

  const player = run.players[0];
  const enemiesDefeated = entity?.ROOM_NUM_CID ?? 0;
  const hpRatio = player.health.current / (player.health.currentMax || 1);
  const armorRatio = player.shield.current / (player.shield.currentMax || 1);

  const moveScores = COMBAT_MOVES.map(
    (m) => player[m].currentATK * 2 + player[m].currentDEF
  ).sort((a, b) => b - a);
  const top2Synergy = (moveScores[0] + moveScores[1]) * 0.01;

  const spamPenalties = COMBAT_MOVES.filter(
    (m) => player[m].currentCharges === -1
  ).length;

  return enemiesDefeated + hpRatio * 2 + armorRatio + top2Synergy - spamPenalties * 0.3;
}

/* ─── DP combat move selection (4-round lookahead) ───────── */

// Beats map: what move beats what (winner → loser)
const BEATS: Record<CombatMove, CombatMove> = {
  rock: "scissor",    // Sword beats Spell
  paper: "rock",      // Shield beats Sword
  scissor: "paper",   // Spell beats Shield
};

type SimCharges = EnemyCharges;

function cloneCharges(player: Player): SimCharges {
  return {
    rock: player.rock.currentCharges,
    paper: player.paper.currentCharges,
    scissor: player.scissor.currentCharges,
  };
}

// Charge bookkeeping is identical for both sides, so it lives in enemy-predict
// alongside the prediction that depends on it.
const simUpdateCharges = spendCharge;

/** Outcome of one round against a known enemy move. */
function outcome(
  playerMove: CombatMove,
  enemyMove: CombatMove,
  playerATK: number,
  playerDEF: number,
  enemyATK: number
): number {
  if (playerMove === enemyMove) {
    // Both deal ATK, both gain DEF — net result depends on the ATK difference
    return playerATK - enemyATK + playerDEF;
  }
  if (BEATS[playerMove] === enemyMove) {
    // We deal ATK damage and gain DEF shield, the enemy gains nothing
    return playerATK * 3 + playerDEF;
  }
  // We take enemyATK damage and gain nothing
  return -enemyATK * 2;
}

/**
 * Probability the enemy plays each move.
 *
 * With a usable read the mass concentrates on that move and the remainder is
 * spread over the other playable ones. Without a read it is uniform over
 * whatever they still have charges for — which is not the same as "no
 * information": their per-move ATK differs, so which of their moves can punish
 * us still depends on what we play.
 */
function enemyMoveDistribution(
  available: CombatMove[],
  predicted: CombatMove | null,
  confidence: number
): Partial<Record<CombatMove, number>> {
  const dist: Partial<Record<CombatMove, number>> = {};
  if (available.length === 0) return dist;

  const uniform = 1 / available.length;
  if (predicted && available.includes(predicted) && confidence > uniform) {
    const rest = available.filter((m) => m !== predicted);
    dist[predicted] = confidence;
    for (const m of rest) dist[m] = (1 - confidence) / rest.length;
    return dist;
  }
  for (const m of available) dist[m] = uniform;
  return dist;
}

/**
 * Expected score for playing `playerMove`, taken over the enemy's move
 * distribution. Replaces the old branch that ignored the enemy entirely
 * whenever confidence was too low to name a single move — that discarded the
 * enemy's ATK spread, which is real information even against a coin flip.
 */
function scoreRound(
  playerMove: CombatMove,
  playerATK: number,
  playerDEF: number,
  dist: Partial<Record<CombatMove, number>>,
  enemyAtkByMove: Record<CombatMove, number>
): number {
  let expected = 0;
  for (const enemyMove of COMBAT_MOVES) {
    const p = dist[enemyMove];
    if (!p) continue;
    expected += p * outcome(playerMove, enemyMove, playerATK, playerDEF, enemyAtkByMove[enemyMove]);
  }
  return expected;
}

const LOOKAHEAD = 4;

/**
 * DP search: evaluate all possible move sequences up to LOOKAHEAD rounds.
 * Returns the best first move and an explanation.
 */
function pickSmartCombatMove(
  player: Player,
  enemy: Player | null,
  enemyBaseStats?: number[]
): { move: CombatMove | null; reason: string } {
  // Get available moves
  const available = COMBAT_MOVES.filter((m) => player[m].currentCharges > 0);
  if (available.length === 0) {
    // Every move is locked out. Sending one anyway is rejected outright, so
    // report no action and let the caller refetch state instead.
    return { move: null, reason: "no move has charges" };
  }

  // If only one option, no need to search
  if (available.length === 1) {
    return { move: available[0], reason: `only option (${player[available[0]].currentATK} ATK)` };
  }

  // Per-move ATK for this enemy, used to weight how much each of their moves
  // would actually cost us.
  const enemyAtkByMove = {
    rock: enemyMoveAtk(enemy, enemyBaseStats, "rock"),
    paper: enemyMoveAtk(enemy, enemyBaseStats, "paper"),
    scissor: enemyMoveAtk(enemy, enemyBaseStats, "scissor"),
  } as Record<CombatMove, number>;

  // Project the enemy's charges across the lookahead window. Each round we
  // predict from their remaining charges, then assume they play that move and
  // spend the charge — so a depleting enemy narrows toward a forced move the
  // search can actually exploit.
  const enemyPredictions: {
    dist: Partial<Record<CombatMove, number>>;
    move: CombatMove | null;
    confidence: number;
  }[] = [];
  let enemyCharges = readEnemyCharges(enemy);
  for (let r = 0; r < LOOKAHEAD; r++) {
    const pred = predictEnemyMove(enemyCharges, enemy, enemyBaseStats);
    const usable = pred.move && pred.confidence >= USABLE_CONFIDENCE ? pred.move : null;
    enemyPredictions.push({
      dist: enemyMoveDistribution(pred.available, usable, pred.confidence),
      move: usable,
      confidence: pred.confidence,
    });
    if (enemyCharges && pred.move) enemyCharges = spendCharge(enemyCharges, pred.move);
  }

  // Recursive search
  let bestScore = -Infinity;
  let bestMove: CombatMove = available[0];
  let bestReason = "";

  function search(
    charges: SimCharges,
    depth: number,
    round: number
  ): number {
    if (depth >= LOOKAHEAD) return 0;

    const movesAvailable = COMBAT_MOVES.filter((m) => charges[m] > 0);
    if (movesAvailable.length === 0) return -50; // dead end penalty

    let best = -Infinity;
    for (const move of movesAvailable) {
      const pred = enemyPredictions[depth] ?? { dist: {}, move: null, confidence: 0 };
      const pATK = player[move].currentATK;
      const pDEF = player[move].currentDEF;

      // Score this round
      let roundScore = scoreRound(move, pATK, pDEF, pred.dist, enemyAtkByMove);

      // Spam penalty: using a move at 1 charge = -1 next turn, locked out
      if (charges[move] === 1) {
        roundScore -= 15; // significant penalty for going into spam
      }

      // Recurse into future rounds
      const nextCharges = simUpdateCharges(charges, move);
      const futureScore = search(nextCharges, depth + 1, round + 1);

      // Discount future slightly (present value > future value)
      const total = roundScore + futureScore * 0.85;

      if (depth === 0 && total > bestScore) {
        bestScore = total;
        bestMove = move;

        // Build reason string
        const pred0 = enemyPredictions[0];
        const threat = COMBAT_MOVES.filter((m) => (pred0?.dist[m] ?? 0) > 0).sort(
          (a, b) => enemyAtkByMove[b] - enemyAtkByMove[a]
        )[0];
        if (pred0?.move && pred0.confidence >= 0.99) {
          bestReason = `DP counter ${MOVE_LABELS[pred0.move]} (enemy forced)`;
        } else if (pred0?.move && BEATS[move] === pred0.move) {
          bestReason = `DP counter ${MOVE_LABELS[pred0.move]} (${Math.round(pred0.confidence * 100)}%)`;
        } else if (threat && BEATS[move] === threat && enemyAtkByMove[threat] > 0) {
          // No read, but this play covers their hardest-hitting option
          bestReason = `DP ${MOVE_LABELS[move]} (covers ${MOVE_LABELS[threat]} ${enemyAtkByMove[threat]}atk)`;
        } else {
          bestReason = `DP ${MOVE_LABELS[move]} (${pATK} ATK, ${Math.round(bestScore)}pts)`;
        }
      }

      best = Math.max(best, total);
    }

    return best;
  }

  search(cloneCharges(player), 0, 0);

  return { move: bestMove, reason: bestReason };
}

/* ─── Loot scoring ────────────────────────────────────────── */

// Rarity multipliers: higher rarity boons give bigger stat values, so weight them
const RARITY_WEIGHT: Record<number, number> = {
  0: 1.0,  // common (gray)
  1: 1.5,  // uncommon (green)
  2: 2.0,  // rare (blue)
  3: 3.0,  // epic (gold)
  4: 4.0,  // legendary (orange)
};

function scoreLoot(state: DungeonActionResponse, loot: LootOption): number {
  const run = state.data?.run;
  if (!run?.players?.[0]) return 0;

  const player = run.players[0];
  const rarity = RARITY_WEIGHT[loot.RARITY_CID] ?? 1.0;

  // Rank the player's moves by ATK to identify which they actually use
  const moveRanking = COMBAT_MOVES.map((m) => ({
    move: m,
    atk: player[m].currentATK,
  })).sort((a, b) => b.atk - a.atk);

  const primaryMove = moveRanking[0].move;   // strongest move
  const secondaryMove = moveRanking[1].move;  // second strongest
  // The third move (weakest ATK) is considered "unused"

  const v1 = loot.selectedVal1;
  const v2 = loot.selectedVal2;

  let score = 0;

  switch (loot.boonTypeString) {
    case "UpgradeRock":
    case "UpgradePaper":
    case "UpgradeScissor": {
      const upgradeTarget =
        loot.boonTypeString === "UpgradeRock" ? "rock" :
        loot.boonTypeString === "UpgradePaper" ? "paper" : "scissor";

      const atkValue = v1 * 3;
      const defValue = v2 * 1;

      if (upgradeTarget === primaryMove) {
        score = (atkValue + defValue) * 5;
      } else if (upgradeTarget === secondaryMove) {
        score = (atkValue + defValue) * 3;
      } else {
        score = (atkValue + defValue) * 0.5;
      }
      // Move upgrades scale linearly with rarity
      score *= rarity;
      break;
    }
    case "Heal": {
      const hpRatio = player.health.current / (player.health.currentMax || 1);
      if (hpRatio < 0.3) score = v1 * 8;
      else if (hpRatio < 0.5) score = v1 * 5;
      else if (hpRatio < 0.75) score = v1 * 2;
      else score = v1 * 0.3;
      // Heal scales linearly — rarity just means bigger heal value
      score *= rarity;
      break;
    }
    case "AddMaxHealth": {
      // Max HP is a PERMANENT upgrade for the entire run: raises ceiling + heals.
      // High-rarity Max HP is one of the best boons in the game.
      // Base value is high, and rarity scales quadratically (rarity^2)
      // so Epic/Legendary Max HP dominates over common ATK upgrades.
      const hpUrgency = player.health.current / (player.health.currentMax || 1) < 0.5 ? 1.5 : 1.0;
      score = v1 * 6 * hpUrgency * (rarity * rarity);
      break;
    }
    case "AddMaxArmor": {
      // Max Shield is permanent but weaker than Max HP (doesn't add current shield).
      // Still very valuable at high rarity — extra buffer every fight.
      score = v1 * 3 * (rarity * rarity);
      break;
    }
    case "AddBlock": {
      // Awakening boon. Block cuts incoming damage on every exchange we lose,
      // so it compounds over a long run the way Max HP does, but it does
      // nothing about the exchanges we win.
      score = v1 * 4 * rarity;
      break;
    }
    case "AddLuck": {
      // Awakening boon. Luck raises crit chance — real, but it only pays on
      // exchanges already being won, so it ranks below survivability.
      score = v1 * 2.5 * rarity;
      break;
    }
    default:
      score = v1 * rarity;
  }

  return score;
}

/* ─── Awakening: reward and enemy path selection ──────────── */

/**
 * Score one reward option: its boon, discounted by how much run is left to
 * spend it on, plus its Hard Cores at a flat rate.
 *
 * Early in a run a boon compounds across every remaining reward screen, so it
 * outweighs a few Cores. Late there is nothing left to survive for and the
 * Cores are the only part that banks.
 */
function scoreRewardOption(
  state: DungeonActionResponse,
  option: RewardPathOption
): number {
  const room = state.data?.entity?.ROOM_NUM_CID ?? 1;
  // Never let the denominator fall to or below the current room. If the dungeon
  // ever runs longer than TOTAL_ROOMS, a fixed 16 would zero the boon term and
  // make the AI take the weakest boon on every screen past room 16 — the
  // deepest, most dangerous part of the run.
  const totalRooms = Math.max(TOTAL_ROOMS, room + 1);
  const boonWeight = (totalRooms - room) / totalRooms;
  const boonScore = option.boon ? scoreLoot(state, option.boon) : 0;
  return boonScore * boonWeight + (option.gigusOrbAmount ?? 0) * CORE_WEIGHT;
}

/** The wire slot for an option, which is not required to match array order. */
function slotOf(option: { index?: number }, position: number): number {
  return typeof option.index === "number" ? option.index : position;
}

/** Reverse of slotOf: the option the server will resolve for a given slot. */
function optionAtSlot<T extends { index?: number }>(options: T[] | undefined, slot: number): T | undefined {
  if (!options?.length) return undefined;
  return options.find((o, i) => slotOf(o, i) === slot);
}

/**
 * Rough exchange-count comparison for an enemy option: how many rounds we
 * survive against how many it survives.
 *
 * The rolled stats are applied as modifiers whose exact proc semantics are not
 * documented — the rates below follow the published skill percentages
 * (evasion 0.5%/pt, block 1%/pt, luck 0.75%/pt). Being slightly wrong about
 * them is tolerable because this only ranks options against each other; the
 * load-bearing part is the policy, which is to take the hardest tier that still
 * clears a survivability margin, and the easiest tier when none does.
 */
function survivalMargin(
  state: DungeonActionResponse,
  option: EnemyPathOption,
  enemyNamesMap?: Record<string, { name: string; stats?: number[] }>
): number | null {
  const player = state.data?.run?.players?.[0];
  if (!player) return null;

  const base =
    enemyNamesMap?.[String(option.enemyId)]?.stats ??
    enemyNamesMap?.[`idx:${option.enemyId}`]?.stats;
  // No stats means no opinion. The old fallback compared the player against
  // itself, which the rolled modifiers then dragged negative — silently pinning
  // every choice to the lowest tier while the log showed a real-looking number.
  if (!base) return null;

  const ourPool = player.health.current + player.shield.current;
  const ourAtk =
    COMBAT_MOVES.reduce((s, m) => s + player[m].currentATK, 0) / COMBAT_MOVES.length;

  // MOVE_STATS layout: [rockATK, rockDEF, paperATK, paperDEF, scissorATK, scissorDEF, HP, ARM]
  const theirPool = (base[6] ?? 0) + (base[7] ?? 0);
  const theirAtk = ((base[0] ?? 0) + (base[2] ?? 0) + (base[4] ?? 0)) / 3;

  const rolled = option.rolledEnemyStats ?? { evasion: 0, block: 0, lck: 0, tenacity: 0 };
  const ourEffective = Math.max(
    1,
    ourAtk * (1 - (rolled.evasion ?? 0) * 0.005) - (rolled.block ?? 0)
  );
  const theirEffective = Math.max(1, theirAtk * (1 + (rolled.lck ?? 0) * 0.0075));

  const roundsWeSurvive = ourPool / theirEffective;
  const roundsTheySurvive = theirPool / ourEffective;
  return roundsWeSurvive - roundsTheySurvive;
}

/**
 * How much margin we insist on before stepping up a tier. A run that dies is
 * worth zero Cores from that room onward, so the bar is deliberately not "we
 * probably win" — it is "we win with rounds to spare".
 */
const TIER_SAFETY_MARGIN = 2;

/** Highest tier we can survive, falling back to the gentlest option. */
function pickEnemyPath(
  state: DungeonActionResponse,
  options: EnemyPathOption[],
  enemyNamesMap?: Record<string, { name: string; stats?: number[] }>
): number {
  let bestIdx = -1;
  let bestTier = -Infinity;
  for (let i = 0; i < options.length; i++) {
    const margin = survivalMargin(state, options[i], enemyNamesMap);
    // A null margin is "we can't judge this enemy". Stepping up blind risks the
    // whole run — every Core from every later room — to win one room's worth,
    // so an unknown enemy is never a reason to take a harder tier.
    if (margin === null || margin < TIER_SAFETY_MARGIN) continue;
    const tier = options[i].tier ?? 0;
    if (tier > bestTier) {
      bestTier = tier;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) return bestIdx;

  // Nothing clears the bar — take the lowest tier on offer. Options arrive in
  // arbitrary order, so this reads the tier rather than assuming index 0.
  let safestIdx = 0;
  let safestTier = Infinity;
  for (let i = 0; i < options.length; i++) {
    const tier = options[i].tier ?? 0;
    if (tier < safestTier) {
      safestTier = tier;
      safestIdx = i;
    }
  }
  return safestIdx;
}

/* ─── Main exports ─────────────────────────────────────────── */

export function pickBestAction(
  state: DungeonActionResponse,
  enemyNamesMap?: Record<string, { name: string; stats?: number[] }>
): DungeonAction | null {
  const run = state.data?.run;
  if (!run) return null;

  // A dead player has no legal action of any kind — the server ends the run on
  // death and rejects whatever is sent afterwards. This is checked before the
  // loot branch so a contradictory "dead but looting" state can't slip through.
  const self = run.players?.[0];
  if (self && self.health.current <= 0) return null;

  // Awakening reward phase: pick a boon paired with a Hard Core payout. Like
  // the loot branch this must never fall through to a combat move, which the
  // server rejects outright while a choice is pending.
  if (run.rewardPathPhase) {
    const options = run.rewardPathOptions;
    if (!options?.length) return "reward_one";
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < options.length; i++) {
      const score = scoreRewardOption(state, options[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    // The action names a wire slot, which the option carries explicitly. Using
    // the array position instead would send the server a different option than
    // the one that was scored, and the log would still show the intended pick.
    return REWARD_ACTIONS[slotOf(options[bestIdx], bestIdx)] ?? "reward_one";
  }

  // Awakening enemy phase: choose the next fight's difficulty. pathPhase is
  // folded in because a combat move during any pending choice is rejected
  // outright, which strands the run and burns the energy it cost to enter.
  if (run.enemyPathPhase || run.pathPhase) {
    const options = run.enemyPathOptions;
    if (!options?.length) return "path_one";
    const idx = pickEnemyPath(state, options, enemyNamesMap);
    return PATH_ACTIONS[slotOf(options[idx], idx)] ?? "path_one";
  }

  // Loot phase. Once the server is in loot phase it will reject any combat
  // move, so this must never fall through — even when the options are missing
  // from our copy of the state, in which case taking the first is the only
  // action that can make progress.
  if (run.lootPhase) {
    if (!run.lootOptions?.length) return "loot_one";
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < run.lootOptions.length; i++) {
      const score = scoreLoot(state, run.lootOptions[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return LOOT_ACTIONS[bestIdx] ?? "loot_one";
  }

  // Combat phase
  const player = run.players?.[0];
  if (!player) return null;

  const result = pickSmartCombatMove(player, run.players?.[1] ?? null, lookupBaseStats(state, enemyNamesMap));
  return result.move;
}

/** Static MOVE_STATS_CID_array for the current enemy, when known. */
function lookupBaseStats(
  state: DungeonActionResponse,
  enemyNamesMap?: Record<string, { name: string; stats?: number[] }>
): number[] | undefined {
  const enemyId = state.data?.entity?.ENEMY_CID ?? null;
  if (enemyId === null || !enemyNamesMap) return undefined;
  return enemyNamesMap[String(enemyId)]?.stats ?? enemyNamesMap[`idx:${enemyId}`]?.stats;
}

/** Get the reason string for the last pick (for logging) */
export function explainAction(
  state: DungeonActionResponse,
  action: DungeonAction,
  enemyNamesMap?: Record<string, { name: string; stats?: number[] }>
): string {
  const run = state.data?.run;
  if (!run) return "";

  if (action === "reward_one" || action === "reward_two" || action === "reward_three") {
    const opt = optionAtSlot(run.rewardPathOptions, REWARD_ACTIONS.indexOf(action as RewardAction));
    if (opt) {
      const score = scoreRewardOption(state, opt).toFixed(1);
      const boon = opt.boon ? `${opt.boon.boonTypeString} +${opt.boon.selectedVal1}` : "no boon";
      return `reward ${opt.gigusOrbAmount} Cores + ${boon} (${score})`;
    }
    return action;
  }

  if (action === "path_one" || action === "path_two" || action === "path_three") {
    const opt = optionAtSlot(run.enemyPathOptions, PATH_ACTIONS.indexOf(action as PathAction));
    if (opt) {
      const margin = survivalMargin(state, opt, enemyNamesMap);
      const buff = opt.enemyBuff ? ` ${opt.enemyBuff.name}` : "";
      // "unknown" is load-bearing: it means we defaulted to the gentlest tier
      // because the enemy's stats were missing, not because it looked hard.
      const detail = margin === null ? "enemy stats unknown" : `margin ${margin.toFixed(1)} rounds`;
      return `path ${opt.tierName}${buff} (${detail})`;
    }
    return action;
  }

  if (action === "loot_one" || action === "loot_two" || action === "loot_three" || action === "loot_four") {
    const idx = LOOT_ACTIONS.indexOf(action as LootAction);
    const loot = run.lootOptions?.[idx];
    if (loot) {
      const score = scoreLoot(state, loot).toFixed(1);
      return `loot ${loot.boonTypeString} +${loot.selectedVal1}${loot.selectedVal2 ? `/+${loot.selectedVal2}` : ""} (${score})`;
    }
    return action;
  }

  const player = run.players?.[0];
  if (player && (action === "rock" || action === "paper" || action === "scissor")) {
    const result = pickSmartCombatMove(player, run.players?.[1] ?? null, lookupBaseStats(state, enemyNamesMap));
    const s = player[action];
    return `${MOVE_LABELS[action]} ${s.currentATK}atk ${s.currentCharges}ch — ${result.reason}`;
  }

  return action;
}
