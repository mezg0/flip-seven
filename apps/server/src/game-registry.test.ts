import { defaultGameConfig } from "@flip-seven/game"
import { GameCreateRequest } from "@flip-seven/protocol"
import type { CreatedGame } from "./game-registry.js"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { GameRegistry, RegistryError } from "./game-registry.js"

const players = [
  { id: "p0", name: "Zero", seat: 0 },
  { id: "p1", name: "One", seat: 1 },
  { id: "p2", name: "Two", seat: 2 },
]

function makeRegistry(): Effect.Effect<GameRegistry> {
  let nextToken = 0
  return GameRegistry.make(() => "server-owned-seed", () => `token-${nextToken++}`)
}

describe("GameRegistry", () => {
  it("returns only the creator credential and one-time invitations", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    const created = await Effect.runPromise(registry.create("room", "p0", players))

    expect(created.snapshot.state).not.toHaveProperty("drawPile")
    expect(created.snapshot.state.remainingCardCount).toBe(94)
    expect(created.credential).toMatchObject({ playerId: "p0" })
    expect(created.invitations.map((invitation) => invitation.playerId)).toEqual(["p1", "p2"])

    const started = await Effect.runPromise(registry.submit(
      "room",
      created.credential.accessToken,
      { type: "START_GAME", actorId: "p0" },
    ))
    expect(started.state.revision).toBe(1)
    expect(started.events[0]?.type).toBe("ROUND_STARTED")
    expect((await Effect.runPromise(registry.get("room", created.credential.accessToken))).state)
      .toEqual(started.state)
  })

  it("consumes an invitation and issues a fresh player credential", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    const created = await Effect.runPromise(registry.create("room", "p0", players))
    const invitation = invitationFor(created, "p1")

    const claimed = await Effect.runPromise(registry.claim(
      "room",
      invitation.playerId,
      invitation.invitationToken,
    ))
    const reusedError = await Effect.runPromise(Effect.flip(registry.claim(
      "room",
      invitation.playerId,
      invitation.invitationToken,
    )))

    expect(claimed.credential.playerId).toBe("p1")
    expect(claimed.credential.accessToken).not.toBe(invitation.invitationToken)
    expect(reusedError).toMatchObject({ code: "UNAUTHORIZED" })
    await expect(Effect.runPromise(registry.get("room", claimed.credential.accessToken))).resolves.toBeDefined()
  })

  it("rejects duplicate, unknown, and unauthenticated access", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    const created = await Effect.runPromise(registry.create("room", "p0", players))

    const duplicateError = await Effect.runPromise(Effect.flip(registry.create("room", "p0", players)))
    const missingError = await Effect.runPromise(Effect.flip(registry.get("missing", "token")))
    const unauthorizedError = await Effect.runPromise(Effect.flip(registry.get("room", "wrong-token")))

    expect(duplicateError).toMatchObject({ code: "GAME_ALREADY_EXISTS" })
    expect(missingError).toBeInstanceOf(RegistryError)
    expect(unauthorizedError).toMatchObject({ code: "UNAUTHORIZED" })
    expect(created.invitations).toHaveLength(2)
  })

  it("prevents one player's credential from issuing another player's command", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    const created = await Effect.runPromise(registry.create("room", "p0", players))
    const p1 = await claimPlayer(registry, created, "p1")

    const error = await Effect.runPromise(Effect.flip(registry.submit(
      "room",
      p1.accessToken,
      { type: "START_GAME", actorId: "p0" },
    )))

    expect(error).toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("serializes concurrent commands so only one matching revision is accepted", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    const created = await Effect.runPromise(registry.create("room", "p0", players))
    const credentials = new Map([
      [created.credential.playerId, created.credential.accessToken],
      ["p1", (await claimPlayer(registry, created, "p1")).accessToken],
      ["p2", (await claimPlayer(registry, created, "p2")).accessToken],
    ])
    const started = await Effect.runPromise(registry.submit(
      "room",
      created.credential.accessToken,
      { type: "START_GAME", actorId: "p0" },
    ))
    const actor = started.state.players.find((player) => player.seat === started.state.currentTurnSeat)
    if (actor === undefined) throw new Error("Expected a current player")
    const actorToken = credentials.get(actor.id)
    if (actorToken === undefined) throw new Error(`Missing credential for ${actor.id}`)

    const command = {
      type: "HIT" as const,
      actorId: actor.id,
      expectedRevision: started.state.revision,
    }
    const results = await Promise.allSettled([
      Effect.runPromise(registry.submit("room", actorToken, command)),
      Effect.runPromise(registry.submit("room", actorToken, command)),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  })
})

describe("game creation protocol", () => {
  it("rejects lobbies outside the configured player bounds", async () => {
    const tooFew = await Effect.runPromiseExit(Schema.decodeUnknown(GameCreateRequest)({
      gameId: "room",
      creatorId: "p0",
      players: players.slice(0, 2),
    }))
    const tooMany = await Effect.runPromiseExit(Schema.decodeUnknown(GameCreateRequest)({
      gameId: "room",
      creatorId: "p0",
      players: Array.from({ length: defaultGameConfig.maximumPlayers + 1 }, (_, seat) => ({
        id: `p${seat}`,
        name: `Player ${seat}`,
        seat,
      })),
    }))

    expect(tooFew._tag).toBe("Failure")
    expect(tooMany._tag).toBe("Failure")
  })

  it("rejects oversized identifiers and player names", async () => {
    const result = await Effect.runPromiseExit(Schema.decodeUnknown(GameCreateRequest)({
      gameId: "g".repeat(129),
      creatorId: "p0",
      players: players.map((player) => ({ ...player, name: "n".repeat(65) })),
    }))

    expect(result._tag).toBe("Failure")
  })
})

function invitationFor(created: CreatedGame, playerId: string) {
  const invitation = created.invitations.find((candidate) => candidate.playerId === playerId)
  if (invitation === undefined) throw new Error(`Missing invitation for ${playerId}`)
  return invitation
}

async function claimPlayer(registry: GameRegistry, created: CreatedGame, playerId: string) {
  const invitation = invitationFor(created, playerId)
  return (await Effect.runPromise(registry.claim(
    created.snapshot.state.id,
    playerId,
    invitation.invitationToken,
  ))).credential
}
