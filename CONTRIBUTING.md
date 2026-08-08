# Contributing

Thanks for pitching in. Keep it small and focused — one change per PR.

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

```bash
git clone https://github.com/jnew00/gigabrain.git
cd gigabrain
npm install

# One-time: activate versioned git hooks (runs gitleaks on every commit)
git config core.hooksPath .githooks

npm run dev
```

You'll need a Gigaverse account to test against — the app talks to the live game with your own session token. `DATABASE_URL` (Postgres) is optional; without it, run-history features no-op.

## Checks

```bash
npm run lint
npm run build
```

Both must pass; CI runs the same two.

## Commit style

Conventional Commits, lowercase, no trailing period:

```
feat: add underhaul skill ladder
fix(fishing): weight prediction by momentum
```

## PR process

1. Branch from `main`.
2. Keep the diff scoped to one change.
3. Note any new Gigaverse endpoints you captured (URL + payload shape) in the PR description and in `REQUIREMENTS.md`.
4. CI green, then request review.

## Reporting issues

Use the issue templates. For game-behavior bugs, include what the game did vs. what GigaBrain did — the API is reverse-engineered, so captures (network tab request/response) are the most valuable thing you can attach.
