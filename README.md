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


------------------------------------------------------------------------


# Favour of Olympus

<img width="1326" height="890" alt="Screenshot 2026-07-18 at 16 52 25" src="https://github.com/user-attachments/assets/c508cc97-f618-485e-ba18-d3bd5ebc29c8" />


> **A multiplayer push-your-luck game of calculated risk, social strategy, and divine interference.**

Players stake their tokens, challenge the room, and compete to become the first **outright leader** to reach **200 points**.

Draw again to grow your score—or withdraw before a duplicate number destroys the round.

Along the way, **twelve God cards** can protect players, rewrite the table, and turn a safe decision into a spectacular mistake.

**The gods introduce power. The room introduces politics.**

---

# The Concept

*Favour of Olympus* takes the accessible hit-or-stay tension of **Flip 7** and transforms it into a shared, live multiplayer spectacle.

Every turn presents a simple choice:

- 🎴 **Hit** to reveal another card and increase your potential score.
- 🛑 **Stay** to leave the round and bank your current score.
- 💥 Draw a number already in your collection and **bust**, losing the round's points.
- ⭐ Collect **seven unique number cards** to achieve **Flip Seven** and earn a bonus.
- 👑 Finish a round as the **outright leader** with at least **200 points** to win the match and claim the staked token pool.

The public table gives every draw an audience.

Stakes give every decision weight.

God cards introduce negotiation, bluffing, alliances, and opportunities for betrayal.

---

# The Divine Twist

Traditional power cards are replaced by **twelve unique God cards**.

These are not passive bonuses. Each god can redirect the current turn or reshape the entire round.

| God | Power |
|------|-------|
| ⚡ Zeus | Protects a player from one incoming duplicate. |
| ⚔️ Ares | Forces any active player to face up to three consecutive draws. |
| 🍷 Dionysus | Forces an active player to stay and bank their current score. |
| 🦉 Athena | Privately views the next three cards and returns them in any order. |
| ☠️ Hades | Recovers a number from the discard pile and gives it to an active player. |
| 🪽 Hermes | Exchanges one number card between two active players. |
| 🏹 Artemis | Discards one number card held by any active player. |
| ❤️ Aphrodite | Reveals one card and binds two active players to its effect. |
| 🔨 Hephaestus | Recovers a modifier from the discard pile—or creates a temporary **+4**. |
| 🌾 Demeter | Adds the value of a player's lowest number to their effective score. |
| 🏆 Nike | Awards an additional **+10** when the player achieves Flip Seven. |
| 🔥 Prometheus | Replays the most recently completed non-Prometheus God effect. |

God effects can:

- Nest within one another
- Affect several players simultaneously
- Create duplicates through routes other than a normal draw

Suddenly, the best decision is no longer purely mathematical.

Players must read the table, negotiate with rivals, bluff confidence, and decide whether an alliance will survive the next card.

---

# Technical Design

Beneath the theatrical surface is a deterministic, event-driven game engine built around a **server-authoritative state model**.

## The Deck

The canonical deck contains **97 physical cards**:

- **79** Number cards
- **6** Modifier cards
- **12** Unique God cards

Every physical card has a unique ID.

Temporary effects created by the gods receive their own instance IDs but never enter the physical deck.

---

## Resolution Model

The game logic is designed around:

- Shared reveal pipeline for:
  - Initial deals
  - Normal draws
  - Forced draws
- Validated commands with revision checks
- Explicit game phases
  - Player choices
  - God choices
  - Resolution
  - Scoring
  - Game completion
- Resolution stack for nested effects
- Atomic multiplayer effects for simultaneous exchanges and duplicate checks
- Ordered events for client animation
- Private state projections (for effects such as Athena)

Animation never decides the rules.

The engine resolves each transition first and then emits events for clients to present.

---

## Handling the Awkward Cases

The specification explicitly covers the multiplayer interactions most likely to break a card game.

- Zeus protects against **exactly one duplicate**, regardless of its source.
- Hermes exchanges cards atomically before checking either player for duplicates.
- Aphrodite can produce two simultaneous Flip Seven achievers.
- Prometheus copies the **last completed God resolution**, not merely the last God card revealed.
- Generated effects are destroyed during cleanup and never enter the physical discard pile.
- Players tied for the lead at or above **200 points** continue into another round.
- Invalid choices and stale commands are rejected by the server.

---

# Visual & Motion Direction

*Favour of Olympus* combines AI-generated artwork with motion created entirely in code.

AI image generation was used to explore and refine:

- Title artwork
- Clash of the gods
- Visual identity
- Individual God-card artwork
- The wider world of Olympus

The project also includes a **React + Remotion** animation inspired by *Hades*.

A hand-inked lightning strike forms at the centre of a carved Greek frame, splits across its lower edge, and erupts into sparks.

Because the animation is programmatic, its timing, colours, composition, and effects can be tuned like any other part of the product.

---

# Built With Codex

Codex supported the project from the first idea to the final presentation—not only as a code-completion tool, but as a creative and technical collaborator.

## Conceptualisation

Codex helped transform a familiar push-your-luck mechanic into an Olympian multiplayer experience built around:

- Token stakes
- Social play
- Divine intervention

## Gameplay Design

Codex helped define:

- The twelve God cards
- Individual God powers
- Scoring system
- Round structure
- Edge cases between interacting divine effects

## Code & Game Logic

Codex helped shape:

- TypeScript domain model
- Server-authoritative game state
- Command validation
- Event contracts
- Nested God-card resolution
- Multiplayer interaction handling
- Scoring rules
- Cleanup rules
- Implementation-ready test plan

## AI Image Generation

Codex was used to direct and iterate on original visual assets for:

- Title artwork
- Card artwork
- Olympian environments

## Motion Development

Codex helped build and refine the React and Remotion lightning animation, turning the visual identity into a code-driven sequence.

## Writing & Presentation

Codex also helped translate the project's mechanics, architecture, visuals, and ambition into the final hackathon showcase.

The process was not one magic prompt.

It was a continuous creative and technical loop:

> **Imagine → Specify → Build → Inspect → Refine**

---

# Project Status

The project currently includes:

- ✅ Complete gameplay specification
- ✅ Detailed logic for all twelve God cards
- ✅ Multiplayer state and event architecture
- ✅ Test scenarios and edge cases
- ✅ AI-generated visual concepts
- ✅ Programmatic motion prototype
- ✅ Hackathon presentation material

### Next Steps

The next stage is to connect the game engine to:

- Multiplayer application
- Persistence layer
- Player-facing interface

---

# Disclaimer

*Favour of Olympus* is an independent hackathon prototype inspired by the mechanics of **Flip 7**.

It is **not affiliated with, sponsored by, or endorsed by** the publisher or rights holders of *Flip 7*.
