# Gigaverse Controller — Requirements

> Last updated: 2026-03-17
> Bots and automation are **explicitly allowed** per Gigaverse Fair Play Rules.

---

## What We Have (v0.2 — Current)

### Architecture
- **Framework**: Next.js 16 + TypeScript + Tailwind 4
- **UI**: Sidebar + tabbed main area (Dungeon / Stats & Intel), dark theme with glow effects, Outfit font
- **Auth**: AGW wallet connect (primary) + manual JWT paste (fallback), auto-restore from localStorage
- **API Proxy**: `/api/proxy` route to bypass CORS
- **State**: `useGigaverse` hook managing all API calls and game state
- **Persistence**: SQLite (`better-sqlite3`) for enemy intel + run history; localStorage for JWT
- **Icons**: Custom generated move icons (sword/shield/spell PNGs) + Lucide for UI

### Working Features
- [x] AGW wallet connect (Abstract Global Wallet via `@abstract-foundation/agw-react`)
- [x] JWT persistence in localStorage with auto-restore on page load
- [x] Fallback manual JWT paste login
- [x] Dashboard with sidebar: energy, dungeon status, runs today, ROMs, stats summary, enemy intel summary, activity log
- [x] Tabbed main area: Dungeon (combat) and Stats & Intel pages
- [x] Dungeon auto-battle (Greedy algorithm with spam avoidance)
  - Smart move selection: ranks by ATK, avoids 1-charge moves when safe alternatives exist
  - Counter-picking from enemy move history (>60% confidence threshold)
  - Spam penalty avoidance: never plays a move at 1 charge if a safe option exists
- [x] Loot scoring with rarity weighting
  - Rarity scales quadratically for Max HP/Shield boons (epic/legendary highly valued)
  - Move upgrades weighted by which moves you actually use (primary 5x, secondary 3x, unused 0.5x)
  - ATK valued 3x over DEF
  - Heal urgency scaling based on current HP %
- [x] Enemy move tracking (SQLite, per enemy ID + room + round)
- [x] Enemy counter-picking (>60% confidence threshold, round-specific predictions)
- [x] Run summary with Victory/Defeated, rooms cleared, items collected, boons chosen
- [x] Run chaining: auto-start next run when previous completes, aggregate chain summary
- [x] Run statistics: win rate, avg rooms, all-time items (persisted in SQLite)
- [x] Stats & Intel page: run stats dashboard + enemy round-by-round pattern analysis
- [x] Item name + rarity resolution from `/api/offchain/static` + `/api/indexer/gameitems`
- [x] Enemy name resolution from `/api/offchain/static`
- [x] Item drops shown after each combat round with rarity colors
- [x] ROM display with E/S/D claim buttons
- [x] Manual combat controls with custom move icons and "best" indicator
- [x] Dungeon selection with energy check (disabled when insufficient, shows "need X more")
- [x] Floor/Room display derived from ROOM_NUM_CID
- [x] Real-time health/shield bars with gradient fills
- [x] Fighter panels with enemy names, last move indicators, win/loss animations (shake + flash)
- [x] Death overlay (skull icon) when fighter HP reaches 0
- [x] Boon names translated from API values (UpgradeRock → Sword +3 ATK / +1 DEF)
- [x] Activity log with timestamped entries
- [x] Username display from account API

### Known API Endpoints (Verified March 2026)
See `GAME_SYSTEMS.md` and `memory/project_gigaverse_api.md` for full reference.

**GET** (33 on page load):
- `/api/user/me`, `/api/account/{addr}`, `/api/user/discord`
- `/api/offchain/player/energy/{addr}`, `/api/offchain/static`
- `/api/game/dungeon/state`, `/api/game/dungeon/today`
- `/api/roms/player?id={addr}`, `/api/gear/items`, `/api/gear/instances/{addr}`
- `/api/indexer/gameitems`, `/api/indexer/player/gameitems/{addr}`
- `/api/factions/player/{addr}`, `/api/factions/summary`
- `/api/gigajuice/player/{addr}`, `/api/items/balances`
- `/api/fishing/cards`, `/api/fishing/state/{addr}`
- `/api/marketplace/item/floor/all`, `/api/marketplace/eth/player/{addr}`
- `/api/vendor/listings?wallet={addr}`, `/api/conquest/current?player={addr}`
- `/api/offchain/skills`, `/api/offchain/skills/progress/{noobId}`
- `/api/offchain/equipment/{id}/{noobId}`, `/api/offchain/recipes/player/{addr}`
- `/api/itempools/public`, `/api/redeem/offchain-history`
- `/api/pets/player?id={addr}`, `/api/upvote?address={addr}`

