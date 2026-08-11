"use client";

import { useGigaverse } from "@/lib/use-gigaverse";
import { pickBestAction, evaluateState, explainAction, MOVE_LABELS } from "@/lib/auto-battle";
import { probeEnemyMove } from "@/lib/enemy-probe";
import { authenticateWithSignature, recordRunAction, getRunStatsAction, getDungeonPerformanceAction } from "./actions";
import { useLoginWithAbstract, useAbstractClient } from "@abstract-foundation/agw-react";
import { useAccount, useSignMessage, useReadContract } from "wagmi";
import { ABSTRACT_VOTING_ADDRESS, ABSTRACT_VOTING_ABI, GIGAVERSE_APP_ID } from "@/lib/voting-contract";
import { Sword, Skull, BarChart3, HardDrive, Package, Star, ScrollText, X, Vote, Fish, Rocket, Heart, Copy } from "lucide-react";
import { MissionControlPage } from "./mission-control";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Player, DungeonAction, DungeonActionResponse, RomEntity, FishingCard, FishingGameData } from "@/lib/types";
import { pickBestCard, pickGroveMove, shouldRedraw, predictNextPositionsWeighted, predictGroveCoords, focusZone, scoreHand, scoreGroveHand, coordToCell, cellToCoord, inferGrid, resolveGrid, DEFAULT_GRID } from "@/lib/fishing-ai";
import { probeFishMove } from "@/lib/fishing-probe";
import type { GridDims } from "@/lib/fishing-ai";
import { FISHING, CLAIM_RECIPES, getMaxRunsPerDay } from "@/lib/game-data";
import {
  openCastNodes, castsUsedToday, pondCurrencyLabel, findPondForNode, pondEntryOptions,
} from "@/lib/ponds";
import { nodeIdForGame } from "@/lib/fishing-state";
import { buildSkillAdvice } from "@/lib/skill-advisor";

// Donations — GigaBrain is free; these fund the coffee
const DONATIONS = {
  kofi: "inceptyon",
  wallets: [
    { label: "Abstract", address: "0x0757C2c5bC42F5aC373903B5DFd85CE2B9201124" },
    { label: "Ethereum", address: "0x42353a7Fc70Eab5C0017733813805313B7b10b8B" },
  ],
};

const MOVE_IMAGES: Record<string, string> = {
  rock: "/icons/sword.png",
  paper: "/icons/shield.png",
  scissor: "/icons/spell.png",
};

function MoveImage({ move, size = 24 }: { move: string; size?: number }) {
  return (
    <img
      src={MOVE_IMAGES[move]}
      alt={MOVE_LABELS[move]}
      width={size}
      height={size}
      style={{ objectFit: "contain", imageRendering: "auto" }}
      draggable={false}
    />
  );
}

const MOVE_COLORS: Record<string, string> = {
  rock: "var(--red)",
  paper: "var(--blue)",
  scissor: "var(--green)",
};

const MOVE_BG: Record<string, string> = {
  rock: "var(--red-glow)",
  paper: "var(--blue-glow)",
  scissor: "var(--green-glow)",
};

const RARITY_COLORS = ["var(--text-faint)", "var(--green)", "var(--blue)", "var(--gold)", "var(--orange)"];
const RARITY_GLOW = ["none", "var(--green-glow)", "var(--blue-glow)", "var(--gold-glow)", "var(--orange-glow)"];

/** Format numbers with locale separators (e.g. 1,234) */
function fmt(n: number): string {
  return n.toLocaleString();
}

/** Map raw API boon names to friendly display names */
const BOON_NAMES: Record<string, string> = {
  UpgradeRock: "Sword",
  UpgradePaper: "Shield",
  UpgradeScissor: "Spell",
  AddMaxHealth: "Max HP",
  AddMaxArmor: "Max Shield",
  Heal: "Heal",
};

function formatBoon(boonTypeString: string, val1: number, val2?: number): string {
  const name = BOON_NAMES[boonTypeString] || boonTypeString;
  if (boonTypeString.startsWith("Upgrade")) {
    // Show ATK/DEF breakdown: "Sword +3 ATK / +1 DEF"
    const parts = [`+${val1} ATK`];
    if (val2) parts.push(`+${val2} DEF`);
    return `${name} ${parts.join(" / ")}`;
  }
  return `${name} +${val1}`;
}

const BAR_GRADIENTS: Record<string, string> = {
  hp: "linear-gradient(90deg, var(--green-dim), var(--green))",
  shield: "linear-gradient(90deg, var(--blue-dim), var(--blue))",
  energy: "linear-gradient(90deg, var(--orange-dim), var(--orange))",
};

