import { describe, expect, it } from "vitest"
import {
  GameRuleError,
  applyCommand,
  createGame,
  toPublicGameState,
  type Card,
  type GameState,
  type GodKind,
  type ModifierInstance,
  type NumberInstance,
} from "./index.js"

const players = [
  { id: "p0", name: "Zero", seat: 0 },
  { id: "p1", name: "One", seat: 1 },
  { id: "p2", name: "Two", seat: 2 },
]

const numberCard = (id: string, value: number): Card => ({ id, kind: "number", value })
const godCard = (id: string, god: GodKind): Card => ({ id, kind: "god", god })
const modifierCard = (
  id: string,
  operation: "add" | "multiply",
  value: 2 | 4 | 6 | 8 | 10,
): Card => operation === "add"
  ? { id, kind: "modifier", operation, value }
  : { id, kind: "modifier", operation, value: 2 }

const numberInstance = (
  instanceId: string,
  value: number,
  origin: "deck" | "aphrodite" = "deck",
): NumberInstance => ({
  instanceId,
  value,
  physicalCardId: origin === "deck" ? instanceId : null,
  origin,
})

const modifierInstance = (
  instanceId: string,
  operation: "add" | "multiply",
  value: 2 | 4 | 6 | 8 | 10,
): ModifierInstance => ({
  instanceId,
  operation,
  value,
  physicalCardId: instanceId,
  origin: "deck",
})

function gameForTurn(nextCards: Card[]): GameState {
  const state = createGame("test", players, 1, { config: { minimumPlayers: 1 } })
  state.phase = "awaitingTurnChoice"
  state.roundNumber = 1
  state.currentTurnSeat = 0
  state.drawPile = [...nextCards].reverse()
  state.discardPile = []
  return state
}

function hit(state: GameState, actorId = "p0") {
  return applyCommand(state, {
    type: "HIT",
    actorId,
    expectedRevision: state.revision,
  })
}

function choose(state: GameState, selection: unknown) {
  const pending = state.pendingChoice
  if (pending === null) throw new Error("Expected a pending God choice")
  return applyCommand(state, {
    type: "SUBMIT_CHOICE",
    actorId: pending.controllerId,
    choiceId: pending.id,
    selection,
    expectedRevision: state.revision,
  })
}

