# Favour of Olympus repository guide

## Project structure

This is a pnpm monorepo for an online multiplayer Favour of Olympus game.

- `apps/client` — React and Vite browser client
- `apps/server` — Effect and Socket.IO backend
- `packages/game` — pure, transport-independent game rules
- `packages/protocol` — shared network contracts and Effect Schemas
- `packages/content` — card metadata and stable asset keys
- `apps/client/public/assets` — optimized assets shipped to browsers
- `design` — editable artwork and audio source files

## Architecture rules

- The server is authoritative for game state, turns, randomness, and scoring.
- Keep `packages/game` deterministic and free of React, Socket.IO, Effect
  runtime services, persistence, and other infrastructure.
- Validate all network input at runtime in `packages/protocol`; TypeScript types
  alone are not a trust boundary.
- Socket.IO transports commands and snapshots. Do not place game rules in socket
  handlers.
- Prefer complete game snapshots with monotonically increasing revisions over a
  custom state-patching protocol.
- Store asset keys in shared content. Resolve those keys to files only in the
  client.

The intended dependency direction is:

```text
client ──► protocol ◄── server
              │            │
              ▼            ▼
             game ◄────────┘

client ──► content
```

Shared packages must not import from either application.

## Development commands

Run commands from the repository root:

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
```

Before handing off a change, run the checks relevant to it. For cross-workspace
changes, run `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Code conventions

- Use strict TypeScript and avoid `any`.
- Prefer named exports.
- Keep React components focused and colocate component-specific styles and
  helpers.
- Clean up subscriptions, timers, and Effect resources.
- Model expected domain failures as typed errors rather than thrown strings.
- Generate and verify randomness on the server.
- Add deterministic tests alongside game-rule changes.
- Do not commit `node_modules`, `.pnpm-store`, build output, coverage, or secrets.

## Assets

Put browser-ready WebP, AVIF, SVG, and compressed audio files under
`apps/client/public/assets`. Keep large editable source files under `design`.
Do not add third-party artwork, logos, or audio unless the project has permission
to distribute them.
