# Favour of Olympus

Online multiplayer Favour of Olympus monorepo.

## Workspace

- `apps/client` — React and Vite browser client
- `apps/server` — Effect and Socket.IO backend
- `packages/game` — transport-agnostic game domain
- `packages/protocol` — shared, runtime-validated network contracts
- `packages/content` — card metadata and asset keys
- `apps/client/public/assets` — production-ready images and audio
- `design` — editable source artwork that is not shipped

## Commands

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
```

The client runs on `http://localhost:5173` and expects the Socket.IO server at
`http://localhost:3000` unless `VITE_SERVER_URL` is configured.