describe("base flow with God cards", () => {
  it("starts a game with two players", () => {
    const state = createGame("two-player", players.slice(0, 2), 1)
    const result = applyCommand(state, { type: "START_GAME", actorId: "p0" }).nextState

    expect(result.phase).toBe("awaitingTurnChoice")
    expect(result.players).toHaveLength(2)
    expect(result.players.every((player) => player.numberCards.length === 1)).toBe(true)
  })

  it("deals from the dealer and offers the dealer the first active turn", () => {
    const state = createGame("deal", players, 1, { dealerSeat: 1 })
    state.drawPile = [numberCard("seat-0", 3), numberCard("seat-2", 2), numberCard("seat-1", 1)]

    const result = applyCommand(state, { type: "START_GAME", actorId: "p0" })

    expect(result.nextState.players.find((player) => player.id === "p1")?.numberCards[0]?.value).toBe(1)
    expect(result.nextState.players.find((player) => player.id === "p2")?.numberCards[0]?.value).toBe(2)
    expect(result.nextState.players.find((player) => player.id === "p0")?.numberCards[0]?.value).toBe(3)
    expect(result.nextState.currentTurnSeat).toBe(1)
  })

  it("skips God cards during the opening deal and leaves them in the deck", () => {
    const state = createGame("opening-god", players, 1)
    state.drawPile = [
      numberCard("three", 3),
      numberCard("two", 2),
      numberCard("one", 1),
      godCard("opening-zeus", "zeus"),
    ]

    const result = applyCommand(state, { type: "START_GAME", actorId: "p0" }).nextState

    expect(result.players.map((player) => player.numberCards[0]?.value)).toEqual([1, 2, 3])
    expect(result.drawPile.map((card) => card.id)).toEqual(["opening-zeus"])
    expect(result.players.every((player) => player.godCardsInFront.length === 0)).toBe(true)
  })

  it("rejects stale commands and allows a modifier-only stay", () => {
    const state = gameForTurn([numberCard("unused", 1)])
    state.players[0]?.modifierCards.push(modifierInstance("plus-eight", "add", 8))

    expect(() => applyCommand(state, { type: "HIT", actorId: "p0", expectedRevision: 2 }))
      .toThrowError(expect.objectContaining({ code: "STALE_REVISION" }))
    const stayed = applyCommand(state, { type: "STAY", actorId: "p0", expectedRevision: 0 })
    expect(stayed.nextState.players[0]?.lockedRoundScore).toBe(8)
  })

  it("never exposes Athena's private card IDs to another player", () => {
    const state = gameForTurn([
      godCard("athena", "athena"),
      numberCard("one", 1),
      numberCard("two", 2),
      numberCard("three", 3),
    ])
    const pending = hit(state).nextState

    expect(toPublicGameState(pending, "p0").pendingChoice?.physicalCardIds).toEqual(["one", "two", "three"])
    expect(toPublicGameState(pending, "p1").pendingChoice?.physicalCardIds).toEqual([])
  })

  it("pauses on the scored round until the host advances it", () => {
    const state = gameForTurn([numberCard("unused", 1)])
    state.config.targetScore = 1
    state.players[0]?.numberCards.push(numberInstance("five", 5))
    state.players[0]?.modifierCards.push(modifierInstance("plus-four", "add", 4))
    state.players[1]!.roundStatus = "stayed"
    state.players[2]!.roundStatus = "busted"

    const scored = applyCommand(state, {
      type: "STAY",
      actorId: "p0",
      expectedRevision: state.revision,
    })

    expect(scored.nextState.phase).toBe("roundScoring")
    expect(scored.nextState.players[0]?.totalScore).toBe(9)
    expect(scored.nextState.players[0]?.numberCards).toHaveLength(1)
    expect(scored.nextState.winnerId).toBe("p0")
    expect(scored.events).toContainEqual({ type: "ROUND_SCORE_AWARDED", playerId: "p0", score: 9 })
    expect(() => applyCommand(scored.nextState, {
      type: "ADVANCE_ROUND",
      actorId: "p1",
      expectedRevision: scored.nextState.revision,
    })).toThrowError(expect.objectContaining({ code: "COMMAND_NOT_ALLOWED" }))

    const advanced = applyCommand(scored.nextState, {
      type: "ADVANCE_ROUND",
      actorId: "p0",
      expectedRevision: scored.nextState.revision,
    })

    expect(advanced.nextState.phase).toBe("gameOver")
    expect(advanced.nextState.players[0]?.numberCards).toHaveLength(0)
    expect(advanced.events).toContainEqual({ type: "GAME_WON", playerId: "p0", totalScore: 9 })
  })

  it("deals the next round after the host advances scoring", () => {
    const state = gameForTurn([
      numberCard("round-two-p1", 6),
      numberCard("round-two-p0", 4),
    ])
    state.players.splice(2, 1)
    state.players[0]?.numberCards.push(numberInstance("round-one-five", 5))
    state.players[1]!.roundStatus = "stayed"

    const scored = applyCommand(state, {
      type: "STAY",
      actorId: "p0",
      expectedRevision: state.revision,
    }).nextState
    const advanced = applyCommand(scored, {
      type: "ADVANCE_ROUND",
      actorId: "p0",
      expectedRevision: scored.revision,
    }).nextState

    expect(advanced.roundNumber).toBe(2)
    expect(advanced.phase).toBe("awaitingTurnChoice")
    expect(advanced.players.every((player) => player.numberCards.length === 1)).toBe(true)
  })
})

