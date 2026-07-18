import { describe, expect, it } from "vitest"
import { calculateRoundScore, findWinner } from "./scoring.js"
import type { ModifierInstance, NumberInstance, PlayerState } from "./model.js"

const number = (instanceId: string, value: number): NumberInstance => ({
  instanceId,
  value,
  physicalCardId: instanceId,
  origin: "deck",
})

const modifier = (
  instanceId: string,
  operation: "add" | "multiply",
  value: 2 | 4 | 6 | 8 | 10,
): ModifierInstance => ({ instanceId, operation, value, physicalCardId: instanceId, origin: "deck" })

function player(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: "player",
    name: "Player",
    seat: 0,
    totalScore: 0,
    roundStatus: "active",
    numberCards: [],
    modifierCards: [],
    godEffects: [],
    godCardsInFront: [],
    lockedRoundScore: null,
    ...overrides,
  }
}

describe("god-variant round scoring", () => {
  it("doubles the Demeter-adjusted number total before modifiers and bonuses", () => {
    const scoringPlayer = player({
      numberCards: [number("n2", 2), number("n5", 5), number("n8", 8)],
      modifierCards: [modifier("x2", "multiply", 2), modifier("plus4", "add", 4)],
      godEffects: [
        { effectId: "demeter", kind: "demeter", ownerId: "player", physicalCardId: null, grantedBy: "prometheus" },
        { effectId: "nike", kind: "nike", ownerId: "player", physicalCardId: null, grantedBy: "prometheus" },
      ],
    })

    expect(calculateRoundScore(scoringPlayer, false)).toBe(38)
    expect(calculateRoundScore(scoringPlayer, true)).toBe(63)
  })

  it("stacks Demeter and Nike additively while x2 remains idempotent", () => {
    const scoringPlayer = player({
      numberCards: [number("n3", 3), number("n9", 9)],
      modifierCards: [modifier("x2-a", "multiply", 2), modifier("x2-b", "multiply", 2)],
      godEffects: [
        { effectId: "d1", kind: "demeter", ownerId: "player", physicalCardId: null, grantedBy: "demeter" },
        { effectId: "d2", kind: "demeter", ownerId: "player", physicalCardId: null, grantedBy: "prometheus" },
        { effectId: "n1", kind: "nike", ownerId: "player", physicalCardId: null, grantedBy: "nike" },
        { effectId: "n2", kind: "nike", ownerId: "player", physicalCardId: null, grantedBy: "prometheus" },
      ],
    })

    expect(calculateRoundScore(scoringPlayer, true)).toBe(71)
  })

  it("always awards zero to a busted player", () => {
    expect(calculateRoundScore(player({
      roundStatus: "busted",
      modifierCards: [modifier("plus10", "add", 10)],
    }), true)).toBe(0)
  })
})

describe("winner selection", () => {
  it("requires a unique highest score at or above the target", () => {
    expect(findWinner([player({ id: "a", totalScore: 201 }), player({ id: "b", totalScore: 200 })])?.id).toBe("a")
    expect(findWinner([player({ id: "a", totalScore: 200 }), player({ id: "b", totalScore: 200 })])).toBeNull()
    expect(findWinner([player({ id: "a", totalScore: 199 }), player({ id: "b", totalScore: 120 })])).toBeNull()
  })
})
