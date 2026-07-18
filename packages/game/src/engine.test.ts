import { describe, expect, it } from "vitest"
import {
  GameRuleError,
  applyCommand,
  createGame,
  toPublicGameState,
  type Card,
  type GameState,
} from "./index.js"

const players = [
  { id: "p0", name: "Zero", seat: 0 },
  { id: "p1", name: "One", seat: 1 },
  { id: "p2", name: "Two", seat: 2 },
]

function gameForTurn(nextCards: Card[]): GameState {
  const state = createGame("test", players, 1, { config: { minimumPlayers: 1 } })
  state.phase = "awaitingTurnChoice"
  state.roundNumber = 1
  state.currentTurnSeat = 0
  state.drawPile = [...nextCards].reverse()
  state.discardPile = []
  return state
}

function number(id: string, value: number): Card {
  return { id, kind: "number", value }
}

describe("turns and initial deal", () => {
  it("deals from the dealer and offers the dealer the first active turn", () => {
    const state = createGame("deal", players, 1, { dealerSeat: 1 })
    state.drawPile = [number("seat-0", 3), number("seat-2", 2), number("seat-1", 1)]

    const result = applyCommand(state, { type: "START_GAME", actorId: "p0" })

    expect(result.nextState.players.find((player) => player.id === "p1")?.numberCards[0]?.value).toBe(1)
    expect(result.nextState.players.find((player) => player.id === "p2")?.numberCards[0]?.value).toBe(2)
    expect(result.nextState.players.find((player) => player.id === "p0")?.numberCards[0]?.value).toBe(3)
    expect(result.nextState.currentTurnSeat).toBe(1)
    expect(result.nextState.phase).toBe("awaitingTurnChoice")
  })

  it("rejects stale commands and a stay with no cards", () => {
    const state = gameForTurn([number("draw", 4)])
    state.revision = 2

    expect(() => applyCommand(state, { type: "HIT", actorId: "p0", expectedRevision: 1 }))
      .toThrowError(expect.objectContaining({ code: "STALE_REVISION" }))
    expect(() => applyCommand(state, { type: "STAY", actorId: "p0", expectedRevision: 2 }))
      .toThrowError(expect.objectContaining({ code: "CANNOT_STAY_WITHOUT_CARDS" }))
  })

  it("allows a modifier-only player to stay and locks that score", () => {
    const state = gameForTurn([number("unused", 1)])
    state.players[0]?.modifierCards.push({ id: "plus-eight", kind: "modifier", operation: "add", value: 8 })

    const result = applyCommand(state, { type: "STAY", actorId: "p0", expectedRevision: 0 })

    expect(result.nextState.players[0]?.roundStatus).toBe("stayed")
    expect(result.nextState.players[0]?.lockedRoundScore).toBe(8)
    expect(result.nextState.currentTurnSeat).toBe(1)
  })
})

describe("numbers and Second Chance", () => {
  it("busts on a duplicate number, including zero", () => {
    const state = gameForTurn([number("duplicate-zero", 0)])
    state.players[0]?.numberCards.push({ id: "original-zero", kind: "number", value: 0 })

    const result = applyCommand(state, { type: "HIT", actorId: "p0", expectedRevision: 0 })

    expect(result.nextState.players[0]?.roundStatus).toBe("busted")
    expect(result.nextState.players[0]?.lockedRoundScore).toBe(0)
    expect(result.nextState.currentTurnSeat).toBe(1)
  })

  it("automatically spends Second Chance without drawing an extra card", () => {
    const state = gameForTurn([number("duplicate", 5), number("later", 9)])
    const first = state.players[0]
    if (first === undefined) throw new Error("missing fixture player")
    first.numberCards.push({ id: "original", kind: "number", value: 5 })
    first.actionCardsInFront.push({ id: "chance", kind: "action", action: "secondChance" })
    first.hasSecondChance = true

    const result = applyCommand(state, { type: "HIT", actorId: "p0", expectedRevision: 0 })

    expect(result.nextState.players[0]?.numberCards).toHaveLength(1)
    expect(result.nextState.players[0]?.hasSecondChance).toBe(false)
    expect(result.nextState.discardPile.map((card) => card.id)).toEqual(["chance", "duplicate"])
    expect(result.nextState.drawPile.map((card) => card.id)).toContain("later")
    expect(result.nextState.currentTurnSeat).toBe(1)
  })

  it("requires a second Second Chance to transfer to an eligible active player", () => {
    const state = gameForTurn([{ id: "chance-two", kind: "action", action: "secondChance" }])
    const first = state.players[0]
    if (first === undefined) throw new Error("missing fixture player")
    first.actionCardsInFront.push({ id: "chance-one", kind: "action", action: "secondChance" })
    first.hasSecondChance = true

    const hit = applyCommand(state, { type: "HIT", actorId: "p0", expectedRevision: 0 })
    expect(hit.nextState.pendingAction?.action).toBe("secondChanceTransfer")
    expect(hit.nextState.phase).toBe("awaitingActionTarget")

    const transferred = applyCommand(hit.nextState, {
      type: "SELECT_ACTION_TARGET",
      actorId: "p0",
      targetId: "p1",
      expectedRevision: 1,
    })
    expect(transferred.nextState.players[1]?.hasSecondChance).toBe(true)
    expect(transferred.nextState.players[1]?.actionCardsInFront.map((card) => card.id)).toContain("chance-two")
  })
})