describe("Zeus", () => {
  it("persists, consumes a duplicate, and leaves a later duplicate unprotected", () => {
    const state = gameForTurn([godCard("zeus", "zeus")])
    state.players[0]?.numberCards.push(numberInstance("five", 5))
    let current = hit(state).nextState

    expect(current.players[0]?.godEffects.map((effect) => effect.kind)).toEqual(["zeus"])
    expect(current.players[0]?.godCardsInFront.map((card) => card.id)).toEqual(["zeus"])

    current.phase = "awaitingTurnChoice"
    current.currentTurnSeat = 0
    current.drawPile = [numberCard("duplicate-one", 5)]
    current = hit(current).nextState
    expect(current.players[0]?.roundStatus).toBe("active")
    expect(current.players[0]?.godEffects).toHaveLength(0)
    expect(current.discardPile.map((card) => card.id)).toEqual(expect.arrayContaining(["zeus", "duplicate-one"]))

    current.phase = "awaitingTurnChoice"
    current.currentTurnSeat = 0
    current.drawPile = [numberCard("duplicate-two", 5)]
    current = hit(current).nextState
    expect(current.players[0]?.roundStatus).toBe("busted")
  })

  it("discards a second Zeus without creating another protection", () => {
    const state = gameForTurn([godCard("second-zeus", "zeus")])
    state.players[0]?.godEffects.push({
      effectId: "existing",
      kind: "zeus",
      ownerId: "p0",
      physicalCardId: null,
      grantedBy: "prometheus",
    })
    const result = hit(state).nextState

    expect(result.players[0]?.godEffects).toHaveLength(1)
    expect(result.discardPile.map((card) => card.id)).toContain("second-zeus")
  })
})

describe("Ares and Dionysus", () => {
  it("resolves exactly three sequential Ares draws", () => {
    const state = gameForTurn([
      godCard("ares", "ares"),
      numberCard("one", 1),
      numberCard("two", 2),
      numberCard("three", 3),
    ])
    const requested = hit(state).nextState
    const result = choose(requested, ["p1"]).nextState

    expect(result.players[1]?.numberCards.map((card) => card.value)).toEqual([1, 2, 3])
    expect(result.currentTurnSeat).toBe(1)
  })

  it("resolves nested Ares depth-first before resuming its parent", () => {
    const state = gameForTurn([
      godCard("outer-ares", "ares"),
      godCard("inner-ares", "ares"),
      numberCard("one", 1),
      numberCard("two", 2),
      numberCard("three", 3),
      numberCard("four", 4),
      numberCard("five", 5),
    ])
    const outerTarget = choose(hit(state).nextState, ["p1"]).nextState
    const result = choose(outerTarget, ["p2"]).nextState

    expect(result.players[2]?.numberCards.map((card) => card.value)).toEqual([1, 2, 3])
    expect(result.players[1]?.numberCards.map((card) => card.value)).toEqual([4, 5])
  })

  it("stops Ares when nested Dionysus forces its target to stay", () => {
    const state = gameForTurn([
      godCard("ares", "ares"),
      godCard("dionysus", "dionysus"),
      numberCard("must-remain", 8),
      numberCard("also-remains", 9),
    ])
    const dionysusChoice = choose(hit(state).nextState, ["p1"]).nextState
    const result = choose(dionysusChoice, ["p1"]).nextState

    expect(result.players[1]?.roundStatus).toBe("stayed")
    expect(result.players[1]?.lockedRoundScore).toBe(0)
    expect(result.drawPile.map((card) => card.id)).toEqual(expect.arrayContaining(["must-remain", "also-remains"]))
    expect(result.currentTurnSeat).toBe(2)
  })
})

