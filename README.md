<p align="center">
  <img src="public/gigabrain-icon.png" width="96" alt="GigaBrain" />
</p>

<h1 align="center">GigaBrain</h1>

<p align="center">Mission control for <a href="https://gigaverse.io">Gigaverse</a> — auto-battler, fishing AI, energy & skill advisors, and one-click daily automation.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" /></a>
  <img src="https://github.com/jnew00/gigabrain/actions/workflows/ci.yml/badge.svg" alt="CI" />
</p>

<p align="center"><strong><a href="https://gigabrain-eosin.vercel.app">gigabrain-eosin.vercel.app</a></strong> — hosted instance, no setup</p>

---

Gigaverse's fair play rules [explicitly allow](https://docs.gigaverse.io/general/fair-play-rules) tools and bots: *"You may create tools & bots, or leverage AI agents, to assist in playing the game for you."* GigaBrain is that, with a cockpit UI.

## What it does

- **Run Plan** — the whole daily loop on one button: repair worn gear, claim ROM shards/dust/energy, open chests, break pots, vote on the Abstract portal, trade every affordable Hugis deal to its cap, run dungeons to their daily limits, fish to the cast cap, sell +50% fish.
- **Auto-battler** — 4-round lookahead move selection with per-enemy move history, counter-picking, and loot scoring. Chain runs back to back.
- **Fishing AI** — probability-weighted card scoring against predicted fish movement (near-100% hit rate with Fintuition). Auto-fish to the daily cap.
- **Energy advisor** — allocates your daily energy across dungeons and fishing by value-per-energy, warns when you're capped and wasting regen, and knows when to claim ROM energy instead of dusting it.
- **Skill advisor** — recommended upgrade paths per tree (combat tuned to how the auto-battler plays, fishing tuned to the card AI), one-click batch apply, respec flagged with the math when your allocation fights the build.
- **Hatchery advisor** — holds every incubating egg at full temperature and comfort, funding comfort first because quality is banked as the egg progresses and cannot be recovered later. Plans the cheapest faction dust route to a guaranteed faction trait (119 dust spread across seven ladders, against 290 for one named faction), turns material shortfalls into a runnable Vilhelm trade, and alerts when an egg is ready to hatch, stalled cold, or about to hatch factionless.
- **Intel** — enemy move patterns, run history, win rates, and loot totals persisted per wallet.

## Quickstart

Use the hosted instance — [gigabrain-eosin.vercel.app](https://gigabrain-eosin.vercel.app) — or self-host:

```bash
npm install
npm run dev
```

Open http://localhost:3000 and connect with your Abstract Global Wallet (or paste a session JWT as fallback).

### Environment

Optional. Without a database, everything works except persisted run history and the history-driven advisor tuning.

```bash
DATABASE_URL=postgres://...   # Neon (or any Postgres) — stores run history
```

Run history is per-wallet and feeds the energy advisor's win-rate and average-depth
advice. If you previously ran GigaBrain with an `enemy_moves` table, it is no longer
read or written and can be dropped: `DROP TABLE enemy_moves;`

## Auth & privacy

- Your session token never leaves your browser except to be forwarded, per-request, to `gigaverse.io`. It is not stored server-side. The entire proxy is ~100 lines: [`app/api/proxy/route.ts`](app/api/proxy/route.ts) — read it.
- The proxy only forwards to an allowlist of known Gigaverse endpoints.
- No private keys, ever. Wallet auth goes through Abstract Global Wallet's own flow.
- If you use someone else's hosted instance, your authenticated game traffic transits their server and your run stats land in their database (keyed by wallet address, no credentials). Self-host if that bothers you.

## Disclaimer

Community tool, not affiliated with Gigaverse or GLHF. Automation is permitted under the fair play rules as of August 2026; rules can change — use at your own risk.

## Support

Free forever. If it's earning you scrap: [ko-fi.com/inceptyon](https://ko-fi.com/inceptyon), or the in-app Support panel has wallet addresses.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). After cloning, activate the secret-scan hook:

```bash
git config core.hooksPath .githooks
```

## License

[AGPL-3.0](LICENSE)