describe("action resolution", () => {
  it("lets the dealt player choose Freeze's target, including themself", () => {
    const state = gameForTurn([{ id: "freeze", kind: "action", action: "freeze" }])
    state.players[0]?.numberCards.push({ id: "seven", kind: "number", value: 7 })

    const hit = applyCommand(state, { type: "HIT", actorId: "p0", expectedRevision: 0 })
    expect(hit.nextState.pendingAction?.chooserId).toBe("p0")

    const frozen = applyCommand(hit.nextState, {
      type: "SELECT_ACTION_TARGET",
      actorId: "p0",
      targetId: "p0",
      expectedRevision: 1,
    })
    expect(frozen.nextState.players[0]?.roundStatus).toBe("frozen")
    expect(frozen.nextState.players[0]?.lockedRoundScore).toBe(7)
    expect(frozen.nextState.players[0]?.hasSecondChance).toBe(false)
    expect(frozen.nextState.currentTurnSeat).toBe(1)
  })

  it("finishes Flip Three forced draws before requesting queued action targets", () => {
    const state = gameForTurn([
      { id: "flip", kind: "action", action: "flipThree" },
      { id: "queued-freeze", kind: "action", action: "freeze" },
      { id: "plus-six", kind: "modifier", operation: "add", value: 6 },
      number("nine", 9),
    ])

    const hit = applyCommand(state, { type: "HIT", actorId: "p0", expectedRevision: 0 })
    const selected = applyCommand(hit.nextState, {
      type: "SELECT_ACTION_TARGET",
      actorId: "p0",
      targetId: "p1",
      expectedRevision: 1,
    })

    expect(selected.nextState.players[1]?.numberCards.map((card) => card.value)).toEqual([9])
    expect(selected.nextState.players[1]?.modifierCards.map((card) => card.value)).toEqual([6])
    expect(selected.nextState.pendingAction).toMatchObject({ action: "freeze", chooserId: "p1" })
  })

  it("allows Second Chance within Flip Three to protect a later forced duplicate", () => {
    const state = gameForTurn([
      { id: "flip", kind: "action", action: "flipThree" },
      { id: "chance", kind: "action", action: "secondChance" },
      number("duplicate-five", 5),
      number("six", 6),
    ])
    state.players[1]?.numberCards.push({ id: "original-five", kind: "number", value: 5 })

    const hit = applyCommand(state, { type: "HIT", actorId: "p0", expectedRevision: 0 })
    const selected = applyCommand(hit.nextState, {
      type: "SELECT_ACTION_TARGET",
      actorId: "p0",
      targetId: "p1",
      expectedRevision: 1,
    })

    expect(selected.nextState.players[1]?.roundStatus).toBe("active")
    expect(selected.nextState.players[1]?.numberCards.map((card) => card.value)).toEqual([5, 6])
    expect(selected.nextState.discardPile.map((card) => card.id)).toEqual(["chance", "duplicate-five"])
    expect(selected.nextState.currentTurnSeat).toBe(1)
  })

  it("interrupts immediately on seven unique numbers and awards the bonus", () => {
    const state = gameForTurn([
      number("seven", 7),
      number("next-round-p0", 8),
      number("next-round-p1", 9),
      number("next-round-p2", 10),
    ])
    state.config.targetScore = 1
    const first = state.players[0]
    if (first === undefined) throw new Error("missing fixture player")
    first.numberCards.push(...[1, 2, 3, 4, 5, 6].map((value) => number(`n-${value}`, value) as Extract<Card, { kind: "number" }>))

    const result = applyCommand(state, { type: "HIT", actorId: "p0", expectedRevision: 0 })

    expect(result.events.map((event) => event.type)).toContain("FLIP_SEVEN_ACHIEVED")
    expect(result.nextState.players[0]?.totalScore).toBe(43)
    expect(result.nextState.winnerId).toBe("p0")
    expect(result.nextState.phase).toBe("gameOver")
    expect(result.nextState.players.every((player) =>
      player.numberCards.length === 0
        && player.modifierCards.length === 0
        && player.actionCardsInFront.length === 0
    )).toBe(true)
    expect(result.nextState.discardPile).toHaveLength(7)
  })
})

describe("public snapshots", () => {
  it("exposes only a remaining-card count, never the draw order", () => {
    const state = gameForTurn([number("secret", 12)])
    const snapshot = toPublicGameState(state)

    expect(snapshot.remainingCardCount).toBe(1)
    expect(snapshot).not.toHaveProperty("drawPile")
  })
})

it("uses typed game errors", () => {
  const state = gameForTurn([number("one", 1)])
  expect(() => applyCommand(state, { type: "HIT", actorId: "unknown", expectedRevision: 0 })).toThrow(GameRuleError)
})