describe("Athena, Hades, Hermes, and Artemis", () => {
  it("accepts only an exact Athena permutation and puts the first ID on top", () => {
    const state = gameForTurn([
      godCard("athena", "athena"),
      numberCard("one", 1),
      numberCard("two", 2),
      numberCard("three", 3),
    ])
    const pending = hit(state).nextState
    expect(() => choose(pending, ["one", "one", "three"])).toThrowError(
      expect.objectContaining({ code: "INVALID_CHOICE" }),
    )

    const result = choose(pending, ["three", "one", "two"]).nextState
    expect(result.drawPile.at(-1)?.id).toBe("three")
  })

  it("lets Hades move only a discarded physical number to an active target", () => {
    const state = gameForTurn([godCard("hades", "hades")])
    state.discardPile.push(numberCard("discarded-seven", 7))
    const pending = hit(state).nextState
    const result = choose(pending, { physicalCardId: "discarded-seven", targetId: "p1" }).nextState

    expect(result.players[1]?.numberCards[0]).toMatchObject({ value: 7, physicalCardId: "discarded-seven" })
    expect(result.discardPile.map((card) => card.id)).not.toContain("discarded-seven")
  })

  it("exchanges Hermes numbers atomically", () => {
    const state = gameForTurn([godCard("hermes", "hermes")])
    state.players[0]?.numberCards.push(numberInstance("left", 2))
    state.players[1]?.numberCards.push(numberInstance("right", 9))
    const pending = hit(state).nextState
    const result = choose(pending, {
      left: { playerId: "p0", instanceId: "left" },
      right: { playerId: "p1", instanceId: "right" },
    }).nextState

    expect(result.players[0]?.numberCards.map((card) => card.value)).toEqual([9])
    expect(result.players[1]?.numberCards.map((card) => card.value)).toEqual([2])
  })

  it("destroys an Aphrodite-generated number removed by Artemis", () => {
    const state = gameForTurn([godCard("artemis", "artemis")])
    state.players[1]?.numberCards.push(numberInstance("generated", 4, "aphrodite"))
    const pending = hit(state).nextState
    const result = choose(pending, { playerId: "p1", instanceId: "generated" }).nextState

    expect(result.players[1]?.numberCards).toHaveLength(0)
    expect(result.discardPile.map((card) => card.id)).not.toContain("generated")
  })
})

describe("Aphrodite", () => {
  it("creates two generated number instances and discards the physical reveal", () => {
    const state = gameForTurn([
      godCard("aphrodite", "aphrodite"),
      numberCard("physical-seven", 7),
    ])
    const result = choose(hit(state).nextState, ["p1", "p2"]).nextState

    expect(result.players[1]?.numberCards[0]).toMatchObject({ value: 7, origin: "aphrodite", physicalCardId: null })
    expect(result.players[2]?.numberCards[0]).toMatchObject({ value: 7, origin: "aphrodite", physicalCardId: null })
    expect(result.discardPile.map((card) => card.id)).toEqual(expect.arrayContaining(["physical-seven", "aphrodite"]))
  })

  it("finishes both targets atomically and records simultaneous Flip 7", () => {
    const state = gameForTurn([
      godCard("aphrodite", "aphrodite"),
      numberCard("physical-seven", 7),
    ])
    state.config.targetScore = 1
    state.players[1]!.totalScore = 1
    for (const player of [state.players[1], state.players[2]]) {
      player?.numberCards.push(...[1, 2, 3, 4, 5, 6].map((value) => numberInstance(`${player.id}-${value}`, value)))
    }
    const result = choose(hit(state).nextState, ["p1", "p2"])

    expect(result.events.filter((event) => event.type === "FLIP_SEVEN_ACHIEVED")).toHaveLength(2)
    expect(result.nextState.winnerId).toBe("p1")
    expect(result.nextState.players[1]?.totalScore).toBe(44)
    expect(result.nextState.players[2]?.totalScore).toBe(43)
  })

  it("uses an effect token when Aphrodite reveals a persistent God", () => {
    const state = gameForTurn([
      godCard("aphrodite", "aphrodite"),
      godCard("revealed-zeus", "zeus"),
    ])
    const result = choose(hit(state).nextState, ["p1", "p2"]).nextState

    expect(result.players[0]?.godEffects[0]).toMatchObject({ kind: "zeus", physicalCardId: null })
    expect(result.discardPile.map((card) => card.id)).toEqual(expect.arrayContaining(["revealed-zeus", "aphrodite"]))
  })
})