**POST** (verified):
- `/api/user/auth` — wallet signature authentication → JWT
- `/api/game/dungeon/action` — start_run, rock, paper, scissor, loot_one/two/three, use_item
- `/api/roms/factory/claim` — claim energy/shard/dust from ROMs
- `/api/game/skill/levelup` — level up a skill stat

**POST** (verified):
- `/api/offchain/recipes/start` — pots, chests, crafting (Recipe#700000=Chest, #700001=Blue Pot, #700002=Tan Pot, #700003=Juice Chest). Also Hugis/Munis trades (captured Aug 2026: `{recipeId: "Recipe#90217", noobId, gearInstanceId: "", nodeIndex: 0, quantity: 1}`) — vendor listings are recipe entities.
- `/api/gear/repair` — repair gear (captured Aug 2026: `{gearInstanceId: "GearInstance#336_..."}`)
- `/api/roms/factory-claim` — claim ROM resources + convert energy to dust (claimId: "gigusDust")

**POST** (unverified, need traffic capture):
- Fishing endpoints, market, merchant trades, gear management, conquest

### Files
```
gigaverse-controller/
  app/
    actions.ts              — Server actions (auth, enemy intel, run history)
    api/proxy/route.ts      — CORS proxy
    globals.css             — Dark theme with glow effects, animations
    layout.tsx              — Outfit font, AbstractWalletProvider
    page.tsx                — Sidebar + tabbed main (Dungeon/Stats), all UI
    providers.tsx            — AbstractWalletProvider wrapper
  lib/
    auto-battle.ts          — Combat AI, loot scoring, move selection
    enemy-db.ts             — SQLite DB (enemy moves + run history)
    enemy-tracker.ts        — Pure functions for enemy move analysis
    gigaverse-client.ts     — API client (direct, used for reference)
    types.ts                — All TypeScript interfaces
    use-gigaverse.ts        — React hook for state management + persistence
  data/
    enemy-intel.db          — SQLite database (gitignored)
  public/
    icons/                  — Custom move icons (sword.png, shield.png, spell.png)
  GAME_SYSTEMS.md           — Full game systems reference
  REQUIREMENTS.md           — This file
```

---

## What We're Building (Roadmap)

### Phase 1 — Core Automation (Current Focus)

#### 1.1 Dungeon Auto-Battle Improvements
- [x] Smart move selection with spam avoidance
- [x] Loot scoring with rarity weighting + move relevance
- [x] Run chaining option: auto-start next run when previous completes
- [x] Run statistics tracking: win rate, avg rooms cleared, items per run
- [x] Enemy counter-picking from round-specific frequency data
- [x] Implement DP algorithm (4-move lookahead with memoization)
- [x] Use known enemy base stats from `/api/offchain/static` for first-encounter predictions
- [ ] Auto-use consumables when HP drops below threshold
- [ ] Auto-equip best gear before starting a run
- [x] Support all dungeon types (D5000, Underhaul, Temporal Void, Gigus Dungeon)

#### 1.2 ROM Resource Management
- [x] Claim all ROMs with one button (+ convert energy to Gigus Dust)
- [ ] Auto-claim energy on schedule (when near cap)
- [ ] Auto-claim shards and dust
- [ ] Show time until next claim is optimal
- [x] ROM status dashboard (production rates, link status)

#### 1.3 Upvote on Abstract Portal
- [x] Capture the upvote API endpoint from network traffic
- [x] Auto-upvote when available (daily?)
- [x] Show upvote status in sidebar

### Phase 2 — Fishing Automation

#### 2.1 Fishing System
- [x] Capture fishing API endpoints via browser traffic
- [x] Implement fishing state display (3x3 grid, spell deck, mana)
- [ ] Fish movement pattern tracking (similar to enemy tracker)
- [x] Optimal spell card selection algorithm
- [x] Auto-cast management (choose cast type based on energy/daily limit)
- [x] Auto-sell caught fish at Fish Stall (+50% rate detection)
- [x] Track fishing stats: catch count, seaweed earned, rare catches

#### 2.2 Fishing Skills
- [x] Display fishing skill levels (per-stat rows in Skills flyout)
- [x] Recommend skill point allocation (`lib/skill-advisor.ts` — ladder tuned to the card AI: Fintuition → Stamina → Weed Dealer; respec flagged when >35% of points sit in low-tier stats)
- [x] One-click batch upgrade via `POST /api/game/skill/levelup` (combat trees too; deliberate no full-auto)

### Phase 3 — Economy & Inventory

#### 3.1 Inventory Management
- [ ] Display full inventory with item names, quantities, rarities
- [ ] Show what items can be crafted with current inventory
- [ ] Identify items worth selling vs keeping vs trading

#### 3.2 Gear Management (Needs API Discovery)
- [ ] View all gear with stats, durability, repair count
- [ ] Auto-repair gear when durability is low
- [ ] Auto-equip optimal gear for dungeons
- [ ] Burn/restore cycle management (Ember tracking)
- [ ] Craft replacement gear when beyond repair limit

#### 3.3 Consumable Crafting (Needs API Discovery)
- [ ] Display available recipes with ingredients
- [ ] Auto-craft consumables in bulk (account for 70% success rate)
- [ ] Keep dungeon bag stocked automatically

#### 3.4 Hugis Merchant Trading (Needs API Discovery)
- [ ] Display current Hugis deals (daily + weekly)
- [ ] Auto-trade with Hugis to maximize Abstract Stubs
- [ ] Track weekly stub leaderboard position
- [ ] Alert before Friday 6pm UTC deadline (stubs don't carry over)
- [ ] Calculate optimal items to trade vs keep

#### 3.5 Gigamarket Price Monitoring
- [ ] Display floor prices for key items
- [ ] Price alerts for items below threshold
- [ ] Quick-list items at market price
- [ ] Snipe underpriced listings

### Phase 4 — Authentication & UX

#### 4.1 Abstract Global Wallet Integration
- [x] Install AGW + wagmi + viem dependencies
- [x] Add `AbstractWalletProvider` to app layout
- [x] Implement wallet connect via `useLoginWithAbstract`
- [x] Sign login message: `"Login to Gigaverse at {timestamp}"`
- [x] POST to `/api/user/auth` with `{ address, signature, message, timestamp }`
- [x] Store JWT + expiresAt in persistent state (localStorage)
- [x] Fallback to manual JWT paste if wallet connect fails
- [ ] Auto-refresh JWT before expiration

#### 4.2 UI/UX Improvements
- [x] Persist JWT in localStorage so you don't re-paste
- [x] Run history page (Stats & Intel tab with run stats + enemy analysis)
- [ ] Dark/light theme toggle
- [ ] Mobile-responsive sidebar (collapsible)
- [ ] Notification sounds for run complete, errors
- [ ] Keyboard shortcuts (start run, toggle auto-play)

### Phase 5 — Advanced Features

#### 5.1 World Interaction
- [x] Auto-break pots when Hands items available
- [x] Auto-claim weekly chests (normal + juice)
- [x] Track pot/chest cooldowns

#### 5.2 Conquest
- [ ] Display current conquest state and faction positions
- [ ] Auto-deploy faction stubs based on strategy
- [ ] Monitor territory control and leaderboard

#### 5.3 Hatchery
- [ ] Display egg status (temperature, comfort, progress)
- [ ] Auto-feed eggs with faction dust
- [ ] Alert when eggs ready to hatch

#### 5.4 Multi-Account Support
- [ ] Switch between multiple accounts (multi-accounting is allowed)
- [ ] Run automation on multiple accounts in parallel
- [ ] Aggregate statistics across accounts

---

## API Endpoints Still Needed

These require browser traffic capture (like we did for dungeons):

| System | What to capture |
|--------|----------------|
| Fishing | Start cast, play spell, sell fish, deck/skills management |
| Crafting | Alchemy bench, workbench recipes, craft action |
| Gear | Equip, repair, burn, restore |
| Market | Browse listings, buy, sell/list items |
| Merchants | Hugis trade, Munis purchase, deal listings |
| Conquest | Deploy stubs, territory state |
| World | Break pots, open chests |
| Upvote | Abstract portal upvote action |
| Inventory | Full inventory listing, item details |

**Process**: Open gigaverse.io, perform each action manually while capturing network traffic (same method as dungeon discovery), then add endpoints to the API client.

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | Next.js 16 + React 19 | App Router, server actions, API proxy |
| Styling | Tailwind 4 + CSS vars | Dark theme with glow effects |
| State management | React hooks + refs | Simple, sufficient for single-page app |
| Auto-battle algorithm | Greedy with spam avoidance | Fast, effective; DP planned for lookahead |
| Enemy tracking | SQLite (better-sqlite3) | Persistent across sessions, queryable |
| Run history | SQLite | Permanent stats, aggregatable |
| Auth | AGW wallet connect + JWT | Native wallet flow, auto-restore |
| API access | Server-side proxy + server actions | Avoids CORS, keeps secrets server-side |
| Icons | Generated PNGs (Gemini) + Lucide | Custom move icons matching game aesthetic |

---

## Constraints & Risks

- **API stability**: Endpoints are reverse-engineered, may change without notice
- **Rate limiting**: Unknown limits; currently using 150ms delay between actions
- **JWT expiration**: JWTs expire (check `exp` claim); need refresh mechanism
- **Anti-cheat**: Gigus Maximus monitors behavior; bots are allowed but "client hacking" is not
- **Energy bottleneck**: 240/day base, 420/day juiced — limits total automation throughput