/* ─── Vital bar ──────────────────────────────────────────── */
function VitalBar({ current, max, color, gradient, thin, label }: {
  current: number; max: number; color: string; gradient?: string; thin?: boolean; label?: string;
}) {
  const pct = max > 0 ? Math.min(100, (current / max) * 100) : 0;
  const h = thin ? 5 : 10;
  return (
    <div className="flex items-center gap-2">
      {label && (
        <span className="text-[10px] font-bold w-5 shrink-0 uppercase" style={{ color, letterSpacing: "0.05em" }}>
          {label}
        </span>
      )}
      <div className="flex-1 rounded-full overflow-hidden" style={{ height: h, background: "var(--bg-inset)" }}>
        <div
          className="h-full w-full rounded-full"
          style={{
            transform: `scaleX(${pct / 100})`,
            transformOrigin: "left",
            background: gradient ? BAR_GRADIENTS[gradient] : color,
            transition: "transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        />
      </div>
      <span className="text-[11px] tabular-nums shrink-0 font-medium" style={{ color: "var(--text-dim)", minWidth: 52, textAlign: "right" }}>
        {current}/{max}
      </span>
    </div>
  );
}

/* ─── Fighter panel ──────────────────────────────────────── */
function FighterPanel({ fighter, name, isEnemy }: { fighter: Player; name?: string; isEnemy?: boolean }) {
  const isDead = fighter.health.current <= 0;
  const lastMoveColor = fighter.lastMove ? MOVE_COLORS[fighter.lastMove as string] : undefined;

  return (
    <div className="flex-1 min-w-0 relative">
      {/* Dead overlay */}
      {isDead && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg z-10" style={{ background: "var(--bg-overlay)" }}>
          <Skull size={40} style={{ color: "var(--red)", opacity: 0.8 }} />
        </div>
      )}

      {/* Header: name + last move */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[13px] font-bold" style={{ color: isEnemy ? "var(--red)" : "var(--text)" }}>
          {name || (isEnemy ? "Enemy" : "You")}
        </span>
        {fighter.lastMove && (
          <div
            className="flex items-center gap-1.5 px-2 py-0.5 rounded"
            style={{ background: MOVE_BG[fighter.lastMove as string] }}
          >
            <MoveImage move={fighter.lastMove as string} size={16} />
            <span className="text-[11px] font-semibold" style={{ color: lastMoveColor }}>
              {MOVE_LABELS[fighter.lastMove as keyof typeof MOVE_LABELS] ?? fighter.lastMove}
            </span>
          </div>
        )}
      </div>
      <div className="space-y-2 mb-4">
        <VitalBar label="HP" current={fighter.health.current} max={fighter.health.currentMax} color="var(--green)" gradient="hp" />
        <VitalBar label="SH" current={fighter.shield.current} max={fighter.shield.currentMax} color="var(--blue)" gradient="shield" />
      </div>
      <div className="space-y-1.5">
        {(["rock", "paper", "scissor"] as const).map((m) => {
          const s = fighter[m];
          const depleted = s.currentCharges <= 0;
          return (
            <div
              key={m}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md"
              style={{ background: MOVE_BG[m], opacity: depleted ? 0.5 : 1 }}
            >
              <MoveImage move={m} size={18} />
              <span className="text-[11px] font-semibold" style={{ color: MOVE_COLORS[m], minWidth: 40 }}>
                {MOVE_LABELS[m]}
              </span>
              <div className="flex items-center gap-3 ml-auto text-[11px] tabular-nums">
                <span style={{ color: "var(--text)" }}>
                  <span style={{ color: "var(--text-faint)" }}>ATK </span>
                  <span className="font-semibold">{s.currentATK}</span>
                </span>
                <span style={{ color: "var(--text)" }}>
                  <span style={{ color: "var(--text-faint)" }}>DEF </span>
                  <span className="font-semibold">{s.currentDEF}</span>
                </span>
                <span style={{ color: depleted ? "var(--red)" : "var(--text-faint)" }}>
                  {s.currentCharges === -1
                    ? <span className="font-semibold" style={{ color: "var(--red)" }}>SPAM</span>
                    : <><span style={{ color: "var(--text-faint)" }}>{s.currentCharges}</span><span style={{ color: "var(--text-faint)", fontSize: 9 }}> left</span></>
                  }
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Stat pill ──────────────────────────────────────────── */
function StatPill({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span style={{ color: "var(--text-faint)" }}>{label}</span>
      <span className="font-semibold tabular-nums" style={{ color: color || "var(--text)" }}>{value}</span>
    </div>
  );
}

/* ─── Stats Page ──────────────────────────────────────────── */
function StatsPage({ runStats, enemyNames, itemInfo }: {
  runStats: { totalRuns: number; wins: number; losses: number; avgRooms: number; totalItems: Record<string, { name: string; amount: number }> } | null;
  enemyNames: Record<string, { name: string; stats?: number[] }>;
  itemInfo: Record<string, { name: string; rarity?: number; rarityName?: string; icon?: string }>;
}) {
  // enemyNames is keyed by both id and "idx:id"; take the numeric keys only.
  const enemyList = Object.entries(enemyNames)
    .filter(([k, v]) => !k.startsWith("idx:") && (v.stats?.length ?? 0) >= 8)
    .map(([k, v]) => ({ id: k, name: v.name, stats: v.stats as number[] }))
    .sort((a, b) => a.stats[6] - b.stats[6]);

  return (
    <div className="anim-in space-y-8">

      {/* Run Statistics */}
      <section>
        <h2 className="text-[18px] font-bold mb-4">Run Statistics</h2>
        {!runStats || runStats.totalRuns === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>No runs recorded yet.</p>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
              {[
                { label: "Total Runs", value: fmt(runStats.totalRuns), color: "var(--text)" },
                { label: "Win Rate", value: `${Math.round((runStats.wins / runStats.totalRuns) * 100)}%`, color: runStats.wins > runStats.losses ? "var(--green)" : "var(--red)" },
                { label: "Avg Rooms", value: runStats.avgRooms.toFixed(1), color: "var(--text)" },
                { label: "W / L", value: `${fmt(runStats.wins)} / ${fmt(runStats.losses)}`, color: "var(--text)" },
              ].map((card) => (
                <div key={card.label} className="p-3 rounded-lg" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}>
                  <div className="text-[11px] font-bold uppercase tracking-[0.1em] mb-1" style={{ color: "var(--text-faint)" }}>
                    {card.label}
                  </div>
                  <div className="text-[22px] font-bold tabular-nums" style={{ color: card.color }}>
                    {card.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Win rate bar */}
            <div className="flex rounded-md overflow-hidden mb-5" style={{ height: 8 }}>
              <div style={{ width: `${(runStats.wins / runStats.totalRuns) * 100}%`, background: "var(--green)" }} />
              <div style={{ width: `${(runStats.losses / runStats.totalRuns) * 100}%`, background: "var(--red)" }} />
            </div>

            {/* Total items collected */}
            {Object.keys(runStats.totalItems).length > 0 && (
              <div>
                <h3 className="text-[13px] font-bold uppercase tracking-[0.1em] mb-2" style={{ color: "var(--gold)" }}>
                  All-time items
                </h3>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(runStats.totalItems)
                    .sort((a, b) => b[1].amount - a[1].amount)
                    .map(([id, item]) => {
                      const info = itemInfo[id];
                      const rarityColor = RARITY_COLORS[info?.rarity ?? 0] || "var(--text-faint)";
                      return (
                        <span
                          key={id}
                          className="text-[11px] font-medium px-2.5 py-1 rounded-md flex items-center gap-1.5"
                          style={{ background: "var(--bg-inset)", color: rarityColor, border: `1px solid ${rarityColor}` }}
                        >
                          {info?.icon && <img src={info.icon} alt="" width={14} height={14} style={{ objectFit: "contain" }} />}
                          {item.name}
                          <span className="font-bold" style={{ color: "var(--text)" }}>x{fmt(item.amount)}</span>
                        </span>
                      );
                    })}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Enemy Reference */}
      <section>
        <h2 className="text-[18px] font-bold mb-1">Enemy Reference</h2>
        <p className="text-[11px] mb-4" style={{ color: "var(--text-faint)" }}>
          Per-move ATK/DEF from the game&apos;s static data. The auto-battler predicts from
          the enemy&apos;s live charges, using these stats only to break ties.
        </p>

        {enemyList.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>Enemy data not loaded yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {enemyList.map((e) => (
              <div
                key={e.id}
                className="p-3 rounded-lg"
                style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[13px] font-bold">{e.name}</span>
                  <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                    HP {e.stats[6]} &middot; SH {e.stats[7]}
                  </span>
                </div>
                <div className="flex gap-3 text-[11px] tabular-nums" style={{ color: "var(--text-dim)" }}>
                  <span><span style={{ color: "var(--red)" }}>Sword</span> {e.stats[0]}/{e.stats[1]}</span>
                  <span><span style={{ color: "var(--blue)" }}>Shield</span> {e.stats[2]}/{e.stats[3]}</span>
                  <span><span style={{ color: "var(--green)" }}>Spell</span> {e.stats[4]}/{e.stats[5]}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ─── ROMs Page ───────────────────────────────────────────── */

function RomsPage({ roms, onClaimRom, onConvertToDust, onRefresh, loading, addLog }: {
  roms: RomEntity[];
  onClaimRom: (romId: string, claimId: string) => Promise<{ success: boolean } | null>;
  onConvertToDust: (romId: string, amount: number) => Promise<{ success: boolean } | null>;
  onRefresh: () => Promise<void>;
  loading: boolean;
  addLog: (msg: string) => void;
}) {
  const [claiming, setClaiming] = useState(false);
  const [confirmConvert, setConfirmConvert] = useState(false);

  // Aggregates
  const totalE = roms.reduce((s, r) => s + Math.floor(r.factoryStats.energyCollectable), 0);
  const totalS = roms.reduce((s, r) => s + Math.floor(r.factoryStats.shardCollectable), 0);
  const totalD = roms.reduce((s, r) => s + Math.floor(r.factoryStats.dustCollectable), 0);
  const totalShardRate = roms.reduce((s, r) => s + r.factoryStats.shardProductionPerWeek, 0);
  const totalDustRate = roms.reduce((s, r) => s + r.factoryStats.dustProductionPerWeek, 0);

  const handleClaimAll = async () => {
    setClaiming(true);
    let count = 0;
    for (const rom of roms) {
      const fs = rom.factoryStats;
      const types: string[] = [];
      if (Math.floor(fs.energyCollectable) > 0) types.push("energy");
      if (Math.floor(fs.shardCollectable) > 0) types.push("shard");
      if (Math.floor(fs.dustCollectable) > 0) types.push("dust");
      for (const t of types) {
        try {
          const r = await onClaimRom(rom.docId, t);
          if (r?.success) { count++; addLog(`claimed ${t} #${fs.serialNumber}`); }
        } catch { /* claim may fail if already claimed */ }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    addLog(`done — ${count} claims`);
    await onRefresh();
    setClaiming(false);
  };

  const handleConvertAll = async () => {
    setClaiming(true);
    let total = 0;
    for (const rom of roms) {
      const amt = Math.floor(rom.factoryStats.energyCollectable);
      if (amt <= 0) continue;
      try {
        const r = await onConvertToDust(rom.docId, amt);
        if (r?.success) { total += amt; addLog(`converted ${amt}E #${rom.factoryStats.serialNumber}`); }
      } catch { /* claim may fail if already claimed */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    addLog(`done — ${total}E converted to dust`);
    await onRefresh();
    setClaiming(false);
  };

  return (
    <div className="anim-in space-y-6">
      <h2 className="text-[18px] font-bold">ROM Dashboard</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total ROMs", value: fmt(roms.length), color: "var(--text)" },
          { label: "Energy", value: fmt(totalE), color: "var(--orange)" },
          { label: "Shards", value: fmt(totalS), color: "var(--blue)" },
          { label: "Dust", value: fmt(totalD), color: "var(--green)" },
        ].map((card) => (
          <div key={card.label} className="p-3 rounded-lg" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}>
            <div className="text-[11px] font-bold uppercase tracking-[0.1em] mb-1" style={{ color: "var(--text-faint)" }}>
              {card.label}
            </div>
            <div className="text-[22px] font-bold tabular-nums" style={{ color: card.color }}>
              {card.value}
            </div>
          </div>
        ))}
      </div>

      {/* Production rates */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="p-3 rounded-lg" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] mb-1" style={{ color: "var(--text-faint)" }}>
            Shard Production
          </h3>
          <div className="text-[18px] font-bold tabular-nums" style={{ color: "var(--blue)" }}>
            {totalShardRate.toFixed(1)}<span className="text-[11px] font-normal" style={{ color: "var(--text-faint)" }}>/week</span>
          </div>
        </div>
        <div className="p-3 rounded-lg" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] mb-1" style={{ color: "var(--text-faint)" }}>
            Dust Production
          </h3>
          <div className="text-[18px] font-bold tabular-nums" style={{ color: "var(--green)" }}>
            {totalDustRate.toFixed(1)}<span className="text-[11px] font-normal" style={{ color: "var(--text-faint)" }}>/week</span>
          </div>
        </div>
      </div>

      {/* Bulk actions */}
      <div className="flex gap-2">
        <button
          disabled={loading || claiming || (totalE === 0 && totalS === 0 && totalD === 0)}
          onClick={handleClaimAll}
          className="btn-press text-[11px] font-bold uppercase px-4 py-2 rounded-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ background: "var(--orange)", border: "none", color: "var(--bg)" }}
        >
          {claiming ? "Claiming..." : "Claim All Resources"}
        </button>
        <button
          disabled={loading || claiming || totalE === 0}
          onClick={() => {
            if (!confirmConvert) {
              setConfirmConvert(true);
              return;
            }
            setConfirmConvert(false);
            handleConvertAll();
          }}
          onBlur={() => setConfirmConvert(false)}
          className="btn-press text-[11px] font-bold uppercase px-4 py-2 rounded-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          style={{
            background: confirmConvert ? "var(--red-cta)" : "var(--green)",
            border: "none",
            color: confirmConvert ? "var(--text-inverse)" : "var(--bg)",
          }}
        >
          {claiming
            ? "..."
            : confirmConvert
              ? `Convert ${fmt(totalE)}E — can't be undone. Sure?`
              : `Convert All Energy to Dust (${fmt(totalE)}E)`}
        </button>
      </div>

      {/* Per-ROM cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {roms.map((rom) => {
          const fs = rom.factoryStats;
          const ePct = fs.maxEnergy > 0 ? Math.floor(fs.energyCollectable) / fs.maxEnergy : 0;
          const sPct = fs.maxShard > 0 ? Math.floor(fs.shardCollectable) / fs.maxShard : 0;
          const dPct = fs.maxDust > 0 ? Math.floor(fs.dustCollectable) / fs.maxDust : 0;

          return (
            <div key={rom.docId} className="p-4 rounded-lg" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}>
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-[13px] font-bold">{fs.tier} ROM</div>
                  <div className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>#{fs.serialNumber}</div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-semibold" style={{ color: "var(--text-dim)" }}>{fs.faction}</div>
                  <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>{fs.memory} memory</div>
                </div>
              </div>

              {/* Resource bars */}
              <div className="space-y-3 mb-4">
                {([
                  { label: "Energy", val: Math.floor(fs.energyCollectable), max: fs.maxEnergy, pct: ePct, color: "var(--orange)" },
                  { label: "Shards", val: Math.floor(fs.shardCollectable), max: fs.maxShard, pct: sPct, color: "var(--blue)" },
                  { label: "Dust", val: Math.floor(fs.dustCollectable), max: fs.maxDust, pct: dPct, color: "var(--green)" },
                ] as const).map((res) => (
                  <div key={res.label}>
                    <div className="flex justify-between text-[11px] mb-0.5">
                      <span style={{ color: res.color }}>{res.label}</span>
                      <span className="tabular-nums" style={{ color: res.val > 0 ? "var(--text)" : "var(--text-faint)" }}>
                        {res.val} / {res.max}
                      </span>
                    </div>
                    <div className="rounded-full overflow-hidden" style={{ height: 4, background: "var(--bg-inset)" }}>
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.min(res.pct * 100, 100)}%`, background: res.color, opacity: res.val > 0 ? 1 : 0.2 }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* Production rates */}
              <div className="text-[11px] tabular-nums mb-4" style={{ color: "var(--text-faint)" }}>
                <span style={{ color: "var(--blue)" }}>{fs.shardProductionPerWeek.toFixed(1)}</span> shards/wk
                <span className="mx-1">&middot;</span>
                <span style={{ color: "var(--green)" }}>{fs.dustProductionPerWeek.toFixed(1)}</span> dust/wk
              </div>

              {/* Actions */}
              <div className="flex gap-1.5 flex-wrap">
                {(["energy", "shard", "dust"] as const).map((t) => {
                  const val = t === "energy" ? fs.energyCollectable : t === "shard" ? fs.shardCollectable : fs.dustCollectable;
                  return (
                    <button
                      key={t}
                      onClick={async () => {
                        addLog(`claim ${t} #${fs.serialNumber}`);
                        const r = await onClaimRom(rom.docId, t);
                        if (r?.success) { addLog(`got ${t}`); onRefresh(); }
                      }}
                      disabled={loading || Math.floor(val) === 0}
                      className="btn-press text-[11px] font-bold uppercase px-3 py-1.5 rounded cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
                    >
                      {t}
                    </button>
                  );
                })}
                {Math.floor(fs.energyCollectable) > 0 && (
                  <button
                    onClick={async () => {
                      const amt = Math.floor(fs.energyCollectable);
                      addLog(`convert ${amt}E to dust #${fs.serialNumber}`);
                      const r = await onConvertToDust(rom.docId, amt);
                      if (r?.success) { addLog(`converted ${amt}E`); onRefresh(); }
                    }}
                    disabled={loading}
                    className="btn-press text-[11px] font-bold px-3 py-1.5 rounded cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{ background: "var(--green)", border: "none", color: "var(--bg)" }}
                  >
                    E{"\u2192"}Dust
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Main ────────────────────────────────────────────────── */
export default function Home() {
  const giga = useGigaverse();
  const { isConnected: walletConnected, address: walletAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { login: walletLogin, logout: walletLogout } = useLoginWithAbstract();
  const { data: abstractClient } = useAbstractClient();

  // Abstract portal voting
  const { data: currentEpoch } = useReadContract({
    address: ABSTRACT_VOTING_ADDRESS,
    abi: ABSTRACT_VOTING_ABI,
    functionName: "currentEpoch",
    query: { enabled: walletConnected },
  });
  const { data: userVotes, refetch: refetchVotes } = useReadContract({
    address: ABSTRACT_VOTING_ADDRESS,
    abi: ABSTRACT_VOTING_ABI,
    functionName: "getUserVotes",
    args: walletAddress && currentEpoch ? [walletAddress, currentEpoch] : undefined,
    query: { enabled: walletConnected && !!walletAddress && currentEpoch !== undefined },
  });
  const hasVoted = userVotes ? (userVotes as bigint[]).some((v) => v === GIGAVERSE_APP_ID) : false;
  const [voting, setVoting] = useState(false);
  const [jwtInput, setJwtInput] = useState("");
  const [showManualLogin, setShowManualLogin] = useState(false);
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<{ id: number; text: string }[]>([]);
  const logIdRef = useRef(0);
  const [activePage, setActivePage] = useState<"mission" | "dungeon" | "stats" | "roms" | "fishing" | "world">("mission");
  const [flyout, setFlyout] = useState<"skills" | "log" | "support" | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);

  // Escape key handler for overlays
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (userMenuOpen) setUserMenuOpen(false);
        else if (flyout) setFlyout(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [userMenuOpen, flyout]);
  const [lastDrops, setLastDrops] = useState<{ id: number; amount: number }[]>([]);
  const [runStats, setRunStats] = useState<{
    totalRuns: number; wins: number; losses: number; avgRooms: number;
    totalItems: Record<string, { name: string; amount: number }>;
  } | null>(null);
  const [autoPlay, setAutoPlay] = useState(false);
  const [chainMode, setChainMode] = useState<{ dungeonId: number; dungeonName: string } | null>(null);
  const chainModeRef = useRef<{ dungeonId: number; dungeonName: string } | null>(null);
  const [chainCap, setChainCap] = useState("");
  const chainCapRef = useRef("");
  useEffect(() => { chainCapRef.current = chainCap; }, [chainCap]);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [runSummary, setRunSummary] = useState<{
    roomsCleared: number;
    boons: string[];
    items: { id: number; amount: number; name: string }[];
    finalHp: number;
    maxHp: number;
    won: boolean;
  } | null>(null);
  const [chainSummary, setChainSummary] = useState<{
    totalRuns: number;
    wins: number;
    losses: number;
    totalRooms: number;
    allItems: { id: number; amount: number; name: string }[];
  } | null>(null);
  const chainStatsRef = useRef({ totalRuns: 0, wins: 0, losses: 0, totalRooms: 0, allItems: new Map<number, number>() });
  const autoPlayRef = useRef(false);
  const runningRef = useRef(false);
  const gigaRef = useRef(giga);
  gigaRef.current = giga;
  const runBoonsRef = useRef<string[]>([]);
  const runItemsRef = useRef<Map<number, number>>(new Map());

  // Accumulate item drops from action responses
  const trackItemDrops = useCallback((result: DungeonActionResponse) => {
    if (result.gameItemBalanceChanges && result.gameItemBalanceChanges.length > 0) {
      for (const change of result.gameItemBalanceChanges) {
        const prev = runItemsRef.current.get(change.id) ?? 0;
        runItemsRef.current.set(change.id, prev + change.amount);
      }
      setLastDrops(result.gameItemBalanceChanges);
    } else {
      setLastDrops([]);
    }
  }, []);

  const buildItemSummary = useCallback(() => {
    const g = gigaRef.current;
    return Array.from(runItemsRef.current.entries()).map(([id, amount]) => ({
      id,
      amount,
      name: g.itemNames[String(id)] || `Item #${id}`,
    }));
  }, []);

  // Opt-in probe: validates that enemy charges deplete and scores the
  // predictor against its 1/3 baseline. No-op unless enabled in localStorage.
  const trackEnemyMove = useCallback(
    (before: DungeonActionResponse | null, result: DungeonActionResponse) => {
      const entity = result.data?.entity;
      const enemy = result.data?.run?.players?.[1];
      if (!enemy?.lastMove || !entity || entity.ENEMY_CID < 0) return;
      const names = gigaRef.current.enemyNames;
      const stats =
        names[String(entity.ENEMY_CID)]?.stats ?? names[`idx:${entity.ENEMY_CID}`]?.stats;
      probeEnemyMove(
        before?.data?.run?.players?.[1] ?? null,
        enemy,
        entity.ENEMY_CID,
        entity.ROOM_NUM_CID,
        stats,
        result.data?.run?.players?.[0]
      );
    },
    []
  );

  const addLog = useCallback(
    (msg: string) => {
      const id = ++logIdRef.current;
      const text = `${new Date().toLocaleTimeString("en", { hour12: false })} ${msg}`;
      setLog((prev) => [{ id, text }, ...prev].slice(0, 80));
    },
    []
  );

  // Skill advisor: upgrade queue tuned to how the auto-battler plays.
  // Normal and Underhaul trees are judged by their own dungeon's clear depth.
  const [applyingSkills, setApplyingSkills] = useState(false);
  const [dungeonPerfStats, setDungeonPerfStats] = useState<{ name: string; avgRooms: number; totalRuns: number }[]>([]);
  const skillAdvice = useMemo(() => {
    if (giga.skillTrees.length === 0) return null;
    const avgRooms = runStats && runStats.totalRuns >= 3 ? runStats.avgRooms : null;
    return buildSkillAdvice(giga.skillTrees, giga.skillProgress, giga.itemBalances, avgRooms, dungeonPerfStats);
  }, [giga.skillTrees, giga.skillProgress, giga.itemBalances, runStats, dungeonPerfStats]);

  const applySkillUpgrades = useCallback(async (upgrades: { skillId: number; statId: number; statName: string }[]) => {
    setApplyingSkills(true);
    let applied = 0;
    try {
      for (const u of upgrades) {
        const r = await giga.levelUpSkill(u.skillId, u.statId);
        if (!r || r.success === false) {
          addLog(`skill upgrade failed at ${u.statName}: ${r?.message || giga.lastErrorRef.current || "unknown"}`);
          break;
        }
        applied++;
        addLog(`upgraded ${u.statName}`);
        await new Promise((res) => setTimeout(res, 250));
      }
    } finally {
      await giga.refreshSkills();
      setApplyingSkills(false);
      if (applied > 0) addLog(`applied ${applied} skill upgrade${applied === 1 ? "" : "s"}`);
    }
  }, [giga, addLog]);

  // Manual JWT connect
  const handleConnect = async () => {
    const me = await giga.connect(jwtInput);
    if (me) {
      setConnected(true);
      addLog("connected & synced");
    }
  };

  // Wallet connect → sign message → authenticate → connect
  const handleVote = useCallback(async () => {
    if (!abstractClient || voting) return;
    setVoting(true);
    try {
      addLog("voting for Gigaverse on Abstract Portal...");
      const hash = await abstractClient.writeContract({
        address: ABSTRACT_VOTING_ADDRESS,
        abi: ABSTRACT_VOTING_ABI,
        functionName: "voteForApp",
        args: [GIGAVERSE_APP_ID],
      });
      addLog(`voted! tx: ${hash.slice(0, 10)}...`);
      refetchVotes();
    } catch (e) {
      addLog(`vote failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setVoting(false);
    }
  }, [abstractClient, voting, addLog, refetchVotes]);

  const handleWalletLogin = useCallback(async () => {
    if (!walletConnected || !walletAddress) {
      walletLogin();
      return;
    }
    const timestamp = Date.now();
    const message = `Login to Gigaverse at ${timestamp}`;
    try {
      const signature = await signMessageAsync({ message });
      const result = await authenticateWithSignature(walletAddress, signature, message, timestamp);
      if (!result.success || !result.jwt) {
        throw new Error(result.error || "Auth failed");
      }
      const me = await giga.connect(result.jwt, result.expiresAt);
      if (me) {
        setConnected(true);
        addLog("wallet connected & synced");
      }
    } catch (e) {
      addLog(`wallet auth failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }, [walletConnected, walletAddress, walletLogin, signMessageAsync, giga, addLog]);

  // After wallet connects, auto-trigger sign + auth
  const didAutoSign = useRef(false);
  useEffect(() => {
    if (walletConnected && walletAddress && !connected && !giga.restoringSession && !didAutoSign.current) {
      didAutoSign.current = true;
      handleWalletLogin();
    }
  }, [walletConnected, walletAddress, connected, giga.restoringSession, handleWalletLogin]);

  // Auto-restore session from localStorage (handled in useGigaverse)
  useEffect(() => {
    if (!giga.restoringSession && giga.token && giga.address && !connected) {
      setConnected(true);
      addLog("session restored");
    }
  }, [giga.restoringSession, giga.token, giga.address, connected, addLog]);

  // Load run stats on connect
  const refreshRunStats = useCallback(() => {
    if (!giga.address) return;
    getRunStatsAction(giga.address).then(setRunStats).catch(() => {});
    getDungeonPerformanceAction(giga.address)
      .then((rows) => setDungeonPerfStats(rows.map((r) => ({ name: r.dungeon_name, avgRooms: r.avg_rooms, totalRuns: r.total_runs }))))
      .catch(() => {});
  }, [giga.address]);
  useEffect(() => {
    if (connected) refreshRunStats();
  }, [connected, refreshRunStats]);

  // Periodic refresh (paused during auto-battle to avoid actionToken races)
  useEffect(() => {
    if (!connected || autoPlay) return;
    const id = setInterval(() => gigaRef.current.refreshAll(), 30000);
    return () => clearInterval(id);
  }, [connected, autoPlay]);

  // Keep refs in sync
  useEffect(() => {
    autoPlayRef.current = autoPlay;
    giga.autoBattleRef.current = autoPlay;
  }, [autoPlay, giga.autoBattleRef]);
  useEffect(() => {
    chainModeRef.current = chainMode;
  }, [chainMode]);

  // Helper: resolve dungeon name from entity or chain mode
  const getDungeonName = useCallback(() => {
    if (chainModeRef.current?.dungeonName) return chainModeRef.current.dungeonName;
    const dungeonId = gigaRef.current.dungeonState?.data?.entity?.DUNGEON_ID_CID;
    if (dungeonId !== undefined) {
      const match = gigaRef.current.dungeonToday?.dungeonDataEntities?.find(
        (d) => d.ID_CID === dungeonId
      );
      if (match) return match.NAME_CID;
    }
    return "Unknown";
  }, []);

  // Helper: finish a single run and record stats for chaining
  const finishRun = useCallback((roomsCleared: number, won: boolean, finalHp: number, maxHp: number, dungeonName: string) => {
    const items = buildItemSummary();
    const boons = [...runBoonsRef.current];
    const summary = { roomsCleared, boons, items, finalHp, maxHp, won };

    // Update chain stats
    const cs = chainStatsRef.current;
    cs.totalRuns++;
    if (won) cs.wins++; else cs.losses++;
    cs.totalRooms += roomsCleared;
    for (const item of items) {
      cs.allItems.set(item.id, (cs.allItems.get(item.id) ?? 0) + item.amount);
    }

    // Persist to SQLite
    const addr = gigaRef.current.address;
    recordRunAction(dungeonName, won, roomsCleared, finalHp, maxHp, items, boons, addr)
      .then(() => refreshRunStats())
      .catch(() => {});

    return summary;
  }, [buildItemSummary, refreshRunStats]);

  const buildChainSummary = useCallback(() => {
    const cs = chainStatsRef.current;
    const g = gigaRef.current;
    return {
      totalRuns: cs.totalRuns,
      wins: cs.wins,
      losses: cs.losses,
      totalRooms: cs.totalRooms,
      allItems: Array.from(cs.allItems.entries()).map(([id, amount]) => ({
        id,
        amount,
        name: g.itemNames[String(id)] || `Item #${id}`,
      })),
    };
  }, []);

  // Auto-play loop (supports single run + chain mode)
  useEffect(() => {
    if (!autoPlay || !connected) return;

    let cancelled = false;

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const runSingleDungeon = async (): Promise<{ roomsCleared: number; won: boolean; finalHp: number; maxHp: number; dungeonName: string } | null> => {
      runBoonsRef.current = [];
      runItemsRef.current = new Map();
      setRunSummary(null);
      setLastDrops([]);

      let lastRoomNum = 0;
      let noActionStreak = 0;
      // Capture dungeon name early before state is cleared at run end
      let capturedDungeonName = getDungeonName();
      // Track state locally so we don't depend on async React re-renders
      let currentState: DungeonActionResponse | null = gigaRef.current.dungeonState;

      while (autoPlayRef.current && !cancelled) {
        const g = gigaRef.current;
        const state = currentState ?? g.dungeonState;
        const run = state?.data?.run;
        const entity = state?.data?.entity;

        if (!run) {
          return { roomsCleared: lastRoomNum, won: false, finalHp: 0, maxHp: 0, dungeonName: capturedDungeonName };
        }

        // Death ends the run server-side, but the response that kills you comes
        // back as "Move Used" rather than "Run Complete" and still carries a
        // run object — so without this the loop keeps firing moves into a run
        // that no longer exists.
        const me = run.players?.[0];
        if (me && me.health.current <= 0) {
          addLog(`auto: died in room ${lastRoomNum}`);
          return {
            roomsCleared: lastRoomNum,
            won: false,
            finalHp: 0,
            maxHp: me.health.currentMax ?? 0,
            dungeonName: capturedDungeonName,
          };
        }

        // Re-capture dungeon name while entity is still available
        if (entity) {
          lastRoomNum = entity.ROOM_NUM_CID;
          const freshName = getDungeonName();
          if (freshName !== "Unknown") capturedDungeonName = freshName;
        }

        const action = pickBestAction(state!, g.enemyNames);
        if (!action) {
          // Refetch once in case our copy of the state is behind; if the server
          // agrees there's nothing to do, stop rather than spinning forever.
          addLog("auto: no valid action, refetching state");
          noActionStreak++;
          if (noActionStreak >= 3) {
            addLog("auto: no valid action after 3 tries, ending run");
            return { roomsCleared: lastRoomNum, won: false, finalHp: 0, maxHp: 0, dungeonName: capturedDungeonName };
          }
          const refetched = await g.fetchDungeonState();
          currentState = refetched;
          await delay(500);
          continue;
        }
        noActionStreak = 0;

        if (typeof action === "string" && action.startsWith("loot_")) {
          const idx = ["loot_one", "loot_two", "loot_three", "loot_four"].indexOf(action);
          const loot = run.lootOptions?.[idx];
          if (loot) {
            runBoonsRef.current.push(
              formatBoon(loot.boonTypeString, loot.selectedVal1, loot.selectedVal2)
            );
          }
        }

        // Awakening runs take their boons through the reward screen instead, so
        // the run summary has to read them from there or it comes out empty.
        if (typeof action === "string" && action.startsWith("reward_")) {
          const idx = ["reward_one", "reward_two", "reward_three"].indexOf(action);
          const reward = run.rewardPathOptions?.[idx];
          if (reward?.boon) {
            runBoonsRef.current.push(
              `${formatBoon(reward.boon.boonTypeString, reward.boon.selectedVal1, reward.boon.selectedVal2)} +${reward.gigusOrbAmount} Cores`
            );
          }
        }

        const explanation = explainAction(state!, action, g.enemyNames);
        addLog(`auto: ${explanation}`);

        const result = await g.performAction(action as DungeonAction);

        if (result) {
          trackEnemyMove(state ?? null, result);
          currentState = result;
          trackItemDrops(result);

          if (result.message === "Run Complete") {
            const p = result.data?.run?.players?.[0];
            const finalRoom = result.data?.entity?.ROOM_NUM_CID ?? lastRoomNum;
            return {
              roomsCleared: finalRoom,
              won: (p?.health.current ?? 0) > 0,
              finalHp: p?.health.current ?? 0,
              maxHp: p?.health.currentMax ?? 0,
              dungeonName: capturedDungeonName,
            };
          }

          const p = result.data?.run?.players?.[0];
          const e = result.data?.run?.players?.[1];
          if (p && e && !result.data?.run?.lootPhase) {
            addLog(`  ${p.health.current}hp vs ${e.health.current}hp`);
          }
        } else {
          addLog(`auto: action failed, recovering token...`);
          const fresh = await g.fetchDungeonState();
          if (fresh) {
            currentState = fresh;
          } else {
            addLog(`auto: recovery failed, stopping`);
            break;
          }
          await delay(500);
        }

        await delay(150);
      }
      return null; // cancelled
    };

    const loop = async () => {
      if (runningRef.current) return;
      runningRef.current = true;

      // Reset chain stats at the start
      chainStatsRef.current = { totalRuns: 0, wins: 0, losses: 0, totalRooms: 0, allItems: new Map() };
      setChainSummary(null);

      const chaining = !!chainModeRef.current;

      // Outer loop: run dungeons (once for single, repeat for chain)
      while (autoPlayRef.current && !cancelled) {
        const result = await runSingleDungeon();

        if (!result) break; // cancelled

        const summary = finishRun(result.roomsCleared, result.won, result.finalHp, result.maxHp, result.dungeonName);
        addLog(`auto: ${result.won ? "victory" : "defeated"} — ${result.roomsCleared} rooms`);

        if (!chaining) {
          // Single run mode — show summary and stop
          setRunSummary(summary);
          break;
        }

        // Chain mode — try to start next run
        await gigaRef.current.refreshAll();
        await delay(1000);

        if (!autoPlayRef.current || cancelled) break;

        const chain = chainModeRef.current;
        if (!chain) break;

        const cap = parseInt(chainCapRef.current, 10);
        if (cap > 0 && chainStatsRef.current.totalRuns >= cap) {
          addLog(`chain: run cap of ${cap} reached`);
          break;
        }

        addLog(`chain: starting run #${chainStatsRef.current.totalRuns + 1}...`);
        const startResult = await gigaRef.current.startRun(chain.dungeonId);

        if (!startResult || startResult.success === false) {
          addLog(`chain: can't start — ${startResult?.message || "out of energy?"}`);
          break;
        }

        addLog(`chain: ${chain.dungeonName} started`);
        await delay(500);
      }

      // Finalize
      if (chaining && chainStatsRef.current.totalRuns > 0) {
        setChainSummary(buildChainSummary());
        setRunSummary(null);
      }

      setAutoPlay(false);
      setChainMode(null);
      await gigaRef.current.refreshAll();
      runningRef.current = false;
    };

    loop();

    return () => {
      cancelled = true;
    };
  }, [autoPlay, connected, addLog]);

  const run = giga.dungeonState?.data?.run;
  const entity = giga.dungeonState?.data?.entity;
  const player = run?.players?.[0];
  const enemy = run?.players?.[1];
  const isLoot = run?.lootPhase;
  const inRun = !!run;
  const eng = giga.energy?.entities?.[0]?.parsedData;
  const stateScore = useMemo(
    () => giga.dungeonState ? evaluateState(giga.dungeonState) : 0,
    [giga.dungeonState]
  );
  const recommended = useMemo(
    () => giga.dungeonState ? pickBestAction(giga.dungeonState, giga.enemyNames) : null,
    [giga.dungeonState, giga.enemyNames]
  );

  // Track dungeon name while in a run so it's available after the run ends
  const lastDungeonNameRef = useRef("Unknown");
  useEffect(() => {
    if (inRun) {
      const name = getDungeonName();
      if (name !== "Unknown") lastDungeonNameRef.current = name;
    }
  }, [inRun, entity, getDungeonName]);

  // Detect run ending (inRun goes false) and auto-generate summary if missing
  const wasInRunRef = useRef(false);
  useEffect(() => {
    if (inRun) {
      wasInRunRef.current = true;
    } else if (wasInRunRef.current && !inRun && !runSummary) {
      // Run just ended without a summary being set — build one from last known state
      wasInRunRef.current = false;
      const won = (player?.health.current ?? 0) > 0;
      const rooms = entity?.ROOM_NUM_CID ?? 0;
      const items = buildItemSummary();
      const boons = [...runBoonsRef.current];
      setRunSummary({ roomsCleared: rooms, boons, items, finalHp: player?.health.current ?? 0, maxHp: player?.health.currentMax ?? 0, won });
      recordRunAction(lastDungeonNameRef.current, won, rooms, player?.health.current ?? 0, player?.health.currentMax ?? 0, items, boons, giga.address)
        .then(() => refreshRunStats()).catch(() => {});
      addLog("run ended");
      giga.refreshAll();
    }
  }, [inRun, runSummary, entity, player, addLog, giga, buildItemSummary, refreshRunStats]);

  // Nav badge counts (memoized to avoid recalculating on every render)
  const worldBadge = useMemo(() => {
    const isOnCooldown = (recipeId: string) => {
      const recipe = giga.worldRecipes.find((r) => r.docId === recipeId);
      const progress = giga.playerRecipes?.entities?.find((p) => p.ID_CID === recipeId);
      if (!recipe?.COOLDOWN_CID || !progress) return false;
      return (progress.END_TIMESTAMP_CID + recipe.COOLDOWN_CID) > Math.floor(Date.now() / 1000);
    };
    const hasPaperHands = giga.gearInstances?.entities?.some((g) => {
      const name = giga.itemInfo[String(g.GAME_ITEM_ID_CID)]?.name || "";
      return name.toLowerCase().includes("paper");
    }) ?? false;
    const hasRockHands = giga.gearInstances?.entities?.some((g) => {
      const name = giga.itemInfo[String(g.GAME_ITEM_ID_CID)]?.name || "";
      return name.toLowerCase().includes("rock");
    }) ?? false;
    // Counted off the shared table so a new claim cannot be shown in the panel
    // while the nav badge silently ignores it.
    return CLAIM_RECIPES.filter((r) => {
      if (isOnCooldown(r.id)) return false;
      if (r.needsJuice && !eng?.isPlayerJuiced) return false;
      if (r.handsType === "Paper Hands" && !hasPaperHands) return false;
      if (r.handsType === "Rock Hands" && !hasRockHands) return false;
      return true;
    }).length;
  }, [giga.worldRecipes, giga.playerRecipes, giga.gearInstances, giga.itemInfo, eng?.isPlayerJuiced]);

  const upgradableBadge = useMemo(() => {
    return giga.skillTrees.filter((tree) => {
      const prog = giga.skillProgress.find((p) => p.SKILL_CID === Number(tree.docId));
      const totalLvl = prog?.LEVEL_CID ?? 0;
      const nextCost = tree.xpPerLvl?.[totalLvl + 1];
      const currencyBal = giga.itemBalances[String(tree.GAME_ITEM_ID_CID)] ?? 0;
      return nextCost !== undefined && currencyBal >= nextCost;
    }).length;
  }, [giga.skillTrees, giga.skillProgress, giga.itemBalances]);

  // Daily completion strip — one glance answers "am I done for today?"
  const daily = useMemo(() => {
    const juiced = eng?.isPlayerJuiced ?? false;
    const dungeons = (giga.dungeonToday?.dungeonDataEntities ?? []).filter((d) => d.ENERGY_CID > 0);
    const dayProgress = giga.dungeonToday?.dayProgressEntities ?? [];
    let runsUsed = 0;
    let runsMax = 0;
    for (const d of dungeons) {
      const p = dayProgress.find((pp) => pp.ID_CID === `Dungeon#${d.ID_CID}`);
      runsUsed += p?.UINT256_CID ?? 0;
      runsMax += getMaxRunsPerDay(d, juiced);
    }
    const fs = giga.fishingState;
    const castsToday = fs ? castsUsedToday(fs) : null;
    const maxCasts = fs
      ? (juiced ? (fs.maxPerDayJuiced ?? FISHING.juicedMaxCastsPerDay) : (fs.maxPerDay ?? FISHING.maxCastsPerDay))
      : null;
    const allDone =
      runsMax > 0 &&
      runsUsed >= runsMax &&
      castsToday !== null && maxCasts !== null && castsToday >= maxCasts &&
      worldBadge === 0 &&
      hasVoted;
    return { runsUsed, runsMax, castsToday, maxCasts, allDone };
  }, [giga.dungeonToday, giga.fishingState, eng?.isPlayerJuiced, worldBadge, hasVoted]);

  /* ─── Restoring session ──────────────────────────────── */
  if (giga.restoringSession) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="text-[13px] pulse-glow" role="status" style={{ color: "var(--text-faint)" }}>
          Restoring session...
        </div>
      </main>
    );
  }

  /* ─── Login ─────────────────────────────────────────── */
  if (!connected) {
    return (
      <main className="min-h-screen flex items-center justify-center p-5" style={{ background: `radial-gradient(ellipse at 50% 30%, rgba(232,134,58,0.06) 0%, var(--bg) 70%)` }}>
        <div className="w-full max-w-sm anim-in">
          {/* Brand */}
          <div className="mb-6 flex items-center gap-3">
            <img src="/gigabrain-icon.png" alt="GigaBrain" width={40} height={40} style={{ imageRendering: "pixelated" }} />
            <div>
              <h1 className="text-3xl font-bold tracking-tight" style={{ letterSpacing: "-0.02em" }}>
                GigaBrain
              </h1>
              <p className="text-[13px] mt-1" style={{ color: "var(--text-dim)" }}>
                Gigaverse Automation
              </p>
            </div>
          </div>

          {/* Card */}
          <div className="p-5 rounded-xl" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}>

            {/* Primary: Wallet connect */}
            <button
              onClick={handleWalletLogin}
              disabled={giga.loading}
              className="btn-press cta-orange w-full py-3 text-[13px] font-bold rounded-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed mb-4"
              style={{
                boxShadow: "0 2px 8px var(--orange-glow), 0 1px 0 var(--orange-dim)",
              }}
            >
              {giga.loading
                ? "Connecting..."
                : walletConnected
                  ? "Sign & Connect"
                  : "Connect Wallet"}
            </button>

            <p className="text-[11px] -mt-2 mb-4" style={{ color: "var(--text-faint)", lineHeight: 1.5 }}>
              This signs a login message to prove you own the wallet — no transaction, no gas, no
              spending approval. GigaBrain never asks for private keys or seed phrases.
            </p>

            {walletConnected && walletAddress && (
              <div className="text-[11px] text-center mb-4 -mt-2" style={{ color: "var(--text-faint)" }}>
                {walletAddress.slice(0, 6)}&hellip;{walletAddress.slice(-4)}
                <button
                  onClick={() => walletLogout()}
                  className="ml-2 cursor-pointer"
                  style={{ background: "none", border: "none", padding: 0, color: "var(--orange)", textDecoration: "underline", textUnderlineOffset: 2 }}
                >
                  disconnect
                </button>
              </div>
            )}

            {/* Divider */}
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em]" style={{ color: "var(--text-faint)" }}>
                or
              </span>
              <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
            </div>

            {/* Fallback: Manual JWT paste */}
            {!showManualLogin ? (
              <button
                onClick={() => setShowManualLogin(true)}
                className="w-full text-[11px] font-medium cursor-pointer py-2"
                style={{ background: "none", border: "none", color: "var(--text-faint)" }}
              >
                Paste JWT manually
              </button>
            ) : (
              <div className="anim-in">
                <label className="text-[11px] font-semibold uppercase tracking-[0.1em] block mb-2" style={{ color: "var(--text-faint)" }}>
                  Session Token
                </label>
                <ol className="text-[11px] mb-2 space-y-1 list-decimal list-inside" style={{ color: "var(--text-dim)", lineHeight: 1.5 }}>
                  <li>Log in at gigaverse.io in another tab</li>
                  <li>Open the browser console there (F12 → Console)</li>
                  <li>
                    Run{" "}
                    <code className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--bg-inset)", color: "var(--text-dim)", overflowWrap: "anywhere" }}>
                      JSON.parse(localStorage.authResponse).jwt
                    </code>
                  </li>
                  <li>Paste the result below</li>
                </ol>
                <p className="text-[11px] mb-3" style={{ color: "var(--text-faint)", lineHeight: 1.5 }}>
                  Treat the token like a password — it grants full access to your Gigaverse account.
                  It stays in this browser and is used only to call the Gigaverse API.
                </p>
                <textarea
                  value={jwtInput}
                  onChange={(e) => setJwtInput(e.target.value)}
                  placeholder="eyJhbGci..."
                  rows={3}
                  className="w-full p-3 text-[13px] rounded-lg resize-none mb-3"
                  style={{
                    background: "var(--bg-inset)",
                    border: "1px solid var(--border)",
                    color: "var(--text)",
                  }}
                />
                <button
                  onClick={handleConnect}
                  disabled={!jwtInput || giga.loading}
                  className="btn-press w-full py-2.5 text-[13px] font-semibold rounded-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{
                    background: "var(--bg-inset)",
                    color: "var(--text-dim)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {giga.loading ? "Connecting..." : "Connect with JWT"}
                </button>
              </div>
            )}
          </div>

          {giga.error && (
            <p role="alert" className="text-[12px] mt-3 px-3 py-2 rounded-lg" style={{ color: "var(--red)", background: "var(--red-glow)" }}>
              {giga.error}
            </p>
          )}
        </div>
      </main>
    );
  }

  /* ─── Dashboard (HUD + Icon Rail + Flyout layout) ──── */

  // Helper: get enemy display name from entity
  const currentEnemyName = entity
    ? (giga.enemyNames[String(entity.ENEMY_CID)]
      || giga.enemyNames[`idx:${entity.ENEMY_CID}`])?.name
    : undefined;

  return (
    <div className="min-h-screen flex flex-col">

      {/* ── Top HUD Bar ── */}
      <header
        className="hud-bar shrink-0 flex flex-col justify-center px-6 anim-in"
        style={{
          height: 72,
          background: "var(--bg-raised)",
          borderBottom: "1px solid var(--border)",
          zIndex: 50,
        }}
      >
        {/* Row 1: Primary info */}
        <div className="flex items-center gap-3 md:gap-5">
          {/* App brand */}
          <div className="flex items-center gap-2.5 shrink-0">
            <img src="/gigabrain-icon.png" alt="GigaBrain" width={24} height={24} style={{ imageRendering: "pixelated" }} />
            <h1 className="text-[17px] font-bold tracking-tight">GigaBrain</h1>
          </div>

          <div className="w-px h-5 shrink-0" style={{ background: "var(--border)" }} />

          {/* Energy */}
          <div className="flex items-center gap-3 shrink-0" title="Energy — regenerates over time, used for dungeons, fishing, pots">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--text-dim)" }}>Energy</div>
              <div className="flex items-baseline gap-1">
                <span className="text-[18px] font-bold tabular-nums" style={{ color: "var(--orange)" }}>
                  {eng ? Math.floor(eng.energyValue) : "--"}
                </span>
                {eng && <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>/ {eng.maxEnergy}</span>}
              </div>
            </div>
            {eng && (
              <div className="hud-detail flex flex-col gap-1">
                <div className="rounded-full overflow-hidden" style={{ width: 80, height: 6, background: "var(--bg-inset)" }}>
                  <div className="h-full rounded-full" style={{ width: `${Math.min(100, (Math.floor(eng.energyValue) / eng.maxEnergy) * 100)}%`, background: "var(--orange)" }} />
                </div>
                <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                  +{eng.regenPerHour.toFixed(1)}/hr
                  {eng.isPlayerJuiced && (() => {
                    const exp = giga.juiceExpiry;
                    let remaining = "";
                    if (exp) {
                      const secs = exp - Math.floor(Date.now() / 1000);
                      if (secs > 0) {
                        const days = Math.floor(secs / 86400);
                        const hours = Math.floor((secs % 86400) / 3600);
                        remaining = days > 0 ? ` ${days}d ${hours}h` : ` ${hours}h`;
                      }
                    }
                    return <span className="font-bold ml-1" style={{ color: "var(--gold)" }}>JUICED{remaining}</span>;
                  })()}
                </span>
              </div>
            )}
          </div>

          <div className="hud-detail w-px h-5 shrink-0" style={{ background: "var(--border)" }} />

          {/* Dungeon status */}
          <div className="hud-detail shrink-0" title="Current dungeon run status">
            <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--text-dim)" }}>Dungeon</div>
            <div className="flex items-center gap-2">
              <span
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{ background: inRun ? "var(--green)" : "var(--text-faint)" }}
              />
              <span className="text-[14px] font-semibold" style={{ color: inRun ? "var(--green)" : "var(--text-faint)" }}>
                {inRun && entity
                  ? `Floor ${Math.ceil(entity.ROOM_NUM_CID / 4)} Room ${((entity.ROOM_NUM_CID - 1) % 4) + 1}`
                  : "Idle"}
              </span>
              {inRun && currentEnemyName && (
                <span className="text-[13px] font-medium" style={{ color: "var(--red)" }}>
                  vs {currentEnemyName}
                </span>
              )}
              {isLoot && (
                <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: "var(--gold-glow)", color: "var(--gold)" }}>
                  LOOT
                </span>
              )}
            </div>
          </div>

          <div className="hud-detail w-px h-5 shrink-0" style={{ background: "var(--border)" }} />

          {/* Daily completion strip */}
          <div className="hud-detail shrink-0">
            <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--text-dim)" }}>Today</div>
            {daily.allDone ? (
              <div className="text-[13px] font-semibold" style={{ color: "var(--green)" }}>✓ Done for today</div>
            ) : (
              <div className="flex items-center gap-3 text-[13px] font-semibold tabular-nums">
                <span
                  className="flex items-center gap-1"
                  title={`Dungeon runs used today: ${daily.runsUsed} of ${daily.runsMax}`}
                  aria-label={`Dungeon runs used today: ${daily.runsUsed} of ${daily.runsMax}`}
                  style={{ color: daily.runsMax > 0 && daily.runsUsed >= daily.runsMax ? "var(--green)" : "var(--text-dim)" }}
                >
                  <Sword size={13} aria-hidden="true" /> {daily.runsUsed}/{daily.runsMax}
                </span>
                {daily.castsToday !== null && daily.maxCasts !== null && (
                  <span
                    className="flex items-center gap-1"
                    title={`Fishing casts used today: ${daily.castsToday} of ${daily.maxCasts}`}
                    aria-label={`Fishing casts used today: ${daily.castsToday} of ${daily.maxCasts}`}
                    style={{ color: daily.castsToday >= daily.maxCasts ? "var(--green)" : "var(--text-dim)" }}
                  >
                    <Fish size={13} aria-hidden="true" /> {daily.castsToday}/{daily.maxCasts}
                  </span>
                )}
                <span
                  className="flex items-center gap-1"
                  title={worldBadge > 0 ? `${worldBadge} chest${worldBadge === 1 ? "" : "s"}/pot${worldBadge === 1 ? "" : "s"} ready to open` : "All chests and pots on cooldown"}
                  aria-label={worldBadge > 0 ? `${worldBadge} chests or pots ready to open` : "All chests and pots on cooldown"}
                  style={{ color: worldBadge > 0 ? "var(--gold)" : "var(--green)" }}
                >
                  <Package size={13} aria-hidden="true" /> {worldBadge > 0 ? worldBadge : "✓"}
                </span>
                {walletConnected && (
                  <span
                    className="flex items-center gap-1"
                    title={hasVoted ? "Voted on the Abstract portal today" : "Portal vote not cast yet"}
                    aria-label={hasVoted ? "Voted on the Abstract portal today" : "Portal vote not cast yet"}
                    style={{ color: hasVoted ? "var(--green)" : "var(--text-dim)" }}
                  >
                    <Vote size={13} aria-hidden="true" /> {hasVoted ? "✓" : "–"}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Spacer */}
          <div className="flex-1 min-w-0" />

          {/* Right cluster */}
          <div className="flex items-center gap-5 shrink-0">
            {giga.loading && (
              <span className="hud-detail text-[12px] font-semibold pulse-glow" style={{ color: "var(--orange)" }}>syncing...</span>
            )}



            {/* Portal vote */}
            {walletConnected && (
              <div className="hud-detail-secondary shrink-0" title="Abstract Portal — vote for Gigaverse to earn XP">
                <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--text-dim)" }}>Vote</div>
                {hasVoted ? (
                  <div className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: "var(--green)" }}>
                    <Vote size={15} /> Voted
                  </div>
                ) : (
                  <button
                    onClick={handleVote}
                    disabled={voting || !abstractClient}
                    className="btn-press text-[12px] font-bold px-3 py-1 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                    style={{ background: "var(--orange-glow)", border: "1px solid var(--border-accent)", color: "var(--orange)" }}
                  >
                    <Vote size={14} />
                    {voting ? "Signing..." : "Vote Now"}
                  </button>
                )}
              </div>
            )}

            {/* User menu */}
            <div className="relative shrink-0">
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                aria-expanded={userMenuOpen}
                aria-haspopup="menu"
                className="flex items-center gap-2 cursor-pointer px-2.5 py-1.5 rounded-md"
                style={{
                  background: userMenuOpen ? "var(--bg-inset)" : "transparent",
                  border: userMenuOpen ? "1px solid var(--border)" : "1px solid transparent",
                  color: "var(--text-dim)",
                }}
              >
                <span className="text-[13px] font-medium" style={{ color: "var(--orange)" }}>
                  {giga.username || `${giga.address.slice(0, 6)}\u2026${giga.address.slice(-4)}`}
                </span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: userMenuOpen ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {userMenuOpen && (
                <>
                  <div className="fixed inset-0" style={{ zIndex: 60 }} onClick={() => setUserMenuOpen(false)} />
                  <div
                    role="menu"
                    className="absolute right-0 mt-1 py-1 rounded-lg shadow-lg"
                    style={{ zIndex: 65, width: 200, background: "var(--bg-raised)", border: "1px solid var(--border)" }}
                  >
                    <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
                      <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>Signed in as</div>
                      <div className="text-[12px] font-medium truncate" style={{ color: "var(--text)" }}>
                        {giga.username || giga.address}
                      </div>
                      <div className="text-[10px] truncate mt-0.5" style={{ color: "var(--text-faint)" }}>
                        {giga.address.slice(0, 10)}&hellip;{giga.address.slice(-6)}
                      </div>
                    </div>
                    <button
                      role="menuitem"
                      onClick={() => { giga.disconnect(); walletLogout(); setConnected(false); setUserMenuOpen(false); }}
                      className="w-full text-left px-3 py-2 text-[12px] cursor-pointer"
                      style={{ background: "none", border: "none", color: "var(--red)" }}
                    >
                      Logout
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

      </header>

      {/* ── Body: Icon Rail + Main + Flyout ── */}
      <div className="body-layout flex flex-1 min-h-0">

        {/* ── Icon Rail (expandable) ── */}
        <nav
          aria-label="Main navigation"
          className="nav-rail shrink-0 flex flex-col py-3 gap-1.5 anim-in"
          style={{
            width: railExpanded ? 180 : 56,
            background: "var(--bg-raised)",
            borderRight: "1px solid var(--border)",
            overflow: "hidden",
          }}
        >
          {/* Toggle expand/collapse */}
          <button
            onClick={() => setRailExpanded(!railExpanded)}
            aria-label={railExpanded ? "Collapse sidebar" : "Expand sidebar"}
            className="nav-rail-hide cursor-pointer flex items-center gap-2.5 rounded-md mx-auto mb-1"
            style={{
              width: railExpanded ? 164 : 42,
              height: 32,
              background: "transparent",
              border: "1px solid transparent",
              color: "var(--text-faint)",
              transition: "background 150ms ease, border-color 150ms ease, color 150ms ease",
              paddingLeft: railExpanded ? 12 : 0,
              justifyContent: railExpanded ? "flex-start" : "center",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: railExpanded ? "rotate(180deg)" : "none", transition: "transform 200ms ease" }}>
              <path d="M9 18l6-6-6-6" />
            </svg>
            {railExpanded && <span className="text-[11px] font-medium">Collapse</span>}
          </button>

          {/* Tab icons */}
          {([
              { id: "mission" as const, icon: Rocket, label: "Mission Control", badge: 0 },
              { id: "dungeon" as const, icon: Sword, label: "Dungeon", badge: 0 },
              { id: "fishing" as const, icon: Fish, label: "Fishing", badge: 0 },
              { id: "stats" as const, icon: BarChart3, label: "Stats & Intel", badge: 0 },
              { id: "roms" as const, icon: HardDrive, label: "ROMs", badge: 0 },
              { id: "world" as const, icon: Package, label: "Pots & Chests", badge: worldBadge },
            ] as const).map((item) => {
              const Icon = item.icon;
              const active = activePage === item.id && !flyout;
              return (
                <button
                  key={item.id}
                  onClick={() => { setActivePage(item.id); setFlyout(null); }}
                  title={railExpanded ? undefined : item.label}
                  aria-label={item.badge > 0 ? `${item.label}, ${item.badge} ready` : item.label}
                  aria-current={active ? "page" : undefined}
                  className="cursor-pointer flex items-center gap-2.5 rounded-md mx-auto relative"
                  style={{
                    width: railExpanded ? 164 : 42,
                    height: 44,
                    paddingLeft: railExpanded ? 12 : 0,
                    justifyContent: railExpanded ? "flex-start" : "center",
                    background: active ? "var(--orange-glow)" : "transparent",
                    border: active ? "1px solid var(--border-accent)" : "1px solid transparent",
                    color: active ? "var(--orange)" : "var(--text-faint)",
                    transition: "background 150ms ease, border-color 150ms ease, color 150ms ease",
                  }}
                >
                  <span className="relative shrink-0">
                    <Icon size={20} />
                    {item.badge > 0 && (
                      <span
                        className="absolute flex items-center justify-center text-[9px] font-bold"
                        style={{
                          top: -6,
                          right: -8,
                          minWidth: 16,
                          height: 16,
                          borderRadius: 8,
                          background: "var(--green)",
                          color: "var(--bg)",
                          padding: "0 4px",
                        }}
                      >
                        {item.badge}
                      </span>
                    )}
                  </span>
                  {railExpanded && (
                    <span className="nav-label text-[13px] font-medium truncate">
                      {item.label}
                      {item.badge > 0 && (
                        <span className="ml-1.5 text-[11px] font-bold" style={{ color: "var(--green)" }}>
                          {item.badge}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              );
            })
          }

          {/* Divider */}
          <div className="nav-rail-hide mx-auto my-1" style={{ width: railExpanded ? 148 : 24, height: 1, background: "var(--border)" }} />

          {/* Flyout icons */}
          {([
              { id: "skills" as const, icon: Star, label: "Skills", badge: upgradableBadge },
              { id: "log" as const, icon: ScrollText, label: "Activity Log", badge: 0 },
              { id: "support" as const, icon: Heart, label: "Support", badge: 0 },
            ] as const).map((item) => {
              const Icon = item.icon;
              const active = flyout === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setFlyout(active ? null : item.id)}
                  title={railExpanded ? undefined : item.label}
                  aria-label={item.badge > 0 ? `${item.label}, ${item.badge} upgrades ready` : item.label}
                  aria-expanded={active}
                  className="cursor-pointer flex items-center gap-2.5 rounded-md mx-auto relative"
                  style={{
                    width: railExpanded ? 164 : 42,
                    height: 44,
                    paddingLeft: railExpanded ? 12 : 0,
                    justifyContent: railExpanded ? "flex-start" : "center",
                    background: active ? "var(--orange-glow)" : "transparent",
                    border: active ? "1px solid var(--border-accent)" : "1px solid transparent",
                    color: active ? "var(--orange)" : "var(--text-faint)",
                    transition: "background 150ms ease, border-color 150ms ease, color 150ms ease",
                  }}
                >
                  <span className="relative shrink-0">
                    <Icon size={20} />
                    {item.badge > 0 && (
                      <span
                        className="absolute flex items-center justify-center text-[9px] font-bold"
                        style={{
                          top: -6,
                          right: -8,
                          minWidth: 16,
                          height: 16,
                          borderRadius: 8,
                          background: "var(--green)",
                          color: "var(--bg)",
                          padding: "0 4px",
                        }}
                      >
                        {item.badge}
                      </span>
                    )}
                  </span>
                  {railExpanded && (
                    <span className="nav-label text-[13px] font-medium truncate">
                      {item.label}
                      {item.badge > 0 && (
                        <span className="ml-1.5 text-[11px] font-bold" style={{ color: "var(--green)" }}>
                          {item.badge} ready
                        </span>
                      )}
                    </span>
                  )}
                </button>
              );
            })
          }

          {/* Spacer */}
          <div className="nav-rail-hide flex-1" />

          {/* Refresh button at bottom */}
          <button
            onClick={() => giga.refreshAll()}
            title={railExpanded ? undefined : "Refresh"}
            aria-label="Refresh all data"
            className="nav-rail-hide cursor-pointer flex items-center gap-2.5 rounded-md mx-auto mb-1"
            style={{
              width: railExpanded ? 164 : 42,
              height: 36,
              paddingLeft: railExpanded ? 12 : 0,
              justifyContent: railExpanded ? "flex-start" : "center",
              background: "transparent",
              border: "1px solid transparent",
              color: "var(--text-faint)",
              transition: "background 150ms ease, border-color 150ms ease, color 150ms ease",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 16h5v5" />
            </svg>
            {railExpanded && <span className="text-[12px] font-medium">Refresh</span>}
          </button>
        </nav>

        {/* ── Flyout Panel Overlay ── */}
        {flyout && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 flyout-backdrop"
              style={{ zIndex: 40 }}
              onClick={() => setFlyout(null)}
            />
            {/* Panel */}
            <div
              role="dialog"
              aria-label={flyout === "skills" ? "Skills" : flyout === "support" ? "Support" : "Activity Log"}
              className="fixed top-[72px] bottom-0 flyout-panel"
              style={{
                left: railExpanded ? 180 : 56,
                width: 360,
                background: "var(--bg-raised)",
                borderRight: "1px solid var(--border)",
                zIndex: 45,
                overflowY: "auto",
                overscrollBehavior: "contain",
              }}
            >
              {/* Flyout header */}
              <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
                <span className="text-[18px] font-bold">
                  {flyout === "skills" ? "Skills" : flyout === "support" ? "Support GigaBrain" : "Activity Log"}
                </span>
                <button
                  onClick={() => setFlyout(null)}
                  aria-label="Close panel"
                  className="cursor-pointer flex items-center justify-center rounded"
                  style={{ width: 32, height: 32, background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text-faint)" }}
                >
                  <X size={16} />
                </button>
              </div>

              {/* Flyout content */}
              <div className="p-5">


                {/* Skills flyout */}
                {flyout === "skills" && (
                  giga.skillTrees.length > 0 ? (
                    <div className="space-y-3">

                      {/* Advisor: recommended upgrade queue */}
                      {skillAdvice && skillAdvice.upgrades.length > 0 && (
                        <div className="p-4 rounded-lg" style={{ background: "var(--bg-inset)", border: "1px solid var(--border-accent)" }}>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[13px] font-bold" style={{ color: "var(--gold)" }}>Recommended</span>
                            <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                              {skillAdvice.upgrades.length} upgrade{skillAdvice.upgrades.length === 1 ? "" : "s"}
                            </span>
                          </div>
                          <div className="space-y-1.5 mb-3">
                            {skillAdvice.upgrades.map((u, i) => (
                              <div key={i} className="text-[12px]" style={{ color: "var(--text-dim)", lineHeight: 1.45 }}>
                                <span className="font-semibold" style={{ color: "var(--text)" }}>
                                  {u.statName} → Lv{u.fromLevel + 1}
                                </span>
                                <span className="tabular-nums" style={{ color: "var(--text-faint)" }}> ({u.cost} {giga.itemInfo[String(u.currencyItemId)]?.name || "currency"})</span>
                                <div style={{ color: "var(--text-faint)" }}>{u.reason}</div>
                              </div>
                            ))}
                          </div>
                          <button
                            onClick={() => applySkillUpgrades(skillAdvice.upgrades)}
                            disabled={applyingSkills}
                            className="btn-press w-full text-[12px] font-bold py-2 rounded-lg cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            style={{ background: "var(--orange-glow)", border: "1px solid var(--border-accent)", color: "var(--orange)" }}
                          >
                            {applyingSkills ? "Applying..." : `Apply all (${Object.entries(skillAdvice.totalCostByCurrency).map(([id, c]) => `${c} ${giga.itemInfo[id]?.name || "currency"}`).join(" + ")})`}
                          </button>
                        </div>
                      )}

                      {/* Respec + save-up notes */}
                      {skillAdvice && (skillAdvice.respec.length > 0 || skillAdvice.nextGoals.length > 0) && (
                        <div className="space-y-1.5">
                          {skillAdvice.respec.map((r, i) => (
                            <div key={`r${i}`} className="p-3 rounded-lg text-[12px]" style={{ background: "var(--red-glow)", border: "1px solid var(--red-border)", color: "var(--red)", lineHeight: 1.45 }}>
                              <span className="font-bold">{r.treeName} respec: </span>{r.note}
                            </div>
                          ))}
                          {skillAdvice.nextGoals.map((g, i) => (
                            <div key={`g${i}`} className="text-[12px] px-1" style={{ color: "var(--text-faint)", lineHeight: 1.45 }}>
                              Next: {g}
                            </div>
                          ))}
                        </div>
                      )}

                      {giga.skillTrees.map((tree) => {
                        const prog = giga.skillProgress.find((p) => p.SKILL_CID === Number(tree.docId));
                        const totalLvl = prog?.LEVEL_CID ?? 0;
                        const maxLvl = tree.LEVEL_CID || 100;
                        const nextCost = tree.xpPerLvl?.[totalLvl + 1];
                        const currencyBal = giga.itemBalances[String(tree.GAME_ITEM_ID_CID)] ?? 0;
                        const canUpgrade = nextCost !== undefined && currencyBal >= nextCost && totalLvl < maxLvl;
                        const currencyName = giga.itemInfo[String(tree.GAME_ITEM_ID_CID)]?.name || `Item#${tree.GAME_ITEM_ID_CID}`;

                        return (
                          <div key={tree.docId} className="p-4 rounded-lg" style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}>
                            <div className="flex items-center justify-between">
                              <span className="text-[14px] font-semibold" style={{ color: canUpgrade ? "var(--green)" : "var(--text-dim)" }}>
                                {tree.name}
                              </span>
                              <span className="text-[13px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                                Lv {totalLvl}/{maxLvl}
                              </span>
                            </div>
                            <div className="text-[11px] tabular-nums mt-0.5 mb-2" style={{ color: "var(--text-faint)" }}>
                              {totalLvl >= maxLvl ? "MAX" : nextCost !== undefined ? `next level: ${nextCost} · have ${currencyBal} ${currencyName}` : ""}
                            </div>

                            {/* Per-stat rows with upgrade buttons */}
                            <div className="space-y-1">
                              {tree.stats.map((stat) => {
                                const lvl = prog?.LEVEL_CID_array?.[stat.id] ?? 0;
                                const isRecommended = skillAdvice?.upgrades[0]?.skillId === Number(tree.docId) && skillAdvice.upgrades[0]?.statId === stat.id;
                                return (
                                  <div key={stat.id} className="flex items-center gap-2">
                                    <span className="flex-1 min-w-0 text-[12px] truncate" style={{ color: isRecommended ? "var(--gold)" : "var(--text-dim)" }} title={stat.desc}>
                                      {stat.name}
                                    </span>
                                    {isRecommended && <RecBadge />}
                                    <span className="text-[12px] tabular-nums" style={{ color: "var(--text-faint)" }}>Lv {lvl}</span>
                                    <button
                                      onClick={() => applySkillUpgrades([{ skillId: Number(tree.docId), statId: stat.id, statName: stat.name }])}
                                      disabled={!canUpgrade || applyingSkills}
                                      aria-label={`Upgrade ${stat.name} to level ${lvl + 1}`}
                                      className="btn-press text-[11px] font-bold px-2 py-0.5 rounded cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed"
                                      style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", color: canUpgrade ? "var(--green)" : "var(--text-faint)" }}
                                    >
                                      +
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>No skill trees available.</p>
                  )
                )}

                {/* Support flyout */}
                {flyout === "support" && (
                  <div className="space-y-4">
                    <p className="text-[13px]" style={{ color: "var(--text-dim)", lineHeight: 1.55 }}>
                      GigaBrain is free. If it&apos;s earning you scrap, a donation keeps it maintained.
                    </p>

                    {DONATIONS.kofi && (
                      <a
                        href={`https://ko-fi.com/${DONATIONS.kofi}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-press cta-orange flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-[13px] font-bold"
                        style={{ textDecoration: "none" }}
                      >
                        <Heart size={15} /> Ko-fi
                      </a>
                    )}

                    {DONATIONS.wallets.map((w) => (
                      <div key={w.label} className="p-3 rounded-lg" style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>{w.label}</span>
                          <button
                            onClick={() => { navigator.clipboard.writeText(w.address); addLog(`${w.label} address copied`); }}
                            className="btn-press flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded cursor-pointer"
                            style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
                          >
                            <Copy size={11} /> Copy
                          </button>
                        </div>
                        <div className="text-[11px] break-all tabular-nums" style={{ color: "var(--text-dim)", fontFamily: "monospace" }}>
                          {w.address}
                        </div>
                      </div>
                    ))}

                    <p className="text-[11px]" style={{ color: "var(--text-faint)", lineHeight: 1.5 }}>
                      Never send private keys or seed phrases to anyone — this panel only ever shows receive addresses.
                    </p>
                  </div>
                )}

                {/* Activity Log flyout */}
                {flyout === "log" && (
                  <div
                    className="log-area"
                    role="log"
                    style={{
                      maxHeight: "calc(100vh - 140px)",
                      overflowY: "auto",
                      background: "var(--bg-inset)",
                      borderRadius: 6,
                      padding: "12px 14px",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <LogFeed entries={log} emptyText="Waiting for actions." fade />
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* ── Main Content Area ── */}
        <main className="main-content flex-1 min-w-0 overflow-y-auto" style={{ padding: "clamp(20px, 3vw, 40px)" }}>

          {/* ── Mission Control Page ── */}
          {activePage === "mission" && (
            <MissionControlPage
              giga={giga}
              addLog={addLog}
              handleVote={handleVote}
              hasVoted={hasVoted}
              refreshRunStats={refreshRunStats}
            />
          )}

          {/* ── Stats Page ── */}
          {activePage === "stats" && (
            <StatsPage
              runStats={runStats}
              enemyNames={giga.enemyNames}
              itemInfo={giga.itemInfo}
            />
          )}

          {/* ── Fishing Page ── */}
          {activePage === "fishing" && (
            <FishingPage
              giga={giga}
              addLog={addLog}
            />
          )}

          {/* ── ROMs Page ── */}
          {activePage === "roms" && giga.roms?.entities && (
            <RomsPage
              roms={giga.roms.entities}
              onClaimRom={giga.claimRom}
              onConvertToDust={giga.convertEnergyToDust}
              onRefresh={giga.refreshAll}
              loading={giga.loading}
              addLog={addLog}
            />
          )}

          {/* ── World (Pots & Chests) Page ── */}
          {activePage === "world" && (
            <WorldPage giga={giga} addLog={addLog} eng={eng} />
          )}

          {/* ── Dungeon Page ── */}
          {activePage === "dungeon" && <>

          {/* Header bar */}
          <div className="flex items-center justify-between mb-6 anim-in">
            <div className="flex items-center gap-3">
              <SectionLabel>Dungeon</SectionLabel>
              {entity && (
                <div className="flex items-center gap-2.5">
                  <span className="font-bold text-[20px] tabular-nums" style={{ color: "var(--text)", letterSpacing: "-0.02em" }}>
                    Floor {Math.ceil(entity.ROOM_NUM_CID / 4)}
                  </span>
                  <span className="text-[16px] tabular-nums" style={{ color: "var(--text-faint)" }}>/</span>
                  <span className="font-bold text-[20px] tabular-nums" style={{ color: "var(--text)", letterSpacing: "-0.02em" }}>
                    Room {((entity.ROOM_NUM_CID - 1) % 4) + 1}
                  </span>
                  <span
                    className="text-[11px] font-medium px-2 py-0.5 rounded tabular-nums"
                    style={{ color: "var(--text-faint)", background: "var(--bg-raised)" }}
                  >
                    {entity.ROOM_NUM_CID}/16
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Auto-play controls */}
          <div
            className="flex items-center gap-4 mb-6 p-4 rounded-lg anim-in"
            style={{
              background: autoPlay ? "var(--orange-glow)" : "var(--bg-raised)",
              border: `1px solid ${autoPlay ? "var(--border-accent)" : "var(--border)"}`,
              animationDelay: "40ms",
            }}
          >
            <button
              onClick={() => setAutoPlay(!autoPlay)}
              disabled={!inRun && !autoPlay}
              className="btn-press text-[12px] font-bold px-5 py-2 rounded-md cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: autoPlay ? "linear-gradient(135deg, var(--orange-lite), var(--orange))" : "var(--bg-inset)",
                color: autoPlay ? "var(--on-orange)" : "var(--text-dim)",
                border: autoPlay ? "none" : "1px solid var(--border)",
                boxShadow: autoPlay ? "0 2px 8px var(--orange-glow)" : "none",
                minWidth: 110,
              }}
            >
              {autoPlay ? "Stop" : "Auto-play"}
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {autoPlay && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full pulse-glow" style={{ background: "var(--orange)" }} />
                )}
                <span className="text-[12px] font-medium" style={{ color: autoPlay ? "var(--orange)" : "var(--text-faint)" }}>
                  {autoPlay ? (chainMode ? `Chaining ${chainMode.dungeonName}` : "Running") : "Paused"}
                </span>
                {autoPlay && chainMode && (
                  <span className="text-[10px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                    run #{chainStatsRef.current.totalRuns + 1}
                  </span>
                )}
                {inRun && recommended && !autoPlay && (
                  <span className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                    {"\u2014 next: "}
                    <span className="font-semibold" style={{ color: MOVE_COLORS[recommended as string] || "var(--text)" }}>
                      {MOVE_LABELS[recommended as keyof typeof MOVE_LABELS] ?? recommended}
                    </span>
                  </span>
                )}
              </div>
              {inRun && (
                <div
                  className="text-[10px] mt-0.5 tabular-nums"
                  style={{ color: "var(--text-faint)" }}
                  title="The auto-battler's read on the current fight — positive means you're ahead"
                >
                  advantage: {stateScore.toFixed(2)}
                </div>
              )}
            </div>
            <label className="flex items-center gap-1.5 text-[11px] shrink-0" style={{ color: "var(--text-faint)" }}>
              Chain cap
              <input
                type="number"
                min={1}
                placeholder="∞"
                value={chainCap}
                onChange={(e) => setChainCap(e.target.value)}
                disabled={autoPlay}
                title="Stop chaining after this many runs (blank = until energy runs out)"
                className="w-14 px-2 py-1 rounded text-[12px] tabular-nums"
                style={{ background: "var(--bg-inset)", border: "1px solid var(--border)", color: "var(--text)" }}
              />
            </label>
          </div>

          {/* Run summary */}
          {!inRun && runSummary && (
            <div
              className="mb-6 p-5 rounded-lg anim-in"
              style={{
                background: "var(--bg-raised)",
                border: `1px solid ${runSummary.won ? "var(--green-border)" : "var(--red-border)"}`,
                boxShadow: runSummary.won ? "0 0 30px var(--green-glow)" : "0 0 30px var(--red-glow)",
              }}
            >
              <div className="flex items-center gap-4 mb-4">
                <span
                  className="text-[20px] font-bold"
                  style={{ color: runSummary.won ? "var(--green)" : "var(--red)" }}
                >
                  {runSummary.won ? "Victory" : "Defeated"}
                </span>
                <div className="flex gap-4">
                  <StatPill label="Rooms" value={runSummary.roomsCleared} color="var(--text)" />
                  <StatPill label="HP" value={`${runSummary.finalHp}/${runSummary.maxHp}`} color={runSummary.won ? "var(--green)" : "var(--red)"} />
                </div>
              </div>

              {/* Item drops */}
              {runSummary.items.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] mb-2" style={{ color: "var(--gold)" }}>
                    Items collected
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {runSummary.items.map((item) => (
                      <span
                        key={item.id}
                        className="text-[11px] font-medium px-2.5 py-1 rounded-md"
                        style={{ background: "var(--bg-inset)", color: "var(--text-dim)", border: "1px solid var(--border)" }}
                      >
                        {item.name} <span className="font-bold" style={{ color: "var(--orange)" }}>x{fmt(item.amount)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Boons picked */}
              {runSummary.boons.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] mb-2" style={{ color: "var(--text-faint)" }}>
                    Boons chosen ({runSummary.boons.length})
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {runSummary.boons.map((b: string, i: number) => (
                      <span
                        key={i}
                        className="text-[11px] px-2.5 py-1 rounded-md"
                        style={{ background: "var(--bg-inset)", color: "var(--text-faint)", border: "1px solid var(--border)" }}
                      >
                        {b}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <button
                onClick={() => setRunSummary(null)}
                className="text-[11px] mt-4 cursor-pointer font-medium"
                style={{ background: "none", border: "none", padding: 0, color: "var(--text-faint)" }}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Chain summary */}
          {!inRun && chainSummary && (
            <div
              className="mb-6 p-5 rounded-lg anim-in"
              style={{
                background: "var(--bg-raised)",
                border: "1px solid var(--border-accent)",
                boxShadow: "0 0 30px var(--orange-glow)",
              }}
            >
              <div className="flex items-center gap-4 mb-4">
                <span className="text-[18px] font-bold" style={{ color: "var(--orange)" }}>
                  Chain Complete
                </span>
                <span className="text-[12px] font-medium" style={{ color: "var(--text-dim)" }}>
                  {fmt(chainSummary.totalRuns)} runs
                </span>
              </div>

              <div className="flex gap-6 mb-4">
                <StatPill label="Wins" value={fmt(chainSummary.wins)} color="var(--green)" />
                <StatPill label="Losses" value={fmt(chainSummary.losses)} color="var(--red)" />
                <StatPill label="Win rate" value={`${Math.round((chainSummary.wins / chainSummary.totalRuns) * 100)}%`} color="var(--text)" />
                <StatPill label="Total rooms" value={fmt(chainSummary.totalRooms)} />
              </div>

              {chainSummary.allItems.length > 0 && (
                <div className="mb-3">
                  <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] mb-2" style={{ color: "var(--gold)" }}>
                    All items collected
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {chainSummary.allItems.map((item) => {
                      const info = giga.itemInfo[String(item.id)];
                      const rarityColor = RARITY_COLORS[info?.rarity ?? 0] || "var(--text-faint)";
                      return (
                        <span
                          key={item.id}
                          className="text-[11px] font-medium px-2.5 py-1 rounded-md"
                          style={{ background: "var(--bg-inset)", color: rarityColor, border: `1px solid ${rarityColor}` }}
                        >
                          {item.name} <span className="font-bold" style={{ color: "var(--text)" }}>x{fmt(item.amount)}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              <button
                onClick={() => setChainSummary(null)}
                className="text-[11px] mt-2 cursor-pointer font-medium"
                style={{ background: "none", border: "none", padding: 0, color: "var(--text-faint)" }}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* No run - dungeon selection */}
          {!inRun && (
            <div className="py-4 anim-in" style={{ animationDelay: "80ms" }}>
              <p className="text-[12px] mb-4 font-medium" style={{ color: "var(--text-faint)" }}>
                Pick a dungeon to start, or chain for continuous runs.
              </p>
              <div className="flex gap-3 flex-wrap">
                  {giga.dungeonToday?.dungeonDataEntities?.map((d) => {
                    const currentEnergy = eng ? Math.floor(eng.energyValue) : 0;
                    const hasEntryItems = !!d.entryData && d.entryData.length > 0;
                    const needsItems = hasEntryItems && d.ENERGY_CID === 0;

                    // For item-cost dungeons, check if player has any of the required items
                    let canEnterWithItems = false;
                    let missingItemMsg = "";
                    if (needsItems && d.entryData) {
                      // Check cheapest tier (T1)
                      const t1 = d.entryData[0];
                      if (t1) {
                        const hasAny = t1.inputItems.some((itemId, i) => {
                          const have = giga.itemBalances[String(itemId)] ?? 0;
                          return have >= t1.inputAmounts[i];
                        });
                        canEnterWithItems = hasAny;
                        if (!hasAny) {
                          missingItemMsg = "Need faction items";
                        }
                      }
                    }

                    const notEnough = needsItems ? !canEnterWithItems : currentEnergy < d.ENERGY_CID;

                    return (
                      <div key={d.ID_CID} className="flex flex-col gap-1.5">
                        <button
                          onClick={async () => {
                            setRunSummary(null);
                            setChainSummary(null);
                            runBoonsRef.current = [];
                            runItemsRef.current = new Map();
                            addLog(`start ${d.NAME_CID}`);
                            const result = await giga.startRun(d.ID_CID);
                            if (result && result.success !== false) {
                              addLog("started");
                            } else {
                              addLog(`failed: ${result?.message || giga.error || "unknown error"}`);
                            }
                          }}
                          disabled={giga.loading || notEnough}
                          className="btn-press text-[14px] font-bold px-5 py-3 rounded-lg cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{
                            background: notEnough ? "var(--bg-inset)" : "linear-gradient(135deg, var(--orange-lite), var(--orange))",
                            border: notEnough ? "1px solid var(--border)" : "none",
                            color: notEnough ? "var(--text-faint)" : "var(--on-orange)",
                            boxShadow: notEnough ? "none" : "0 3px 12px var(--orange-glow)",
                          }}
                        >
                          {d.NAME_CID}
                          {!needsItems && (
                            <span className="font-normal ml-2 opacity-80">
                              {d.ENERGY_CID}E
                            </span>
                          )}
                          {needsItems && hasEntryItems && (
                            <span className="font-normal ml-2 opacity-80 text-[11px]">
                              {d.entryData!.length} tiers
                            </span>
                          )}
                          {notEnough && !needsItems && (
                            <span className="text-[11px] block mt-1 font-normal" style={{ color: "var(--red)" }}>
                              need {d.ENERGY_CID - currentEnergy} more
                            </span>
                          )}
                          {notEnough && needsItems && (
                            <span className="text-[11px] block mt-1 font-normal" style={{ color: "var(--red)" }}>
                              {missingItemMsg}
                            </span>
                          )}
                        </button>
                        <button
                          onClick={async () => {
                            setRunSummary(null);
                            setChainSummary(null);
                            runBoonsRef.current = [];
                            runItemsRef.current = new Map();
                            setChainMode({ dungeonId: d.ID_CID, dungeonName: d.NAME_CID });
                            giga.autoBattleRef.current = true; // prevent refreshAll from touching dungeon state
                            addLog(`chain: starting ${d.NAME_CID}`);
                            const result = await giga.startRun(d.ID_CID);
                            if (result && result.success !== false) {
                              addLog("started");
                              setAutoPlay(true);
                            } else {
                              addLog(`failed: ${result?.message || giga.error || "unknown error"}`);
                              setChainMode(null);
                            }
                          }}
                          disabled={giga.loading || notEnough}
                          className="btn-press text-[11px] font-bold uppercase tracking-wider px-5 py-2 rounded-md cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{
                            background: "var(--bg-inset)",
                            border: "1px solid var(--border-accent)",
                            color: "var(--orange)",
                          }}
                        >
                          Chain
                        </button>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* In run - fighters */}
          {inRun && player && enemy && (
            <div className="anim-in" style={{ animationDelay: "80ms" }}>

              {/* Fighter panels — flash green on win, shake + flash red on loss */}
              {(() => {
                const youWon = player.thisPlayerWin;
                const youLost = player.otherPlayerWin;
                const enemyNameEntry = entity
                  ? giga.enemyNames[String(entity.ENEMY_CID)]
                    || giga.enemyNames[`idx:${entity.ENEMY_CID}`]
                    || giga.enemyNames[`ENEMY#${entity.ENEMY_CID}`]
                  : undefined;
                const enemyName = enemyNameEntry?.name;
                // Use charges as a round key so animations retrigger each round
                const roundKey = player.rock.currentCharges + player.paper.currentCharges + player.scissor.currentCharges;
                return (
                  <div className="flex gap-6 mb-6">
                    <div
                      key={`you-${roundKey}`}
                      className="flex-1 p-4 rounded-lg relative overflow-hidden"
                      style={{
                        background: "var(--bg-raised)",
                        border: "1px solid var(--border)",
                        animation: youWon
                          ? "flash-green 0.8s ease-out forwards"
                          : youLost
                            ? "shake 0.4s ease-out, flash-red 0.8s ease-out forwards"
                            : "none",
                      }}
                    >
                      <FighterPanel fighter={player} name={giga.username || "You"} />
                    </div>
                    <div
                      key={`enemy-${roundKey}`}
                      className="flex-1 p-4 rounded-lg relative overflow-hidden"
                      style={{
                        background: "var(--bg-raised)",
                        border: "1px solid var(--border)",
                        animation: youLost
                          ? "flash-green 0.8s ease-out forwards"
                          : youWon
                            ? "shake 0.4s ease-out, flash-red 0.8s ease-out forwards"
                            : "none",
                      }}
                    >
                      <FighterPanel fighter={enemy} name={enemyName || "Enemy"} isEnemy />
                    </div>
                  </div>
                );
              })()}

              {/* Item drops from last action */}
              {lastDrops.length > 0 && (
                <div className="flex items-center gap-2 mb-5 anim-in">
                  <span className="text-[10px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--gold)" }}>
                    Loot
                  </span>
                  <div className="flex gap-1.5 flex-wrap">
                    {lastDrops.map((drop) => {
                      const info = giga.itemInfo[String(drop.id)];
                      const name = info?.name || giga.itemNames[String(drop.id)] || `#${drop.id}`;
                      const rarity = info?.rarity ?? 0;
                      const rarityColor = RARITY_COLORS[rarity] || "var(--text-faint)";
                      return (
                        <span
                          key={drop.id}
                          className="text-[11px] font-medium px-2 py-0.5 rounded-md flex items-center gap-1.5"
                          style={{
                            background: "var(--bg-inset)",
                            border: `1px solid ${rarityColor}`,
                            color: rarityColor,
                          }}
                        >
                          {info?.icon && (
                            <img src={info.icon} alt="" width={14} height={14} style={{ objectFit: "contain" }} />
                          )}
                          {name}
                          <span className="font-bold" style={{ color: "var(--text)" }}>x{fmt(drop.amount)}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Loot phase */}
              {isLoot && run.lootOptions?.length > 0 && (
                <div className="mb-6">
                  <span
                    className="text-[11px] font-bold uppercase tracking-[0.12em] block mb-3"
                    style={{ color: "var(--gold)" }}
                  >
                    {autoPlay ? "Auto-picking loot..." : "Pick loot"}
                  </span>
                  <div className="flex gap-3">
                    {run.lootOptions.map((loot, i) => {
                      const lootActions = ["loot_one", "loot_two", "loot_three", "loot_four"] as const;
                      const isRecommended = recommended === lootActions[i];
                      const rarityColor = RARITY_COLORS[loot.RARITY_CID] || RARITY_COLORS[0];
                      const rarityGlow = RARITY_GLOW[loot.RARITY_CID] || "none";
                      return (
                        <button
                          key={i}
                          disabled={giga.loading || autoPlay}
                          onClick={async () => {
                            runBoonsRef.current.push(
                              formatBoon(loot.boonTypeString, loot.selectedVal1, loot.selectedVal2)
                            );
                            addLog(`loot: ${BOON_NAMES[loot.boonTypeString] || loot.boonTypeString}`);
                            await giga.performAction(lootActions[i]);
                            addLog(`got ${BOON_NAMES[loot.boonTypeString] || loot.boonTypeString}`);
                          }}
                          className="btn-press flex-1 text-left p-3.5 rounded-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                          style={{
                            background: "var(--bg-raised)",
                            border: `1px solid ${isRecommended ? "var(--border-accent)" : rarityColor}`,
                            boxShadow: isRecommended
                              ? `0 0 20px var(--orange-glow), inset 0 1px 0 rgba(255,255,255,0.02)`
                              : rarityGlow !== "none" ? `0 0 15px ${rarityGlow}` : "none",
                          }}
                        >
                          <div className="text-[13px] font-bold" style={{ color: rarityColor }}>
                            {BOON_NAMES[loot.boonTypeString] || loot.boonTypeString}
                          </div>
                          <div className="text-[12px] mt-1 font-medium" style={{ color: "var(--text-dim)" }}>
                            {loot.boonTypeString.startsWith("Upgrade")
                              ? <>+{loot.selectedVal1} ATK{loot.selectedVal2 > 0 && ` / +${loot.selectedVal2} DEF`}</>
                              : <>+{loot.selectedVal1}</>
                            }
                          </div>
                          {isRecommended && (
                            <div className="mt-1.5"><RecBadge /></div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Combat buttons */}
              {!isLoot && player && (
                <div className="flex gap-3">
                  {(["rock", "paper", "scissor"] as const).map((move) => {
                    const s = player[move];
                    const off = giga.loading || autoPlay || s.currentCharges <= 0;
                    const isRec = recommended === move;
                    return (
                      <button
                        key={move}
                        disabled={off}
                        onClick={async () => {
                          addLog(MOVE_LABELS[move]);
                          const r = await giga.performAction(move);
                          if (r) {
                            trackEnemyMove(giga.dungeonState, r);
                            trackItemDrops(r);
                            const p = r.data?.run?.players?.[0], e = r.data?.run?.players?.[1];
                            if (p && e) addLog(`${p.health.current}hp vs ${e.health.current}hp`);
                            if (r.data?.run?.lootPhase) addLog("loot phase");

                            // Run ended — either "Run Complete" message, or player died, or run is null
                            const runOver = r.message === "Run Complete" || !r.data?.run || (p && p.health.current <= 0);
                            if (runOver) {
                              const fp = r.data?.run?.players?.[0];
                              const won = (fp?.health.current ?? 0) > 0;
                              const rooms = r.data?.entity?.ROOM_NUM_CID ?? 0;
                              const items = buildItemSummary();
                              const boons = [...runBoonsRef.current];
                              addLog(won ? "victory" : "defeated");
                              setRunSummary({ roomsCleared: rooms, boons, items, finalHp: fp?.health.current ?? 0, maxHp: fp?.health.currentMax ?? 0, won });
                              recordRunAction(lastDungeonNameRef.current, won, rooms, fp?.health.current ?? 0, fp?.health.currentMax ?? 0, items, boons, giga.address)
                                .then(() => refreshRunStats()).catch(() => {});
                              giga.refreshAll();
                            }
                          }
                        }}
                        className="btn-press flex-1 rounded-lg cursor-pointer disabled:cursor-not-allowed flex items-center gap-3 px-4 py-3"
                        style={{
                          background: off
                            ? "var(--bg-inset)"
                            : isRec
                              ? MOVE_BG[move]
                              : "var(--bg-raised)",
                          border: `2px solid ${off ? "var(--border)" : isRec ? MOVE_COLORS[move] : "var(--border-lite)"}`,
                          boxShadow: off
                            ? "none"
                            : isRec
                              ? `0 4px 12px ${MOVE_BG[move]}, 0 2px 0 var(--bg-inset)`
                              : "0 2px 0 var(--bg-inset)",
                          opacity: off ? 0.35 : 1,
                          transition: "background 150ms ease, border-color 150ms ease, color 150ms ease",
                          textAlign: "left",
                        }}
                      >
                        <div className="shrink-0" style={{ width: 48, height: 48 }}>
                          <MoveImage move={move} size={48} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[14px] font-bold uppercase tracking-wide" style={{ color: MOVE_COLORS[move] }}>
                              {MOVE_LABELS[move]}
                            </span>
                            {isRec && !autoPlay && <RecBadge />}
                          </div>
                          <div className="text-[12px] mt-0.5 font-medium tabular-nums" style={{ color: "var(--text-dim)" }}>
                            <span className="font-bold" style={{ color: "var(--text)" }}>{s.currentATK}</span>
                            <span style={{ color: "var(--text-faint)" }}> ATK</span>
                            <span className="mx-1.5" style={{ color: "var(--border-lite)" }}>/</span>
                            <span className="font-bold" style={{ color: "var(--text)" }}>{s.currentDEF}</span>
                            <span style={{ color: "var(--text-faint)" }}> DEF</span>
                          </div>
                          <div className="text-[10px] mt-0.5 tabular-nums" style={{ color: s.currentCharges <= 0 ? "var(--red)" : "var(--text-faint)" }}>
                            {s.currentCharges === -1
                              ? <span className="font-bold" style={{ color: "var(--red)" }}>SPAM</span>
                              : <>{s.currentCharges} charges</>
                            }
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          </>}
        </main>
      </div>

      {/* Error toast */}
      {giga.error && giga.error !== dismissedError && (
        <div
          role="alert"
          className="error-toast fixed bottom-4 right-4 flex items-center gap-3 text-[12px] font-semibold px-4 py-2.5 rounded-lg"
          style={{
            background: "var(--red-cta)",
            color: "var(--text-inverse)",
            boxShadow: "0 4px 20px var(--red-glow)",
            zIndex: 60,
            maxWidth: 360,
          }}
        >
          <span className="flex-1">{giga.error}</span>
          <button
            onClick={() => { setDismissedError(giga.error); giga.refreshAll(); }}
            className="shrink-0 text-[11px] font-bold px-2 py-1 rounded cursor-pointer"
            style={{ background: "rgba(0,0,0,0.25)", border: "none", color: "var(--text-inverse)" }}
          >
            Retry
          </button>
          <button
            onClick={() => setDismissedError(giga.error)}
            aria-label="Dismiss error"
            className="shrink-0 flex items-center justify-center cursor-pointer"
            style={{ background: "none", border: "none", color: "var(--text-inverse)", width: 20, height: 20 }}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Fishing Page ──────────────────────────────────────── */

// Every castable node across every open pond, all drawing on one daily pool.
// Only the classic pond's nodes have a live `nodeNEnergy` field in the state
// response; the rest price from the pond table.
const NODE_ENERGY_FIELD: Record<string, "node0Energy" | "node1Energy" | "node2Energy"> = {
  "0": "node0Energy",
  "1": "node1Energy",
  "2": "node2Energy",
};

const CAST_NODES = openCastNodes();

const RARITY_FISH_COLORS = [
  "var(--text-faint)",   // 0 - common
  "var(--text)",         // 1 - uncommon
  "var(--green)",        // 2 - rare
  "var(--blue)",         // 3 - epic
  "var(--gold)",         // 4 - legendary
  "var(--orange)",       // 5 - mythic
];

function FishingPage({ giga, addLog }: {
  giga: ReturnType<typeof useGigaverse>;
  addLog: (msg: string) => void;
}) {
  const [autoFish, setAutoFish] = useState(false);
  const [autoCastNode, setAutoCastNode] = useState("auto");
  // `catches` keeps the actual fish, not just a tally — an auto-fish run that
  // reports "7 caught" says nothing about whether they were worth the energy.
  const [sessionStats, setSessionStats] = useState<{
    casts: number; caught: number; escaped: number;
    /** Proceeds keyed by pond. Two ponds, two currencies, never one total. */
    earnedByPond: Record<number, number>;
    catches: { name: string; rarity: number; quality: number; size: string; earned: number; currency: string }[];
  }>({ casts: 0, caught: 0, escaped: 0, earnedByPond: {}, catches: [] });
  const [fishingLog, setFishingLog] = useState<string[]>([]);
  const [confirmSellAll, setConfirmSellAll] = useState(false);
  const autoFishRef = useRef(false);

  // Keep ref in sync
  useEffect(() => { autoFishRef.current = autoFish; }, [autoFish]);

  // Fetch fishing state on mount
  useEffect(() => {
    giga.fetchFishingState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fs = giga.fishingState;
  const gameData = fs?.gameState?.data;
  const isInGame = fs?.gameState && !fs.gameState.COMPLETE_CID;
  const castsToday = castsUsedToday(fs);
  const fishJuiced = giga.energy?.entities?.[0]?.parsedData?.isPlayerJuiced ?? false;
  const maxCasts = fishJuiced
    ? (fs?.maxPerDayJuiced ?? FISHING.juicedMaxCastsPerDay)
    : (fs?.maxPerDay ?? FISHING.maxCastsPerDay);

  const addFishLog = useCallback((msg: string) => {
    setFishingLog((prev) => [msg, ...prev].slice(0, 100));
    addLog(`[Fish] ${msg}`);
  }, [addLog]);

  const getNodeEnergy = useCallback((nodeId: string): number => {
    const live = NODE_ENERGY_FIELD[nodeId];
    if (live && fs) return fs[live];
    // Nodes outside the classic three have no nodeNEnergy field of their own,
    // so their cost comes from the pond table. Returning 0 here showed the
    // Grove as a free cast.
    return CAST_NODES.find((n) => n.nodeId === nodeId)?.cost ?? 0;
  }, [fs]);

  // Get the current energy entity to check available energy
  const energyAvailable = giga.energy?.entities?.[0]?.parsedData?.energyValue ?? 0;

  const startCast = useCallback(async (nodeId: string) => {
    const pond = findPondForNode(nodeId);
    if (!pond) {
      addFishLog(`Cast node ${nodeId} belongs to no known pond — refusing to cast`);
      return null;
    }
    // Manual casting always takes the free offering. Spending a faction ring
    // for 2x/4x Cores is a deliberate act and lives in the Run Plan, behind its
    // own toggle, rather than happening on a button press here.
    // currentDay matters: a tier's startDay/endDay bound it, and sending an
    // out-of-window tier is a rejected cast.
    const { free } = pondEntryOptions(
      fs?.pondEntryTiers, pond.pondId, giga.itemBalances, giga.currentDay
    );
    if (!free) {
      addFishLog(
        `${pond.name} has no free entry offering — every tier costs a faction ring. ` +
          `Cast it from the Run Plan with "Pay pond entry offerings" on.`
      );
      return null;
    }
    addFishLog(`Starting ${pond.name} cast (node ${nodeId})...`);
    const result = await giga.fishingAction("start_run", { cards: [], nodeId, tierId: free.tier });
    if (result) {
      setSessionStats((s) => ({ ...s, casts: s.casts + 1 }));
      addFishLog(`Cast started! Fish HP: ${result.data.doc.data.fishHp}/${result.data.doc.data.fishMaxHp}`);
    }
    return result;
  }, [giga, addFishLog, fs?.pondEntryTiers]);

  // `snapshot` is the state the decision was made from. The auto-fish loop
  // holds a fresher copy than this closure does, and the probe has to score the
  // prediction against what the AI actually saw — a stale snapshot would
  // silently grade the wrong move.
  const playCard = useCallback(async (
    handIndex: number,
    focusPoint?: number[],
    snapshot?: FishingGameData,
  ) => {
    const beforeMove = snapshot ?? gameData;
    // The Grove commits a lure move through this same call, so the caller may
    // pass a new focus point; everywhere else it stays where it is.
    const result = await giga.fishingAction("play_cards", {
      cards: [handIndex], nodeId: "",
      focusPoint: focusPoint ?? beforeMove?.focusPoint ?? [],
    });
    if (result) {
      const d = result.data.doc.data;
      probeFishMove(beforeMove, d);
      const isComplete = result.data.doc.COMPLETE_CID;
      if (isComplete) {
        if (result.data.doc.SUCCESS_CID && d.caughtFish) {
          const fish = d.caughtFish;
          // The pond comes off the game document itself — `ID_CID` is the node
          // this cast was started on. Reading it from the closure gave whatever
          // the component last rendered, and reading `focusMechanicEnabled`
          // asks about a mechanic when the question is which stall pays.
          const pondId = findPondForNode(nodeIdForGame(result.data.doc))?.pondId;
          const currency = pondCurrencyLabel(pondId);
          addFishLog(`Caught ${fish.name} (${fish.size}, Q${fish.quality})! +${fish.currencyEarned} ${currency}`);
          setSessionStats((s) => ({
            ...s,
            caught: s.caught + 1,
            earnedByPond: pondId === undefined
              ? s.earnedByPond
              : { ...s.earnedByPond, [pondId]: (s.earnedByPond[pondId] ?? 0) + (fish.currencyEarned ?? 0) },
            catches: [
              { name: fish.name, rarity: fish.rarity, quality: fish.quality, size: fish.size, earned: fish.currencyEarned, currency },
              ...s.catches,
            ].slice(0, 40),
          }));
        } else {
          addFishLog(`Fish escaped! HP was ${d.fishHp}/${d.fishMaxHp}`);
          setSessionStats((s) => ({ ...s, escaped: s.escaped + 1 }));
        }
      } else {
        addFishLog(`Fish HP: ${d.fishHp}/${d.fishMaxHp} | Mana: ${d.playerHp}/${d.playerMaxHp} | Fish at [${d.fishPosition.join(",")}]`);
      }
    }
    return result;
  }, [giga, addFishLog, gameData]);

  // Auto-fish loop
  useEffect(() => {
    if (!autoFish) return;

    let cancelled = false;

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Mana falls by one per card on every redraw, so the loop terminates on its
    // own; the cap stops a stubborn hand from spending a whole cast reshuffling
    // rather than swinging.
    const MAX_REDRAWS_PER_CAST = 3;

    const runOneCast = async (): Promise<"caught" | "escaped" | "error" | "cancelled"> => {
      let redraws = 0;
      // Start a new cast
      const resolvedNode = autoCastNode === "auto" ? recommendedCast : autoCastNode;
      // Priced from the pond table via the live node energies, not from a
      // guessed 12 — a wrong cost here waves through a cast the server refuses.
      const nodeCost = getNodeEnergy(resolvedNode);
      if (nodeCost <= 0) {
        addFishLog(`Don't know what node ${resolvedNode} costs — stopping rather than casting blind`);
        return "error";
      }

      // Check energy
      await giga.refreshAll();
      const currentEnergy = giga.energy?.entities?.[0]?.parsedData?.energyValue ?? 0;
      if (currentEnergy < nodeCost) {
        addFishLog(`Not enough energy (${Math.floor(currentEnergy)}/${nodeCost})`);
        return "error";
      }

      const castResult = await startCast(resolvedNode);
      if (!castResult || !castResult.data?.doc) {
        addFishLog("Cast failed");
        return "error";
      }

      await delay(500);

      // Play cards until game completes
      while (autoFishRef.current && !cancelled) {
        // Read current state from the hook (updated by playCard/startCast)
        const state = await giga.fetchFishingState();
        if (!state) return "error";

        const gs = state.gameState;
        const data = gs?.data;

        if (gs?.COMPLETE_CID) {
          // Game finished
          if (gs.SUCCESS_CID && data?.caughtFish) {
            return "caught";
          }
          return "escaped";
        }

        if (!data || data.hand.length === 0 || data.playerHp <= 0) {
          await delay(300);
          continue;
        }

        // The Grove is a different game: cards are lure-anchored stamps, so the
        // card and the lure position have to be chosen together.
        if (data.focusMechanicEnabled) {
          const move = pickGroveMove(data);
          if (!move) {
            addFishLog("AI: no playable card");
            await delay(300);
            continue;
          }
          if (move.redraw && redraws < MAX_REDRAWS_PER_CAST) {
            // Redraw is play_cards with no cards: the hand is discarded and
            // refilled for one mana per card held.
            redraws++;
            addFishLog(`AI: ${move.reason}`);
            await giga.fishingAction("play_cards", {
              cards: [], nodeId: "", focusPoint: data.focusPoint ?? [],
            });
            await delay(300);
            continue;
          }
          addFishLog(`AI: ${move.reason}`);
          await playCard(move.handIndex, move.focusPoint, data);
          await delay(300);
          continue;
        }

        // Pick and play best card
        const { handIndex, reason } = pickBestCard(
          data.hand, data.deckCardData, data.fishPosition,
          data.previousFishPosition, data.nextPosition,
          resolveGrid(data)
        );
        addFishLog(`AI: ${reason}`);
        await playCard(handIndex, undefined, data);
        await delay(300);
      }

      return "cancelled";
    };

    const loop = async () => {
      let castNum = 0;

      while (autoFishRef.current && !cancelled) {
        // Check daily limit
        const state = await giga.fetchFishingState();
        if (!state || cancelled) break;
        const today = castsUsedToday(state);
        const max = fishJuiced
          ? (state.maxPerDayJuiced ?? FISHING.juicedMaxCastsPerDay)
          : (state.maxPerDay ?? FISHING.maxCastsPerDay);
        if (today >= max) {
          addFishLog(`=== Daily limit reached (${today}/${max}) ===`);
          break;
        }

        castNum++;
        addFishLog(`--- Cast #${castNum} ---`);

        const result = await runOneCast();

        if (result === "cancelled" || !autoFishRef.current || cancelled) break;
        if (result === "error") {
          addFishLog("Stopping due to error.");
          break;
        }

        // Show result. The pond comes from the finished game, not from the cast
        // type the dropdown happens to be on — with "auto" selected those are
        // routinely different ponds.
        const freshState = giga.fishingState;
        const fish = freshState?.gameState?.data?.caughtFish;
        if (result === "caught" && fish) {
          const pondId = findPondForNode(nodeIdForGame(freshState?.gameState))?.pondId;
          addFishLog(`*** CAUGHT: ${fish.name} (Q${fish.quality}) +${fish.currencyEarned} ${pondCurrencyLabel(pondId)} ***`);
        } else if (result === "escaped") {
          addFishLog(`--- Fish escaped ---`);
        }

        // Brief pause between casts
        await delay(1000);
      }

      addFishLog(`=== Auto-fish done: ${sessionStats.caught} caught, ${sessionStats.escaped} escaped ===`);
      setAutoFish(false);
      await giga.refreshAll();
    };

    loop();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFish]);

  // Resolve hand cards from deckCardData
  const handCards: (FishingCard | undefined)[] = (gameData?.hand ?? []).map((id) =>
    gameData?.deckCardData.find((c) => c.id === id)
  );

  // Pond dimensions. The Dendren Grove is bigger than the original 3x3, and
  // the API never states the size, so it comes out of the deck's zone IDs.
  //
  // The reading is pinned for the duration of a cast. The zone IDs are only a
  // lower bound on the board, so a later sighting can widen it — but the board
  // itself never changes shape mid-cast, and letting the inference wobble would
  // re-target the AI and redraw the grid in the middle of a fight.
  const fishGridRef = useRef<{ castId: string; grid: GridDims } | null>(null);
  const fishGrid = useMemo(() => {
    if (!gameData) return DEFAULT_GRID;
    // When the server states the board size there is nothing to pin or guess.
    if (typeof gameData.gridSize === "number" && gameData.gridSize > 0) {
      return { cols: gameData.gridSize, rows: gameData.gridSize };
    }
    const castId = fs?.gameState?.docId ?? "";
    const inferred = inferGrid(
      gameData.deckCardData, gameData.fishPosition,
      gameData.previousFishPosition, gameData.nextPosition
    );
    const pinned = fishGridRef.current;
    if (
      pinned &&
      pinned.castId === castId &&
      pinned.grid.cols * pinned.grid.rows >= inferred.cols * inferred.rows
    ) {
      return pinned.grid;
    }
    fishGridRef.current = { castId, grid: inferred };
    return inferred;
  }, [gameData, fs?.gameState?.docId]);

  /**
   * Fish in inventory the stalls will buy, each tagged with the pond that buys
   * it. Built once and shared by the Fish Stall header and the list under it,
   * which had drifted into two copies of the same mapping — so a fix to one
   * (like carrying pondId through to the sell call) could miss the other.
   */
  const sellableFish = useMemo(
    () =>
      (fs?.exchangeRates ?? [])
        .map((r) => {
          const qty = giga.itemBalances[String(r.id)] ?? 0;
          if (qty <= 0) return null;
          return {
            id: r.id,
            name: giga.itemInfo[String(r.id)]?.name || `Fish#${r.id}`,
            qty,
            baseVal: r.baseVal,
            value: r.value,
            pct: Math.round(((r.value - r.baseVal) / r.baseVal) * 100),
            // Required, not defaulted: the sell call is rejected without it,
            // and guessing sends the fish to the wrong stall.
            pondId: r.pondId,
          };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null)
        .sort((a, b) => b.pct - a.pct),
    [fs?.exchangeRates, giga.itemBalances, giga.itemInfo]
  );

  /**
   * Per-card scores for the hand panel, in whichever model this pond uses.
   *
   * Null on the classic ponds, where the board-address scorer applies. In the
   * Grove a card's hitZones are offsets from the lure, so scoring them as board
   * cells made the "BEST" badge disagree with the card auto-fish actually
   * played — the two now run the same function.
   */
  const groveScores = useMemo(
    () => (gameData?.focusMechanicEnabled ? scoreGroveHand(gameData) : null),
    [gameData]
  );

  const noHit = !gameData
    ? false
    : groveScores
    ? groveScores.length > 0 && groveScores.every((s) => s.pHit < 0.2)
    : shouldRedraw(
        gameData.hand, gameData.deckCardData, gameData.fishPosition,
        gameData.previousFishPosition, gameData.nextPosition, fishGrid
      );

  /**
   * Biggest cast the energy supports, within one pond.
   *
   * Explicitly scoped to a pond, because "which cast size" and "which pond" are
   * different questions and only the first one has an answer here. Cast size
   * trades energy for fish quality inside a pond; choosing between ponds trades
   * one currency for another, which needs the yield history the Run Plan's
   * advisor has and this button does not. So Auto picks a size and never
   * switches pond behind your back — the Grove is chosen by clicking it.
   */
  // "auto" is the one value that legitimately names no node — it means "size
  // the cast for me", and it sizes within the first declared pond. Any OTHER
  // unrecognised value is a node from a pond this build does not know about,
  // and quietly sizing that as a classic cast is the single-pond assumption
  // coming back in through the UI, so it resolves to nothing instead.
  const autoPondId =
    autoCastNode === "auto"
      ? CAST_NODES[0]?.pondId
      : findPondForNode(autoCastNode)?.pondId;
  const recommendedCast = (() => {
    const nodes = CAST_NODES.filter((n) => n.pondId === autoPondId);
    if (!nodes.length) return CAST_NODES[0]?.nodeId ?? "0";
    const bySize = [...nodes].sort((a, b) => a.cost - b.cost);
    const smallest = bySize[0];
    if (!fs) return smallest.nodeId;
    const eng = Math.floor(energyAvailable);
    const remaining = maxCasts - castsToday;
    if (remaining <= 0) return smallest.nodeId;

    const affordable = (nodeId: string) =>
      Math.min(remaining, Math.floor(eng / (getNodeEnergy(nodeId) || 1)));

    // Biggest node that covers every remaining cast, else the biggest that
    // still covers 80% of them, else the smallest that buys anything at all.
    for (const n of [...bySize].reverse()) {
      if (affordable(n.nodeId) >= remaining) return n.nodeId;
    }
    for (const n of [...bySize].reverse()) {
      if (affordable(n.nodeId) >= remaining * 0.8) return n.nodeId;
    }
    return smallest.nodeId;
  })();

  return (
    <div className="anim-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <SectionLabel>Fishing</SectionLabel>
          {isInGame && gameData && (
            <span className="text-[13px] tabular-nums" style={{ color: "var(--text-dim)" }}>
              Fish HP: <span className="font-bold" style={{ color: "var(--text)" }}>{gameData.fishHp}</span>
              <span style={{ color: "var(--text-faint)" }}>/{gameData.fishMaxHp}</span>
              {" | "}Mana: <span className="font-bold" style={{ color: "var(--blue)" }}>{gameData.playerHp}</span>
              <span style={{ color: "var(--text-faint)" }}>/{gameData.playerMaxHp}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => giga.fetchFishingState()}
            className="btn-press text-[11px] font-semibold px-3 py-1.5 rounded-md cursor-pointer"
            style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="fishing-grid grid gap-5">

        {/* ── Left Column: Cast Controls + Grid ── */}
        <div className="flex flex-col gap-4">

          {/* Auto-Fish Controls */}
          <div className="card p-4">
            <h3 className="text-[11px] font-bold uppercase tracking-wider mb-3" style={{ color: "var(--text-faint)" }}>
              Auto-Fish
            </h3>
            <div className="flex items-center gap-3 mb-3">
              <button
                onClick={() => setAutoFish(!autoFish)}
                className="btn-press flex-1 rounded-md py-2.5 px-4 cursor-pointer font-semibold text-[13px]"
                style={{
                  background: autoFish ? "var(--red-glow)" : "var(--green-glow)",
                  border: `1px solid ${autoFish ? "var(--red)" : "var(--green-dim)"}`,
                  color: autoFish ? "var(--red)" : "var(--green)",
                }}
              >
                {autoFish ? "Stop" : "Start Auto-Fish"}
              </button>
            </div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>Cast type:</span>
              {[{ nodeId: "auto", label: "Auto" }, ...CAST_NODES].map((node) => (
                <button
                  key={node.nodeId}
                  onClick={() => setAutoCastNode(node.nodeId)}
                  disabled={autoFish}
                  className="btn-press text-[11px] font-medium px-2.5 py-1 rounded cursor-pointer"
                  style={{
                    background: autoCastNode === node.nodeId ? "var(--orange-glow)" : "var(--bg-inset)",
                    border: `1px solid ${autoCastNode === node.nodeId ? "var(--orange)" : "var(--border)"}`,
                    color: autoCastNode === node.nodeId ? "var(--orange)" : "var(--text-faint)",
                    opacity: autoFish ? 0.5 : 1,
                  }}
                  title={node.nodeId === "auto" ? "Automatically picks the best cast type based on your energy and remaining daily casts" : undefined}
                >
                  {node.label}
                  {node.nodeId === "auto" && <span className="ml-1 text-[10px]" style={{ color: "var(--green)" }}>({CAST_NODES.find(n => n.nodeId === recommendedCast)?.label})</span>}
                </button>
              ))}
            </div>

            {/* Session Stats. One tile per currency actually earned — a session
                that fished both ponds has two, and adding them would be adding
                Seaweed to Infused Sediment. */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
              {[
                { label: "Casts", value: fmt(sessionStats.casts), color: "var(--text)" },
                { label: "Caught", value: fmt(sessionStats.caught), color: "var(--green)" },
                { label: "Escaped", value: fmt(sessionStats.escaped), color: "var(--red)" },
                ...Object.entries(sessionStats.earnedByPond).map(([pondId, amount]) => ({
                  label: pondCurrencyLabel(Number(pondId)),
                  value: fmt(amount),
                  color: "var(--green)",
                })),
              ].map((stat) => (
                <div key={stat.label} className="text-center">
                  <div className="text-[11px] font-bold uppercase" style={{ color: "var(--text-faint)" }}>{stat.label}</div>
                  <div className="text-[18px] font-bold tabular-nums" style={{ color: stat.color }}>{stat.value}</div>
                </div>
              ))}
            </div>

            {/* What actually came out of the water this session */}
            {sessionStats.catches.length > 0 && (
              <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                <div className="text-[11px] font-bold uppercase mb-2" style={{ color: "var(--text-faint)" }}>
                  Caught this session
                </div>
                <div className="flex flex-col gap-1" style={{ maxHeight: 180, overflowY: "auto" }}>
                  {sessionStats.catches.map((c, i) => (
                    <div key={i} className="flex items-center justify-between text-[12px]">
                      <span className="truncate" style={{ color: RARITY_FISH_COLORS[c.rarity] ?? "var(--text)" }}>
                        {c.name}
                      </span>
                      <span className="tabular-nums shrink-0 ml-2" style={{ color: "var(--text-faint)" }}>
                        Q{c.quality} &middot; {c.size} &middot; <span style={{ color: "var(--green)" }}>+{fmt(c.earned)} {c.currency}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Cast Buttons — manual play, deliberately below Auto-Fish */}
          <div className="card p-4">
            <h3 className="text-[11px] font-bold uppercase tracking-wider mb-1" style={{ color: "var(--text-faint)" }}>
              Manual Cast
            </h3>
            <p className="text-[11px] mb-3" style={{ color: "var(--text-faint)" }}>
              Starts a cast you play card by card. For hands-off fishing use Auto-Fish above.
            </p>
            <div className="flex gap-2.5">
              {CAST_NODES.map((node) => {
                const nodeEnergy = getNodeEnergy(node.nodeId);
                const disabled = isInGame || autoFish || energyAvailable < nodeEnergy;
                const isRec = node.nodeId === recommendedCast;
                return (
                  <button
                    key={node.nodeId}
                    onClick={() => startCast(node.nodeId)}
                    disabled={!!disabled}
                    className="btn-press flex-1 rounded-md py-2.5 px-3 cursor-pointer relative"
                    style={{
                      background: disabled ? "var(--bg-inset)" : isRec ? "var(--orange-glow)" : "var(--bg-raised)",
                      border: `1px solid ${disabled ? "var(--border)" : isRec ? "var(--border-accent)" : "var(--border)"}`,
                      color: disabled ? "var(--text-faint)" : "var(--text)",
                      opacity: disabled ? 0.5 : 1,
                    }}
                    title={isRec ? "Recommended — best energy/cast balance for remaining daily casts" : undefined}
                  >
                    <div className="text-[13px] font-semibold">{node.label}</div>
                    <div className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                      {nodeEnergy}E
                      {!disabled && <span className="ml-1">({Math.floor(energyAvailable / nodeEnergy)} casts)</span>}
                    </div>
                    {isRec && !disabled && (
                      <div className="mt-1 flex justify-center"><RecBadge /></div>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between mt-3">
              <span className="text-[12px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                Casts today: <span style={{ color: "var(--text-dim)" }}>{castsToday}/{maxCasts}</span>
              </span>
              <span className="text-[12px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                Energy: <span style={{ color: "var(--orange)" }}>{Math.floor(energyAvailable)}</span>
              </span>
            </div>
          </div>

          {/* Pond grid — 3x3 on the original ponds, larger in the Dendren Grove */}
          <div className="card p-4">
            <h3 className="text-[11px] font-bold uppercase tracking-wider mb-3" style={{ color: "var(--text-faint)" }}>
              Fishing Grid
              {(fishGrid.cols !== 3 || fishGrid.rows !== 3) && (
                <span className="ml-2 font-normal normal-case tracking-normal" style={{ color: "var(--orange)" }}>
                  {fishGrid.cols}&times;{fishGrid.rows}
                </span>
              )}
            </h3>
            {(() => {
              // Convert API [row,col] coordinates to cell IDs
              const fishCell = gameData ? coordToCell(gameData.fishPosition, fishGrid) : 0;
              const prevCell = gameData ? coordToCell(gameData.previousFishPosition, fishGrid) : 0;
              const hasFintuition = gameData?.nextPosition && gameData.nextPosition.length === 2;
              const nextCell = hasFintuition ? coordToCell(gameData!.nextPosition!, fishGrid) : 0;

              // On a lure-anchored pond the fish walks one orthogonal step and
              // never reverses, and cards are 3x3 stamps around the lure rather
              // than board addresses. Drawing that board with the classic
              // model highlighted cells no card could reach and predicted moves
              // the fish cannot make.
              const lure =
                gameData?.focusMechanicEnabled && gameData.focusPoint?.length === 2
                  ? gameData.focusPoint
                  : null;
              const lureCell = lure ? coordToCell(lure, fishGrid) : 0;

              // Predicted cells — where the fish is GOING (likely cells only)
              const predicted = !gameData
                ? []
                : lure
                ? predictGroveCoords(
                    gameData.fishPosition, gameData.previousFishPosition,
                    fishGrid.cols, gameData.nextPosition
                  )
                    .filter((e) => e.p >= 0.12)
                    .map((e) => coordToCell(e.coord, fishGrid))
                : hasFintuition
                ? [nextCell]
                : predictNextPositionsWeighted(fishCell, prevCell, fishGrid)
                    .filter((e) => e.p >= 0.12)
                    .map((e) => e.cell);

              /**
               * The card zone that covers a board cell right now.
               *
               * Identity on the classic ponds, where a zone IS a board cell. In
               * the Grove it is the offset from the lure, and cells more than
               * one step away are covered by nothing at all.
               */
              const zoneForCell = (cell: number): number | null =>
                lure ? focusZone(cellToCoord(cell, fishGrid), lure) : cell;

              const cells = Array.from({ length: fishGrid.cols * fishGrid.rows }, (_, i) => i + 1);

              return (
                <>
                  <div
                    className="grid gap-1.5 mx-auto"
                    style={{
                      gridTemplateColumns: `repeat(${fishGrid.cols}, 1fr)`,
                      maxWidth: Math.max(200, fishGrid.cols * 66),
                    }}
                  >
                    {cells.map((pos) => {
                      const hasFish = pos === fishCell;
                      const isPredicted = predicted.includes(pos);
                      const isLure = lureCell > 0 && pos === lureCell;
                      // Which hand cards cover this PREDICTED cell, through
                      // whatever zone scheme the pond uses.
                      const zone = isPredicted ? zoneForCell(pos) : null;
                      const coveredBy =
                        zone === null
                          ? []
                          : handCards.map((c, i) => (c?.hitZones.includes(zone) ? i : -1)).filter((i) => i >= 0);
                      const isCritZone =
                        zone !== null &&
                        handCards.some((c) => c?.critZones.includes(zone) && c?.hitZones.includes(zone));

                      return (
                        <div
                          key={pos}
                          className="relative flex items-center justify-center rounded"
                          style={{
                            aspectRatio: "1",
                            background: hasFish
                              ? "var(--orange-glow)"
                              : isPredicted
                              ? hasFintuition ? "rgba(100, 200, 255, 0.08)" : "rgba(232, 134, 58, 0.04)"
                              : "var(--bg-inset)",
                            border: hasFish
                              ? "2px solid var(--orange)"
                              : isLure
                              ? "2px dashed var(--blue)"
                              : isPredicted && hasFintuition
                              ? `2px solid ${isCritZone ? "var(--gold)" : "var(--blue)"}`
                              : coveredBy.length > 0
                              ? `1px solid ${isCritZone ? "var(--gold)" : "var(--border-lite)"}`
                              : "1px solid var(--border)",
                            transition: "background 150ms ease, border-color 150ms ease, color 150ms ease",
                          }}
                        >
                          {hasFish && (
                            <Fish size={20} style={{ color: "var(--orange)" }} />
                          )}
                          {isLure && !hasFish && (
                            <span className="text-[10px] font-bold" style={{ color: "var(--blue)" }}>
                              LURE
                            </span>
                          )}
                          <span
                            className="absolute text-[10px] font-medium"
                            style={{ top: 2, left: 4, color: "var(--text-faint)" }}
                          >
                            {pos}
                          </span>
                          {coveredBy.length > 0 && !hasFish && (
                            <span className="text-[10px] font-bold" style={{ color: isCritZone ? "var(--gold)" : "var(--text-faint)" }}>
                              {isCritZone ? "!" : "+"}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {gameData && (
                    <div className="mt-3 space-y-1.5">
                      <div className="text-[11px] text-center" style={{ color: "var(--text-faint)" }}>
                        Fish at cell {fishCell}
                        {prevCell > 0 && prevCell !== fishCell && (
                          <span> (was {prevCell})</span>
                        )}
                        {hasFintuition && (
                          <span style={{ color: "var(--blue)" }}> → {nextCell}</span>
                        )}
                      </div>
                      <div className="flex items-center justify-center gap-3 text-[10px]" style={{ color: "var(--text-faint)" }}>
                        <span><span style={{ color: "var(--orange)" }}>~</span> fish now</span>
                        <span><span style={{ color: "var(--text-dim)" }}>+</span> predicted</span>
                        <span><span style={{ color: "var(--gold)" }}>!</span> crit zone</span>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* HP Bars */}
          {isInGame && gameData && (
            <div className="card p-4 flex flex-col gap-3">
              {/* Fish HP */}
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-[11px] font-semibold" style={{ color: "var(--text-faint)" }}>Fish HP</span>
                  <span className="text-[12px] font-bold tabular-nums">{gameData.fishHp}/{gameData.fishMaxHp}</span>
                </div>
                <div className="rounded-full overflow-hidden" style={{ height: 8, background: "var(--bg-inset)" }}>
                  <div
                    className="h-full w-full rounded-full"
                    style={{
                      transform: `scaleX(${Math.max(0, gameData.fishHp / gameData.fishMaxHp)})`,
                      transformOrigin: "left",
                      background: "linear-gradient(90deg, var(--orange-dim), var(--orange))",
                      transition: "transform 300ms ease",
                    }}
                  />
                </div>
              </div>
              {/* Mana */}
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-[11px] font-semibold" style={{ color: "var(--text-faint)" }}>Mana</span>
                  <span className="text-[12px] font-bold tabular-nums" style={{ color: "var(--blue)" }}>
                    {gameData.playerHp}/{gameData.playerMaxHp}
                  </span>
                </div>
                <div className="rounded-full overflow-hidden" style={{ height: 8, background: "var(--bg-inset)" }}>
                  <div
                    className="h-full w-full rounded-full"
                    style={{
                      transform: `scaleX(${Math.max(0, gameData.playerHp / gameData.playerMaxHp)})`,
                      transformOrigin: "left",
                      background: "linear-gradient(90deg, var(--blue-dim), var(--blue))",
                      transition: "transform 300ms ease",
                    }}
                  />
                </div>
              </div>
              {/* Cards remaining */}
              <div className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                Draw pile: {gameData.cardInDrawPile} | Discard: {gameData.discard.length}
              </div>
            </div>
          )}
        </div>

        {/* ── Right Column: Hand + Auto-Fish + Log ── */}
        <div className="flex flex-col gap-4">

          {/* Hand Cards */}
          {isInGame && gameData && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                  Hand
                </span>
                {noHit && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded" style={{ color: "var(--red)", background: "var(--red-glow)" }}>
                    No hits available
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-2">
                {(() => {
                  // Same scoring the auto-player uses — "BEST" here is what
                  // auto-fish would play, in whichever model this pond plays by.
                  const sumOf = (fx?: { amount: number }[]) =>
                    (fx ?? []).reduce((t, e) => t + Math.abs(e.amount), 0);
                  const scored = groveScores
                    ? groveScores.map((s) => ({
                        handIdx: s.handIndex, cardId: s.cardId, card: s.card,
                        // An unplayable card sorts last but still renders, so
                        // "not enough mana" is visible rather than the card
                        // simply looking bad.
                        ev: s.playable ? s.ev : -Infinity,
                        pHit: s.pHit, pCrit: s.pCrit, reason: s.reason,
                        hitDmg: sumOf(s.card?.hitEffects),
                        missPenalty: sumOf(s.card?.missEffects),
                        critDmg: sumOf(s.card?.critEffects),
                      }))
                    : scoreHand(
                        gameData.hand, gameData.deckCardData, gameData.fishPosition,
                        gameData.previousFishPosition, gameData.nextPosition, fishGrid
                      );
                  const bestIdx = scored.reduce((best, s, i) => (s.ev > scored[best].ev ? i : best), 0);

                  return scored.map((s) => {
                    if (!s.card) return null;
                    const card = s.card;
                    const isBest = s.handIdx === scored[bestIdx].handIdx;
                    const likelyHit = s.pHit >= 0.5;
                    const likelyCrit = s.pCrit >= 0.3;
                    const hitPct = Math.round(s.pHit * 100);

                    return (
                      <button
                        key={s.handIdx}
                        onClick={() => playCard(s.handIdx)}
                        disabled={autoFish}
                        className="btn-press rounded-md p-3 cursor-pointer text-left relative"
                        style={{
                          background: likelyCrit
                            ? "var(--gold-glow)"
                            : likelyHit
                            ? "var(--green-glow)"
                            : "var(--bg-inset)",
                          border: isBest
                            ? `2px solid ${likelyCrit ? "var(--gold)" : likelyHit ? "var(--green)" : "var(--text-dim)"}`
                            : `1px solid ${likelyCrit ? "var(--gold)" : likelyHit ? "var(--green-dim)" : "var(--border)"}`,
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-bold" style={{
                              color: likelyCrit ? "var(--gold)" : likelyHit ? "var(--green)" : "var(--text-dim)",
                            }}>
                              Card #{card.id}
                            </span>
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded tabular-nums" style={{
                              background: "var(--bg-raised)",
                              color: likelyCrit ? "var(--gold)" : likelyHit ? "var(--green)" : hitPct > 0 ? "var(--text-dim)" : "var(--red)",
                            }}>
                              {hitPct}% hit{likelyCrit ? " CRIT" : ""}
                            </span>
                            {isBest && <RecBadge />}
                          </div>
                          <span className="text-[11px] tabular-nums" style={{ color: "var(--blue)" }}>
                            {card.manaCost} mana
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1.5">
                          <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                            Hit: <span style={{ color: "var(--green)" }}>-{s.hitDmg}</span>
                          </span>
                          <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                            Miss: <span style={{ color: "var(--red)" }}>+{s.missPenalty}</span>
                          </span>
                          {s.critDmg > 0 && (
                            <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                              Crit: <span style={{ color: "var(--gold)" }}>-{s.critDmg}</span>
                            </span>
                          )}
                          <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                            EV: <span style={{ color: s.ev > 0 ? "var(--green)" : "var(--red)" }}>{s.ev.toFixed(1)}</span>
                          </span>
                        </div>
                        <div className="text-[10px] mt-1" style={{ color: "var(--text-faint)" }}>
                          Targets: [{card.hitZones.join(",")}]
                          {card.critZones.length > 0 && <span> | Crit: [{card.critZones.join(",")}]</span>}
                        </div>
                      </button>
                    );
                  });
                })()}
              </div>
            </div>
          )}

          {/* Caught Fish Display */}
          {fs?.gameState?.COMPLETE_CID && gameData?.caughtFish && (
            <div className="card p-4" style={{
              borderColor: RARITY_FISH_COLORS[gameData.caughtFish.rarity] ?? "var(--border)",
            }}>
              <h3 className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-faint)" }}>
                Last Catch
              </h3>
              <div className="flex items-center gap-3">
                <Fish size={24} style={{ color: RARITY_FISH_COLORS[gameData.caughtFish.rarity] ?? "var(--text)" }} />
                <div>
                  <div className="text-[14px] font-bold" style={{
                    color: RARITY_FISH_COLORS[gameData.caughtFish.rarity] ?? "var(--text)",
                  }}>
                    {gameData.caughtFish.name}
                  </div>
                  <div className="text-[12px]" style={{ color: "var(--text-dim)" }}>
                    {gameData.caughtFish.size} | Q{gameData.caughtFish.quality}
                    {" | "}{gameData.caughtFish.sizes.weight}lb
                    {" | +"}
                    <span style={{ color: "var(--green)" }}>{gameData.caughtFish.currencyEarned}</span>{" "}
                    {pondCurrencyLabel(findPondForNode(nodeIdForGame(fs?.gameState))?.pondId)}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Fish Inventory + Sell */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                Fish Stall
              </h3>
              {(() => {
                const plus50 = sellableFish.filter((f) => f.pct >= 50);
                // Proceeds per stall. One total would be adding Seaweed to
                // Infused Sediment, which is not a quantity of anything.
                const proceeds = new Map<number, number>();
                for (const f of plus50) {
                  proceeds.set(f.pondId, (proceeds.get(f.pondId) ?? 0) + f.value * f.qty);
                }
                const proceedsText = Array.from(proceeds, ([pondId, amount]) =>
                  `${amount} ${pondCurrencyLabel(pondId)}`
                ).join(" + ");

                const totalFish = plus50.reduce((s, f) => s + f.qty, 0);
                return plus50.length > 0 ? (
                  <button
                    onClick={async () => {
                      if (!confirmSellAll) {
                        setConfirmSellAll(true);
                        return;
                      }
                      setConfirmSellAll(false);
                      addFishLog(`Selling ${totalFish} fish at +50%...`);
                      let totalSold = 0;
                      const earnedByPond = new Map<number, number>();
                      for (const f of plus50) {
                        for (let i = 0; i < f.qty; i++) {
                          const r = await giga.sellFish(f.id, 1, f.value, f.pondId);
                          if (r?.success) {
                            totalSold++;
                            const got = r.data?.value ?? f.value;
                            earnedByPond.set(f.pondId, (earnedByPond.get(f.pondId) ?? 0) + got);
                          } else {
                            addFishLog(`Failed to sell ${f.name}: ${r?.message || "error"}`);
                            break;
                          }
                          await new Promise((r) => setTimeout(r, 150));
                        }
                      }
                      const earnedText = Array.from(earnedByPond, ([pondId, amount]) =>
                        `${amount} ${pondCurrencyLabel(pondId)}`
                      ).join(" + ") || "nothing";
                      addFishLog(`*** Sold ${totalSold} fish for ${earnedText} ***`);
                      await giga.refreshAll();
                    }}
                    onBlur={() => setConfirmSellAll(false)}
                    className="btn-press text-[11px] font-bold px-3 py-1.5 rounded cursor-pointer"
                    style={{
                      background: confirmSellAll ? "var(--red-cta)" : "var(--green)",
                      border: "none",
                      color: confirmSellAll ? "var(--text-inverse)" : "var(--bg)",
                    }}
                  >
                    {confirmSellAll
                      ? `Sell ${totalFish} fish — sure?`
                      : `Sell All +50% (${proceedsText})`}
                  </button>
                ) : null;
              })()}
            </div>
            {(() => {
              if (sellableFish.length === 0) return <div className="text-[12px]" style={{ color: "var(--text-faint)" }}>No fish in inventory</div>;

              return (
                <div className="space-y-1.5">
                  {sellableFish.map((f) => (
                    <div key={f.id} className="flex items-center justify-between py-1.5 px-2.5 rounded" style={{ background: "var(--bg-inset)" }}>
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium">{f.name}</span>
                        <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>x{f.qty}</span>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <span className="text-[12px] tabular-nums font-bold" style={{
                          color: f.pct >= 50 ? "var(--green)" : f.pct > 0 ? "var(--text)" : f.pct === 0 ? "var(--text-faint)" : "var(--red)"
                        }}>
                          {f.value} {pondCurrencyLabel(f.pondId)} {f.pct > 0 ? `+${f.pct}%` : f.pct === 0 ? "" : `${f.pct}%`}
                        </span>
                        <button
                          onClick={async () => {
                            let sold = 0;
                            let earned = 0;
                            for (let i = 0; i < f.qty; i++) {
                              const r = await giga.sellFish(f.id, 1, f.value, f.pondId);
                              if (r?.success) {
                                sold++;
                                earned += r.data?.value ?? f.value;
                              } else break;
                              await new Promise((r) => setTimeout(r, 150));
                            }
                            addFishLog(`Sold ${sold}x ${f.name} for ${earned} ${pondCurrencyLabel(f.pondId)}`);
                            await giga.refreshAll();
                          }}
                          className="btn-press text-[10px] font-bold px-2 py-1 rounded cursor-pointer"
                          style={{
                            background: f.pct >= 50 ? "var(--green)" : "var(--bg-raised)",
                            border: f.pct >= 50 ? "none" : "1px solid var(--border)",
                            color: f.pct >= 50 ? "var(--bg)" : "var(--text-dim)",
                          }}
                        >
                          Sell
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Fishing Log */}
          <div className="card p-4" style={{ maxHeight: 260, display: "flex", flexDirection: "column" }}>
            <h3 className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-faint)" }}>
              Log
            </h3>
            <div className="flex-1 overflow-y-auto log-area" role="log" style={{ minHeight: 0 }}>
              <LogFeed
                entries={fishingLog.map((msg, i) => ({ id: fishingLog.length - i, text: msg }))}
                emptyText="No activity yet"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Shared pieces ──────────────────────────────────────── */

/** The one way "recommended" is spelled across the app */
function RecBadge() {
  return (
    <span
      className="text-[9px] font-bold uppercase tracking-wider py-0.5 px-1.5 rounded shrink-0"
      style={{ color: "var(--orange)", background: "var(--orange-glow)", border: "1px solid var(--border-accent)" }}
    >
      Best
    </span>
  );
}

/** Shared plain-text log list — newest first, optional fade tail */
function LogFeed({ entries, emptyText, fade }: {
  entries: { id: string | number; text: string }[];
  emptyText: string;
  fade?: boolean;
}) {
  if (entries.length === 0) {
    return <p className="text-[12px] italic" style={{ color: "var(--text-faint)" }}>{emptyText}</p>;
  }
  return (
    <>
      {entries.map((entry, i) => (
        <div
          key={entry.id}
          className="text-[12px] leading-relaxed py-0.5"
          style={{
            fontFamily: "monospace",
            color: i === 0 ? "var(--text-dim)" : "var(--text-faint)",
            opacity: fade ? Math.max(0.55, 1 - i * 0.04) : 1,
          }}
        >
          {entry.text}
        </div>
      ))}
    </>
  );
}

/* ─── World Page (Pots & Chests) ──────────────────────────── */

function WorldPage({ giga, addLog, eng }: {
  giga: ReturnType<typeof useGigaverse>;
  addLog: (msg: string) => void;
  eng: { isPlayerJuiced: boolean; energyValue: number } | undefined;
}) {
  const [results, setResults] = useState<{ id: string; label: string; status: "idle" | "success" | "error"; detail: string }[]>([]);

  const isJuiced = eng?.isPlayerJuiced ?? false;

  // Find hands gear for pots
  const findHandsGear = (handsType: string): string => {
    if (!giga.gearInstances?.entities) return "";
    // Paper Hands = item 234, Rock Hands = item 235 (approximate — match by name)
    for (const g of giga.gearInstances.entities) {
      const name = giga.itemInfo[String(g.GAME_ITEM_ID_CID)]?.name || "";
      if (handsType === "Paper Hands" && name.toLowerCase().includes("paper")) return g.docId;
      if (handsType === "Rock Hands" && name.toLowerCase().includes("rock")) return g.docId;
    }
    return "";
  };

  const getCooldownInfo = (recipeId: string): { text: string; onCooldown: boolean; remainingSec: number } => {
    const recipe = giga.worldRecipes.find((r) => r.docId === recipeId);
    const progress = giga.playerRecipes?.entities?.find((p) => p.ID_CID === recipeId);
    if (!recipe?.COOLDOWN_CID) return { text: "", onCooldown: false, remainingSec: 0 };
    if (!progress) return { text: "Ready", onCooldown: false, remainingSec: 0 };
    // Cooldown = END_TIMESTAMP_CID + COOLDOWN_CID (seconds) - now
    const expiresAt = progress.END_TIMESTAMP_CID + recipe.COOLDOWN_CID;
    const remaining = expiresAt - Math.floor(Date.now() / 1000);
    if (remaining <= 0) return { text: "Ready", onCooldown: false, remainingSec: 0 };
    const hours = Math.floor(remaining / 3600);
    const days = Math.floor(hours / 24);
    return { text: days > 0 ? `${days}d ${hours % 24}h` : `${hours}h`, onCooldown: true, remainingSec: remaining };
  };

  // Colour is the only per-claim detail that is presentation rather than game
  // fact, so it stays here; anything missing falls back rather than vanishing.
  const claimColors: Record<string, string> = {
    chest: "var(--gold)",
    juiceChest: "var(--orange)",
    juiceChestForest: "var(--orange)",
    bluePot: "var(--blue)",
    tanPot: "var(--red)",
  };
  const items = CLAIM_RECIPES.map((r) => ({
    id: r.id,
    label: r.label,
    color: claimColors[r.key] ?? "var(--text)",
    energy: r.energy,
    needsJuice: r.needsJuice,
    handsType: r.handsType as string | null,
    desc: r.desc,
  }));

  const handleUse = async (item: typeof items[0]) => {
    const gearId = item.handsType ? findHandsGear(item.handsType) : "";
    if (item.handsType && !gearId) {
      setResults((prev) => [...prev, { id: item.id, label: item.label, status: "error", detail: `No ${item.handsType} gear found` }]);
      addLog(`${item.label}: No ${item.handsType} gear found`);
      return;
    }

    addLog(`Using ${item.label}...`);
    try {
      const r = await giga.useRecipe(item.id, gearId);
      if (r?.success !== false) {
        const lootParts: string[] = [];
        if (r?.gameItemBalanceChanges) {
          for (const c of r.gameItemBalanceChanges) {
            const name = giga.itemInfo[String(c.id)]?.name || giga.itemNames[String(c.id)] || `#${c.id}`;
            lootParts.push(`${c.amount}x ${name}`);
          }
        }
        const detail = lootParts.length > 0 ? lootParts.join(", ") : "Success";
        setResults((prev) => [...prev, { id: item.id, label: item.label, status: "success", detail }]);
        addLog(`${item.label}: ${detail}`);
      } else {
        const msg = (r as { message?: string })?.message || "failed";
        setResults((prev) => [...prev, { id: item.id, label: item.label, status: "error", detail: msg }]);
        addLog(`${item.label}: ${msg}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      setResults((prev) => [...prev, { id: item.id, label: item.label, status: "error", detail: msg }]);
      addLog(`${item.label}: ${msg}`);
    }
    giga.refreshAll();
  };

  return (
    <div className="anim-in space-y-6">
      <h2 className="text-[18px] font-bold">Pots & Chests</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {items.map((item) => {
          const cd = getCooldownInfo(item.id);
          const juiceLocked = item.needsJuice && !isJuiced;
          const gearId = item.handsType ? findHandsGear(item.handsType) : "n/a";
          const noGear = item.handsType && !gearId;
          const disabled = giga.loading || cd.onCooldown || juiceLocked || !!noGear;

          return (
            <div key={item.id} className="p-5 rounded-lg" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[15px] font-bold" style={{ color: item.color }}>{item.label}</span>
                {item.energy > 0 && (
                  <span className="text-[12px] tabular-nums" style={{ color: "var(--text-faint)" }}>{item.energy}E</span>
                )}
              </div>
              <p className="text-[12px] mb-3" style={{ color: "var(--text-faint)" }}>{item.desc}</p>

              {/* Status */}
              <div className="text-[13px] mb-3 font-medium" style={{
                color: cd.onCooldown ? "var(--text-faint)" : juiceLocked ? "var(--red)" : noGear ? "var(--red)" : "var(--green)"
              }}>
                {cd.onCooldown ? `Cooldown: ${cd.text}` :
                 juiceLocked ? "Requires GigaJuice" :
                 noGear ? `Need ${item.handsType}` :
                 "Ready"}
                {item.handsType && gearId && !cd.onCooldown && (
                  <span style={{ color: "var(--text-faint)" }}> · {item.handsType} equipped</span>
                )}
              </div>

              <button
                onClick={() => handleUse(item)}
                disabled={disabled}
                className="btn-press w-full text-[14px] font-bold py-2.5 rounded-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  // Darkened toward black so white text clears 4.5:1 at both
                  // gradient stops — the raw accents measure 1.9–2.8:1.
                  background: disabled
                    ? "var(--bg-inset)"
                    : `linear-gradient(135deg, color-mix(in srgb, ${item.color} 35%, #000), var(--bg-raised))`,
                  border: disabled ? "1px solid var(--border)" : "none",
                  color: disabled ? "var(--text-faint)" : "var(--text-inverse)",
                  boxShadow: disabled ? "none" : `0 3px 12px color-mix(in srgb, ${item.color} 30%, transparent)`,
                }}
              >
                {cd.onCooldown ? cd.text : item.handsType ? `Break ${item.label}` : `Open ${item.label}`}
              </button>
            </div>
          );
        })}
      </div>

      {/* Results log */}
      {results.length > 0 && (
        <div>
          <h3 className="text-[13px] font-bold uppercase tracking-wider mb-3" style={{ color: "var(--text-faint)" }}>Results</h3>
          <div className="space-y-1.5">
            {results.map((r, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2 rounded" style={{ background: "var(--bg-inset)" }}>
                <span style={{ color: r.status === "success" ? "var(--green)" : "var(--red)" }}>
                  {r.status === "success" ? "✓" : "✗"}
                </span>
                <span className="text-[13px] font-medium">{r.label}</span>
                <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>{r.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="pb-1.5">
      <span
        className="text-[11px] font-bold uppercase tracking-[0.15em]"
        style={{ color: "var(--text-faint)" }}
      >
        {children}
      </span>
    </div>
  );
}