describe("Hephaestus, Demeter, Nike, and Prometheus", () => {
  it("gives Hephaestus's controller a generated +4 when no modifier is discarded", () => {
    const result = hit(gameForTurn([godCard("hephaestus", "hephaestus")])).nextState
    expect(result.players[0]?.modifierCards[0]).toMatchObject({
      operation: "add",
      value: 4,
      origin: "hephaestusFallback",
      physicalCardId: null,
    })
  })

  it("requires Hephaestus to forge an available physical modifier", () => {
    const state = gameForTurn([godCard("hephaestus", "hephaestus")])
    state.discardPile.push(modifierCard("plus-ten", "add", 10))
    const result = choose(hit(state).nextState, { physicalCardId: "plus-ten", targetId: "p1" }).nextState

    expect(result.players[1]?.modifierCards[0]).toMatchObject({ value: 10, physicalCardId: "plus-ten" })
    expect(result.discardPile.map((card) => card.id)).not.toContain("plus-ten")
  })

  it("retains direct Demeter on its target and doubles its bonus under x2", () => {
    const state = gameForTurn([godCard("demeter", "demeter")])
    state.players[1]?.numberCards.push(numberInstance("two", 2), numberInstance("five", 5))
    state.players[1]?.modifierCards.push(modifierInstance("x2", "multiply", 2))
    const result = choose(hit(state).nextState, ["p1"]).nextState

    expect(result.players[1]?.godEffects[0]).toMatchObject({ kind: "demeter", physicalCardId: "demeter" })
    expect(result.players[1]?.godCardsInFront.map((card) => card.id)).toContain("demeter")
  })

  it("adds Nike after the normal Flip 7 bonus and never doubles it", () => {
    const state = gameForTurn([numberCard("seven", 7)])
    state.config.targetScore = 1
    state.players[0]?.numberCards.push(...[1, 2, 3, 4, 5, 6].map((value) => numberInstance(`n${value}`, value)))
    state.players[0]?.modifierCards.push(modifierInstance("x2", "multiply", 2))
    state.players[0]?.godEffects.push({
      effectId: "nike",
      kind: "nike",
      ownerId: "p0",
      physicalCardId: null,
      grantedBy: "prometheus",
    })
    const result = hit(state).nextState

    expect(result.players[0]?.totalScore).toBe(81)
  })

  it("copies only the most recently completed non-Prometheus God", () => {
    const state = gameForTurn([godCard("prometheus", "prometheus")])
    state.godResolutionHistory.push({
      god: "dionysus",
      controllerId: "p2",
      copiedGod: null,
      completedAtSequence: 1,
    })
    const pending = hit(state).nextState
    expect(pending.pendingChoice).toMatchObject({ god: "dionysus", controllerId: "p0" })
    const result = choose(pending, ["p1"]).nextState

    expect(result.players[1]?.roundStatus).toBe("stayed")
    expect(result.godResolutionHistory.at(-1)).toMatchObject({ god: "prometheus", copiedGod: "dionysus" })
    expect(result.godResolutionHistory.filter((record) => record.god === "dionysus")).toHaveLength(1)
  })

  it("resolves Prometheus with no effect when no God completed earlier", () => {
    const result = hit(gameForTurn([godCard("prometheus", "prometheus")])).nextState
    expect(result.pendingChoice).toBeNull()
    expect(result.godResolutionHistory.at(-1)).toMatchObject({ god: "prometheus", copiedGod: null })
  })
})

it("uses typed errors for invalid choice controllers", () => {
  const pending = hit(gameForTurn([godCard("ares", "ares")])).nextState
  expect(() => applyCommand(pending, {
    type: "SUBMIT_CHOICE",
    actorId: "p1",
    choiceId: pending.pendingChoice?.id ?? "",
    selection: ["p1"],
    expectedRevision: pending.revision,
  })).toThrow(GameRuleError)
})
