import { GameCreateRequest } from "@favour-of-olympus/protocol"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { GameRegistry, RegistryError } from "./game-registry.js"

function makeRegistry(): Effect.Effect<GameRegistry> {
  let nextToken = 0
  return GameRegistry.make(() => "server-owned-seed", () => `token-${nextToken++}`)
}

describe("GameRegistry", () => {
  it("creates a one-player lobby with a creator credential", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    const created = await Effect.runPromise(registry.create("room", "zero", "Zero"))

    expect(created.snapshot.state.players).toMatchObject([{ id: "zero", name: "Zero", seat: 0 }])
    expect(created.credential).toMatchObject({ playerId: "zero" })
    expect(created.invitations).toEqual([])
  })

  it("adds lobby players in server-assigned seats and issues credentials", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    const created = await Effect.runPromise(registry.create("room", "zero", "Zero"))
    const joined = await Effect.runPromise(registry.join("room", "one", "One"))

    expect(joined.snapshot.state.players).toMatchObject([
      { id: "zero", seat: 0 },
      { id: "one", seat: 1 },
    ])
    await expect(Effect.runPromise(registry.get("room", joined.credential.accessToken))).resolves.toBeDefined()
    await expect(Effect.runPromise(registry.get("room", created.credential.accessToken))).resolves.toBeDefined()
  })

  it("rejects duplicate, unknown, and unauthenticated access", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    await Effect.runPromise(registry.create("room", "zero", "Zero"))

    const duplicateError = await Effect.runPromise(Effect.flip(registry.create("room", "zero", "Zero")))
    const missingError = await Effect.runPromise(Effect.flip(registry.get("missing", "token")))
    const unauthorizedError = await Effect.runPromise(Effect.flip(registry.get("room", "wrong-token")))

    expect(duplicateError).toMatchObject({ code: "GAME_ALREADY_EXISTS" })
    expect(missingError).toBeInstanceOf(RegistryError)
    expect(unauthorizedError).toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("prevents a username joining the lobby twice", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    await Effect.runPromise(registry.create("room", "zero", "Zero"))
    await Effect.runPromise(registry.join("room", "one", "One"))

    const error = await Effect.runPromise(Effect.flip(registry.join("room", "one", "One")))
    expect(error).toMatchObject({ code: "PLAYER_ALREADY_JOINED" })
  })

  it("limits each lobby to four players", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    await Effect.runPromise(registry.create("room", "zero", "Zero"))
    await Effect.runPromise(registry.join("room", "one", "One"))
    await Effect.runPromise(registry.join("room", "two", "Two"))
    await Effect.runPromise(registry.join("room", "three", "Three"))

    const error = await Effect.runPromise(Effect.flip(registry.join("room", "four", "Four")))
    expect(error).toMatchObject({ code: "LOBBY_FULL" })
  })

  it("does not accept players once the game begins", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    const created = await Effect.runPromise(registry.create("room", "zero", "Zero"))
    await Effect.runPromise(registry.join("room", "one", "One"))
    await Effect.runPromise(registry.join("room", "two", "Two"))
    await Effect.runPromise(registry.submit("room", created.credential.accessToken, { type: "START_GAME", actorId: "zero" }))

    const error = await Effect.runPromise(Effect.flip(registry.join("room", "three", "Three")))
    expect(error).toMatchObject({ code: "LOBBY_CLOSED" })
  })

  it("lets only the host permanently end a game", async () => {
    const registry = await Effect.runPromise(makeRegistry())
    const created = await Effect.runPromise(registry.create("room", "zero", "Zero"))
    const joined = await Effect.runPromise(registry.join("room", "one", "One"))

    const unauthorized = await Effect.runPromise(Effect.flip(registry.end("room", joined.credential.accessToken)))
    expect(unauthorized).toMatchObject({ code: "UNAUTHORIZED" })
    await Effect.runPromise(registry.end("room", created.credential.accessToken))
    const missing = await Effect.runPromise(Effect.flip(registry.get("room", created.credential.accessToken)))
    expect(missing).toMatchObject({ code: "GAME_NOT_FOUND" })
  })
})

describe("game creation protocol", () => {
  it("rejects oversized identifiers and usernames", async () => {
    const result = await Effect.runPromiseExit(Schema.decodeUnknown(GameCreateRequest)({
      gameId: "g".repeat(129),
      creatorId: "p0",
      creatorName: "n".repeat(65),
    }))

    expect(result._tag).toBe("Failure")
  })
})
