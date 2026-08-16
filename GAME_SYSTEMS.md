# Gigaverse Game Systems - Comprehensive Automation Reference

> Researched from https://docs.gigaverse.io (updated August 2026; originally March 2026)
> **IMPORTANT**: Bots and automation are **explicitly allowed** per Fair Play Rules.
> Multi-accounting is also permitted.

---

## Table of Contents

1. [Combat / Dungeons](#1-combat--dungeons)
2. [Fishing](#2-fishing)
3. [Crafting & Stations](#3-crafting--stations)
4. [Conquest (PvP)](#4-conquest-pvp)
5. [Trading / Gigamarket](#5-trading--gigamarket)
6. [Traveling Merchants](#6-traveling-merchants)
7. [ROMs & Energy](#7-roms--energy)
8. [GigaJuice (Subscription)](#8-gigajuice-subscription)
9. [Factions](#9-factions)
10. [World Environment (Pots & Chests)](#10-world-environment-pots--chests)
11. [Hatchery / Giglings](#11-hatchery--giglings)
12. [Skill Systems](#12-skill-systems)
13. [Gear & Equipment](#13-gear--equipment)
14. [Abstract Ecosystem (XP & Stubs)](#14-abstract-ecosystem-xp--stubs)
15. [The Awakening (Seasonal Event)](#15-the-awakening-seasonal-event-aug-10---oct-10-2026)
16. [Automation Priority Matrix](#16-automation-priority-matrix)

---

## 1. Combat / Dungeons

### Overview
Roguelite dungeons with 4 rooms per floor, 4 floors total. Enemies increase in difficulty. Items drop on enemy defeat and are kept even on death. Death resets dungeon progress.

### Dungeon Types

#### Dungetron 5000: Normal
- **Energy cost**: 40 per run
- **Daily limit**: 10 runs (12 if juiced)
- **Combat**: Rock-paper-scissors with Sword/Shield/Spell
  - Sword counters Spell
  - Spell counters Shield
  - Shield counters Sword
- **Rewards**: Dungeon Scrap (soulbound) + random items/materials/skins
- **Currency**: Dungeon Scrap (used for combat skill upgrades + gear crafting)

#### Dungetron: Underhaul
- **Energy cost**: 40 per run
- **Daily limit**: 9 runs (12 if juiced)
- **One-time unlock**: 150 Giga Shards
- **Combat**: Same Sword/Shield/Spell system
- **Rewards**: Giga Shards (soulbound) + random items/materials/skins
- **Currency**: Giga Shards (used for Underhaul skill upgrades)

#### Dungetron 5000: Gigus (added mid-2026)
- **Energy cost**: 200 per run ("extreme version of the dungeon")
- **Daily limit**: 30 runs (same juiced; "subject to change")
- **Combat**: Identical to Normal dungeon combat
- **Rewards**: **Gigus materials only** — drops NO scrap; this is the sole
  source of Gigus materials in the game
- Flee via ladder after defeating an enemy to bank progress without dying

#### Dungetron: Void (event dungeon, added mid-2026)
- **Opens only during specific events**; mechanics/rewards vary per event
- **Entry**: item-based (e.g. gigabit, in-game resources), not energy;
  requirements change per event. No daily limit currently
- **Gear and Charms are disabled**; consumables allowed
- **Void skills** (level with Void essence, reset each event): HP, Armor,
  Tenacity (1%/lvl), Block (1%/lvl), Evasion (0.5%/lvl), Luck (0.75%/lvl),
  Intuition (0.5%/lvl) — these map to the `tenacity/block/evasion/lck/intuition`
  fields on the dungeon Player API object
- **Rewards**: event items, temporary weapon skill upgrades, gigabit jackpots
  for defeating player Echoes or final bosses

#### Echo Battles
- Appear after reaching level 10 in each dungeon
- Echoes mirror real players' stats (HP, mana, name, level, faction)
- Chance to appear in every room (not guaranteed)
- Drop event items during competitions
- Defeating echoes yields both player and echo Faction Stubs

### Player Actions (Automatable)
1. Enter dungeon (costs 40 energy)
2. Choose Sword/Shield/Spell each turn
3. Collect loot after defeating enemy
4. Choose to continue or exit via ladder between rooms
5. Use consumables during combat
6. Equip dungeon bag before entering

### API Endpoints (Known)
- `POST /api/game/dungeon/action` - All dungeon actions
- Loot actions: `loot_one`, `loot_two`, `loot_three`
- Uses `actionToken` (timestamp number)

### Automation Potential: **HIGH** (already partially built)
- Auto-battle with move selection strategy (MCTS or pattern-based)
- Auto-loot collection
- Auto-run management (repeat runs until daily limit)
- Auto-consumable usage
- Auto-exit when low HP

---

## 2. Fishing

### Overview
Card-based minigame on a 3x3 grid. Play spell cards to hit fish. Fish move in patterns between cells after each spell cast.

### Mechanics
- **Grid**: 3x3
- **Spell cards**: Have mana cost, hit locations, and damage multipliers
  - Blue squares = normal hits
  - Yellow squares = critical hits
  - Red/Grey squares = misses
- **Catch meter**: Fills on hits, depletes on misses. Full meter = catch
- **Pattern recognition**: Fish follow predictable movement patterns
- **Hand redraw**: Costs 1 mana per remaining card

### Cast Types & Energy
| Cast Type | Energy Cost |
|-----------|-------------|
| Small Cast | 12 energy |
| Normal Cast | 16 energy |
| Big Cast | 20 energy |

### Daily Limits
- Standard: 10 casts/day
- Juiced: 20 casts/day

### Fish Properties
- Stats: Weight, Length, Girth
- Rarities: Common, Uncommon, Rare, Epic, Legendary, Relic, Giga
- Quality: 1-Star through 5-Star (unlocked at fishing level 10 or via Taste skill)
- Higher quality = 40-60% bonus seaweed per star past 1

### Equipment
- **Rods**: Wood (Common, 1 repair), Stone (Uncommon, 1 repair), Phin's Rod (Epic, 2 repairs)
- **Lures**: Pengu Lure (Dual Yielding boost), Chimpu Lure (Jebait + Fintuition boost)
- Rods provide starting spell decks based on type/rarity
- Each successful catch adds a new spell to deck for that day

### Fish Stall (Tonno)
- Sell fish for Seaweed currency
- Upgrade fishing skills with Seaweed
- View Findex (catch records), equipment, daily spells
- View catch rates and fishing competitions

### Player Actions (Automatable)
1. Start a cast (choose cast type)
2. Observe fish position on 3x3 grid
3. Play spell cards (predict fish movement)
4. Redraw hand (optional, costs mana)
5. Repeat until catch meter fills or run out of mana
6. Sell caught fish at Fish Stall
7. Upgrade fishing skills with Seaweed

### API Endpoints (Likely)
- `POST /api/game/fishing/cast` - Start fishing
- `POST /api/game/fishing/spell` - Play a spell card
- `POST /api/game/fishing/sell` - Sell fish
- `GET /api/game/fishing/deck` - Get current deck
- `GET /api/game/fishing/skills` - Get fishing skills

### Automation Potential: **HIGH**
- Pattern recognition for fish movement prediction
- Optimal spell card selection
- Auto-cast management (repeat until daily limit)
- Auto-sell fish at stall
- Auto-upgrade fishing skills

---

## 3. Crafting & Stations

### Overview
Four crafting stations, each with specific functions. Requires materials + energy.

### Alchemy Bench
- **Location**: North of lobby, near Dungetron entrance
- **Function**: Craft consumables (potions for dungeon combat)
- **Success rate**: 70% (failed crafts lose ingredients)
- **Faction-specific**: Different factions need different materials (dust/shards types)
- **XP**: Earns Alchemy XP (soulbound) per craft

### Workbench
- **Location**: Center of map
- **Function**: Craft gear from vanity skins
- **Success rate**: 100% (currently)
- **XP types needed**: Alchemy XP (starter gear), Workbench XP (mid/high gear)
- **XP**: Earns Workbench XP (soulbound) per craft

### Gear Station
- **Location**: Beside Dungetron stairway
- **Functions**: Equip gear, repair gear, burn gear for Ember, restore gear with Ember
- **Equip slots**: Gear (stats) and Skins (cosmetic overlay)

### Hatchery
- **Location**: Underground room near fishing pond
- **Function**: Incubate Gigling eggs
- **Mechanics**: Balance temperature + comfort for quality/speed
- **Resources**: Biofuels + Incube (soulbound, from dungeon material trades)
- **Faction influence**: Feed eggs faction dust (5-25 dust) for up to 95% faction probability

### Player Actions (Automatable)
1. Craft consumables at Alchemy Bench
2. Craft gear at Workbench
3. Equip/repair gear at Gear Station
4. Burn gear for Ember at Gear Station
5. Restore gear with Ember
6. Manage hatchery eggs (temperature/comfort)

### API Endpoints (Likely)
- `POST /api/game/craft/alchemy` - Craft consumable
- `POST /api/game/craft/workbench` - Craft gear
- `POST /api/game/gear/equip` - Equip gear
- `POST /api/game/gear/repair` - Repair gear
- `POST /api/game/gear/burn` - Burn gear for Ember
- `POST /api/game/gear/restore` - Restore gear
- `POST /api/game/hatchery/feed` - Feed egg

### Automation Potential: **MEDIUM**
- Auto-craft consumables in bulk (account for 70% success rate)
- Auto-repair gear when durability low
- Auto-equip best gear
- Hatchery management (monitor temp/comfort)

---

## 4. Conquest (PvP)

### Overview
Social team-based PvP mode. Factions compete to control territory on a shared map.

### Mechanics
- Deploy Faction Stubs to capture territory
- Use opponent Faction Stubs to reduce rival control
- **Stubs are burned when used** (permanent consumption)
- Stubs earned from: Echo battles, fishing, other activities

### Reward Formula
```
Crowns = Individual Contribution × Faction Rank
Individual Contribution = Player Stubs Placed / Total Faction Stubs Spent
Faction Rank Multiplier: 100x (last) to 700x (first)
```

### Leaderboard
- Global and faction-specific rankings
- Real-time updates
- Stub scores reset when switching factions (resume if returning)
- Only current faction contributions count at end

### Player Actions (Automatable)
1. Deploy faction stubs to territories
2. Use opponent stubs against rival territories
3. Monitor leaderboard positions
4. Strategic timing of stub deployment

### Automation Potential: **MEDIUM**
- Auto-deploy stubs based on strategy
- Monitor territory control
- Optimize contribution timing

---

## 5. Trading / Gigamarket

### Overview
On-chain marketplace / order book for item trading between players. 250,000+ trades in first two weeks.

### Tradeable Item Types
1. Materials
2. Consumables
3. Skins
4. Collectibles

**NOT tradeable**: Gear (soulbound once crafted), Dungeon Scrap, Giga Shards, Seaweed

### Features
- ETH to USD conversion display
- Bulk purchase and listing
- Floor price listing
- Abstract Global Wallet integration

### Important Notes
- Items may take time to appear after purchase (use Refresh)
- Front-end can process faster than backend listings update
- **Gigus Maximus monitors trading behavior** (potential consequences)
- Items can also be exported on-chain and traded on OpenSea/MagicEden (with export fees)

### Player Actions (Automatable)
1. List items for sale
2. Buy items
3. Monitor prices
4. Bulk buy/sell
5. Price arbitrage between Gigamarket and external marketplaces

### API Endpoints (Likely)
- `GET /api/game/market/listings` - Browse listings
- `POST /api/game/market/list` - List item for sale
- `POST /api/game/market/buy` - Buy item
- `GET /api/game/inventory` - View inventory

### Automation Potential: **HIGH**
- Price monitoring and alerts
- Auto-list items at optimal prices
- Snipe underpriced listings
- Bulk listing management
- Inventory management

---

## 6. Traveling Merchants

### Hugis (Item → Abstract Stubs)
- **Deals**: Weekly and daily offerings
- **Function**: Trade in-game items for Abstract Stubs
- **Juiced bonus**: 4x stubs per trade
- **Max trades**: Each deal has a cap (shown as counter e.g. 0/4)
- **Leaderboard**: 7-day cycle, Friday 6pm UTC to Friday 6pm UTC
  - Rank 1: 1x Gold medal
  - Ranks 2-5: Silver medals
  - Ranks 6-100: Copper medals
  - Ranks 41-500: Wood medals

### Munis (Gigus Dust/Shards → Items)
- Sells exclusive deals for various items
- Accepts Gigus Dust and Shards as currency
- Includes limited-time exclusive items + standard resources

### Player Actions (Automatable)
1. Check available deals
2. Execute trades with Hugis (maximize stub earning)
3. Buy items from Munis
4. Track leaderboard position

### Automation Potential: **HIGH**
- Auto-trade with Hugis daily (maximize Abstract Stubs)
- Monitor deal rotations
- Optimize which items to trade vs keep

---

## 7. ROMs & Energy

### Overview
ROMs are ERC-721 NFTs (10,000 supply) that function as resource factories.

### ROM Tiers
| Tier | Supply | Production |
|------|--------|------------|
| Silver | 5,800 | Base |
| Gold | 3,200 | Higher |
| Void | 850 | Higher still |
| Giga | 150 | Highest |

### ROM Traits
- **Tier**: Determines production volume
- **Faction**: Defines which faction resources are produced
- **Memory**: Larger = more claimable energy
- **Serial Number**: Unknown purpose
- **Stub Boost Level**: 1-60, higher = more passive Abstract Stubs (up to 600%)

### ROM Mechanics
- **Linking**: Connect one ROM to another = 60% production boost (stackable with Juice 20% = 80% total). Linked ROM stops independent production but both still generate stubs.
- **Upgrading**: Level 1-60 using Gigus Dust (dust obtained by converting energy)
- **Energy generation**: ROMs provide energy for all game actions
- **Resource generation**: Produce faction-specific materials continuously
- **Stub generation**: Passive Abstract Stubs weekly

### Energy System
- **Base daily energy**: 240 (420 if juiced)
- **Regen rate**: 10/hour (17.5/hour if juiced)
- Energy is consumed by: dungeons (40), fishing (12-20), pots (5), crafting

### Player Actions (Automatable)
1. Claim ROM resources
2. Claim ROM energy
3. Link/unlink ROMs
4. Upgrade ROM levels with Gigus Dust
5. Convert energy to Gigus Dust
6. Monitor resource production

### API Endpoints (Known)
- `GET /api/roms/player?id={address}` - Get player ROMs

### Automation Potential: **MEDIUM**
- Auto-claim resources on schedule
- Auto-claim energy
- Monitor ROM status

---

## 8. GigaJuice (Subscription)

### Overview
Premium subscription available in 7, 30, 90, or 180-day durations. Longer = cheaper per day.

### Benefits Summary
| Feature | Base | Juiced |
|---------|------|--------|
| Daily energy | 240 | 420 |
| Energy regen | 10/hr | 17.5/hr |
| ROM material boost | - | +20% |
| Potion slots | 2 | 3 |
| Movement | Walk | Sprint (Shift) |
| Exclusive chest | No | Yes (weekly) |
| High-intensity runs | 1x | 3x (energy & rewards) |
| Dungetron 5000 runs | 10/day | 12/day |
| Underhaul runs | 8/day | 9/day* |
| Fishing casts | 10/day | 20/day |
| Hugis stub multiplier | 1x | 4x |
| Dungeon upgrade options | Standard | 4 options (50% chance) |

*Note: docs say 8→9 for Underhaul elsewhere

### Purchase
- Juice Vending Machine in spawn area
- Select duration, complete checkout flow

### Automation Potential: **LOW** (one-time purchase, not recurring action)
- Could monitor expiration and alert

---

## 9. Factions

### Overview
8 factions: Archon, Athena, Chobo, Crusader, Foxglove, Overseer, Summoner, Gigus.

### Impact
- Different crafting material requirements (faction-specific dust/shards)
- Faction-specific leaderboards (less competitive = easier to climb for medals)
- Conquest team assignment
- Future expanded mechanics planned

### Faction Switching (Altar Room)
- Costs: Transfusers + faction-specific Dung/Butterflies + Dust/Shards
- **Dynamic pricing**: Cost scales with faction population (popular = expensive, unpopular = cheap)

### Automation Potential: **LOW**
- Could automate faction switching for leaderboard optimization
- Monitor faction populations for optimal timing

---

## 10. World Environment (Pots & Chests)

### Pots
Two types, each requires 5 energy + specific Hands item:

| Pot Type | Tool Required | Contents |
|----------|--------------|----------|
| Blue Pot | Paper Hands | Giga Shards, Dungeon Scrap, Wood, Stone, Glass Orb (rare) |
| Brown Pot | Rock Hands | Giga Shards, Dungeon Scrap, Stone, Wood, Bone, Fiber, Blank Tomes, consumables, Ruby Key (epic) |

### Chests
| Chest | Access | Location | Frequency | Contents |
|-------|--------|----------|-----------|----------|
| Normal | All players | Bottom-right near fishing | Weekly | Common crafting materials |
| Juice | Juiced only | Top-left near Dungetron bridge | Weekly | Hexchain, Sapphire, Soulmint (charm materials) |

### Automation Potential: **MEDIUM**
- Auto-break pots when hands are available
- Auto-claim weekly chests
- Track pot/chest cooldowns

---

## 11. Hatchery / Giglings

### Gigling Racing (added 2026)
- Each Gigling races **2x/day** (3x juiced); limits reset daily
- Race stats rolled fresh per race: Start, Speed, Stamina, Finish
- **Free races**: gas only. **Stakes races**: ETH entry — 85-95% to prize pot,
  1-3% protocol fee (1% juiced), 1-10% creator fee, 2.5% to jackpot
- Config: 2-8 players; 500m/1200m/2500m/3000m; Cold/Average/Hot weather
- Race creation: 5/day (50/day juiced)
- **Jackpot**: 1st place in stakes races can win 40% of jackpot
  (~0.005%-2% odds, capped at 0.1 ETH entry; 2x odds juiced)
- Earns Derby Stubs (more if juiced)

### Gigling Dueling (added 2026)
- Unlocks after a Gigling completes **40 total races**; requires one male +
  one female Gigling
- **3 duels max per lifetime**; 3rd duel the Gigling falls 100%. Loser is
  burned, challenger receives the Duelborn offspring
- **Glue** (from burning Giglings) buys up to 3 extra duels:
  Uncommon 4 / Rare 8 / Epic 12 / Legendary 24 / Relic 32 / Giga 40 yield;
  4-8 Glue per extra duel by rarity
- Duelborn inherits gender from fallen parent, rarity centered on the
  lower-rarity parent, 10% mutation chance per trait

### Hatchery Overview
Pets system. Eggs hatch into Giglings (mounts/companions).

### Egg Types
- **Inaugural Eggs**: Open edition mint, hatch rideable mount (limited availability)
- **ROM Eggs**: Given to ROM holders based on tier, produce Inaugural Steed + ROMling

### Hatching
Three dials, and they are not interchangeable:

- **Temperature** drives **Progress**. At 0 the egg makes no progress at all.
- **Comfort** plus Progress drive **Quality**. Quality is banked as Progress
  accrues, so progress earned at low comfort is permanently worse — this is why
  a short inventory should fund comfort before temperature.
- **Fate** is faction dust fed before the hatch. Without it the Gigling hatches
  factionless, and it cannot be changed afterwards.

Bounds, verified from `/api/offchain/static` → `hatchery` (2026-08-11):

| Field | Value |
|---|---|
| `temperatureConfig` | 0–100, increment 10 |
| `comfortConfig` | 0–5, increment 1 |
| `maxProgress` | 100 |
| `maxRarity` (Quality) | 100 |
| `maxPetsInHatchery` | 300 |

Per-feed stat deltas and the decay rate are **not published anywhere** and are
not in static data. GigaBrain therefore feeds one unit at a time rather than
guessing a batch size.

**Materials** (soulbound; traded from base dungeon materials at Vilhelm's, all
verified from static `recipes` tagged `vilhelm`):

| Recipe | Trade | Raises |
|---|---|---|
| 500001 | 3 Wood → 3 Biofuel (576) | Temperature |
| 500002 | 3 Coal → 3 Biofuel+ (577) | Temperature |
| 500003 | 2 Bone → 1 Incube (578) | Comfort |
| 500004 | 2 Fiber → 1 Incube+ (579) | Comfort |
| 500005 | 5 Stone → 1 Incube++ (580) | Comfort |
| 500006-8 | Faction Silver Ring → Hatchard Kit (581) | Weekly, 2-3 completions |

These run through the ordinary `/api/offchain/recipes/start` endpoint, so
crafting incubation materials needs no new API surface.

**Fate math**: each influence adds +4.75% to the fed faction and +0.25% Gigus.
20 influences = 100% chance of a faction trait. The dust ladder is **per
faction** — 5 for that faction's first influence, +1 for each subsequent one —
so it resets when you switch factions:

- 20 influences on one named faction: 5+6+…+24 = **290 dust**
- 20 influences spread over all seven: **119 dust**, same guarantee, random faction

**Eggspeditors** set Progress to 100 and raise Quality to a floor if it is below
(id → floor): 584 → 10, 585 → 30, 586 → 50, 587 → 70, 589 → 90.

### API Endpoints (verified to exist 2026-08-11)
- `GET /api/pets/player?id={address}` — egg/pet inventory. Unauthenticated.
  Entities carry `docId`, `DESCRIPTION_CID` ("Egg"/"Pet"), `COMPLETE_CID`,
  `data.eggType`, `data.hatchedAt`. **No incubation stats.**
- `GET /api/pets/hatchery` — incubation state. Authenticated; response shape
  unobserved, so GigaBrain matches its fields by pattern.
- `POST /api/pets/feed` — feed an egg. Authenticated. Two things established by
  the server's own errors: `{petId, itemId, amount}` returns
  `{"success":false,"error":"items are required"}`, so `petId` is accepted and
  the item list field is named `items`. The entry shape inside it is still being
  resolved; `{id, amount}` is tried first since that is the tuple
  `gameItemBalanceChanges` uses. See `lib/hatchery-feed.ts`.
- `POST /api/pets/feedpet` — feed a hatched Gigling (hunger/factory). Not used.

Route existence was established by status-code discrimination: unknown paths
under `/api/pets/` return `400 {"error":"Invalid path"}`, while these return
`401`. Note `/api/game/*` returns 401 for *any* path, so the same test does not
work there.

### Automation Potential: **MEDIUM** (built)
- Advisor plans feeds, fate purchases and hatch alerts (`lib/hatchery-advisor.ts`)
- Material shortfalls resolve to a runnable Vilhelm trade

---

## 12. Skill Systems

### Combat Skills (8 total, max combined level 100)
| Skill | Function |
|-------|----------|
| Sword ATK | Sword attack power |
| Sword DEF | Sword defense |
| Shield ATK | Shield attack power |
| Shield DEF | Shield defense |
| Spell ATK | Spell attack power |
| Spell DEF | Spell defense |
| Max HP | Maximum health |
| Max AMR | Maximum armor |

- **Currency**: Dungeon Scrap (for D5000), Giga Shards (for Underhaul)
- **Both soulbound**, cannot be interchanged
- **Respec**: Temporal Hourglasses, 75% material refund

### Fishing Skills (8 total)
| Skill | Function |
|-------|----------|
| Stamina | Starting mana |
| Rod Control | Critical cast chance |
| Jebaitor | Chance to keep bait after cast |
| Weed Dealer | Better fish sell prices |
| Taste | Fish quality upgrade chance |
| Luck | Fish rarity upgrade chance |
| Fintuition | Predict next fish action |
| Dual Yielding | Catch two fish from one cast |

- **Currency**: Seaweed (from selling fish)
- **Respec**: 4 Hourglasses per level, 75% Seaweed refund

### Automation Potential: **LOW**
- Auto-allocate skill points based on optimal builds
- One-time setup, not recurring

---

## 13. Gear & Equipment

### Gear Types
Head, Body, Charms, Hands, Lures, Rods

### Rarity (random on craft/restore)
| Rarity | Chance |
|--------|--------|
| Common | 50% |
| Uncommon | 30% |
| Rare | 15% |
| Epic | 5% |

### Durability & Repair
- Gear degrades during use, breaks when durability hits 0
- Repair at Gear Station (costs resources)
- **Head/Body**: 5 repairs max, can be restored with Gear Ember (resets repairs, re-rolls rarity)
- **Charms**: 2 repairs max, mostly cannot be restored
- **Hands**: repair only, no restoration

**Restorability is per item, not per gear type.** `/api/gear/items` publishes a
`repairCost` block on every gear definition:

| Field | Meaning |
|---|---|
| `INPUT_ID_CID_array` / `INPUT_AMOUNT_CID_array` | cost of one repair |
| `RESET_INPUT_ID_CID_array` / `RESET_INPUT_AMOUNT_CID_array` | cost of one restore — **empty means the item has no restore at all** |
| `REPAIR_COUNT_CID` | repairs allowed before the limit |
| `LOOT_ID_CID` / `LOOT_AMOUNT_CID` | what burning it yields |

Counts from live data (2026-08-13), restorable vs not:
Head 50/0 · Body 49/0 · Charms **5/13** · Hands 0/2 · Rods 5/3 · Lures 6/2.

So the type is not a reliable guide — some charms, rods and lures restore and
others don't. Read `RESET_INPUT_ID_CID_array` per item.

**Two failures look identical from the server.** `POST /api/gear/restore`
answers `{"message":"Reset items not found"}` both when the player lacks the
reset items *and* when the item has no reset recipe at all. They call for
opposite responses — farm Gear Ember, or stop and burn the piece — so check the
definition before sending. Worse, the repair endpoint's own error ("Gear is
already at max repair count 2 of 2. Use restore endpoint instead") points at a
restore that, for a Soulmint Necklace, can never succeed.

Handled in `lib/gear.ts` (`restoreVerdict`).

### Gear Ember
- Generated by burning Head/Body gear at Gear Station
- Advanced dungeon gear costs more Ember to restore but yields more when burned

### Trading
- Gear is soulbound (cannot trade once crafted)
- Only vanity skins can be traded

### Automation Potential: **MEDIUM**
- Auto-repair gear when low durability
- Auto-craft replacement gear when beyond repair limit
- Optimal Ember management (burn vs restore decisions)

---

## 14. Abstract Ecosystem (XP & Stubs)

### Abstract Stubs
- Weekly cycle: Friday 6pm UTC to Friday 6pm UTC
- **Earning**: Hugis trades, ROM passive generation, game activities
- **Snapshot**: Burned every Friday, applied to following Tuesday's Abstract XP drop
- Stubs do NOT carry over between weeks
- ROM stubs don't appear on leaderboard

### Abstract XP
- Earned from Abstract Stubs + holding ROMs
- Rewards at abs.xyz/rewards
- Weekly snapshot Friday 12PM UTC

### Automation Potential: **MEDIUM**
- Ensure all Hugis trades completed before Friday deadline
- Monitor stub accumulation
- Optimize weekly activity for maximum XP

---

## 15. The Awakening (seasonal event: Aug 10 - Oct 10, 2026)

- Collect **Cores** via the event dungeon + fishing pond, resource conversion
  (ROMs, Giglings, relic armor), and daily/weekly quests + item turn-ins
- **Juiced players earn 4x Cores**
- Separate gear track: only gear crafted in The Awakening zone works in the
  event dungeon/pond (rods, lures, charms, head/body)
- **Prize pool**: $20,000 USDC start + 50% of Juice purchases, marketplace
  fees, and vendor sales during the event; paid via gacha boxes to players
  above a minimum Core threshold
- **Hall of Noobs**: Core-count rankings; positioned as long-term player
  alignment ledger
- Carries into Gigaverse Online: Giga Juice, GIGABIT, cosmetics, SBTs, Dung,
  butterflies, Gigacha coins ("eternal" items)
- **Automation angle**: quest/turn-in completion daily, maximize Core/energy
  during the window, juiced 4x makes Juice ROI-positive for the event

---

## 16. Automation Priority Matrix

### Tier 1 - High Value, High Feasibility (Build First)
| System | Why | Actions/Day |
|--------|-----|-------------|
| **Dungeon Auto-Battle** | Core loop, 10-12 runs/day, drops items + scrap | ~40-48 runs (both types) |
| **Fishing Auto-Cast** | 10-20 casts/day, earns seaweed + fish to sell | 10-20 casts |
| **Hugis Trading** | Maximize Abstract Stubs weekly, 4x if juiced | Daily deals |

### Tier 2 - Medium Value (Build Second)
| System | Why | Actions/Day |
|--------|-----|-------------|
| **Gigamarket Trading** | Price monitoring, sniping, bulk management | Continuous |
| **Pot Breaking** | Materials for crafting, 5 energy each | When hands available |
| **Consumable Crafting** | Keep dungeon bag stocked (70% success rate) | As needed |
| **Gear Management** | Auto-repair, equip best, burn/restore cycle | As needed |
| **ROM Claims** | Claim energy + resources on schedule | Periodic |
| **Chest Claims** | Free weekly materials | Weekly |

### Tier 3 - Low Value or One-Time (Build Later)
| System | Why | Actions/Day |
|--------|-----|-------------|
| **Conquest** | Strategic, benefits from human decision-making | Event-based |
| **Hatchery** | Slow, periodic checks | Periodic |
| **Skill Allocation** | One-time setup per build | Rare |
| **Faction Switching** | Situational optimization | Rare |

---

## Technical Notes

### Game Infrastructure
- **Blockchain**: Abstract (L2)
- **Game URL**: https://gigaverse.io/play
- **Auth**: JWT via Privy wallet, stored in localStorage `authResponse.jwt`
- **API Base**: `https://gigaverse.io`
- **Item Contract**: `0x50A5eb2B3B289D4cFda0e307609b655175a275b1` (ERC-1155)
- **Game items are on-chain** (can be exported, but with fees)

### Known API Patterns
- Dungeon: `POST /api/game/dungeon/action` with action types
- ROMs: `GET /api/roms/player?id={address}`
- All requests use `Authorization: Bearer <jwt>`
- Action token is a timestamp number

### Endpoints Still Needed (to discover via network traffic)
- Fishing endpoints (cast, spell play, sell)
- Crafting endpoints (alchemy, workbench)
- Market endpoints (list, buy, browse)
- Merchant endpoints (Hugis trades, Munis purchases)
- Conquest endpoints (deploy stubs)
- Inventory/gear management endpoints
- ROM resource claim endpoints
- Pot/chest interaction endpoints
- Skill upgrade endpoints
- Energy/resource status endpoints

### Anti-Cheat Considerations
- Gigus Maximus "monitors behaviors and performance of all players"
- Trading behavior is specifically monitored on Gigamarket
- Bots are **explicitly allowed** per fair play rules
- Prohibited: client hacking, DDOS, double spending, smart contract exploits, phishing
- Multiple accounts are explicitly allowed
