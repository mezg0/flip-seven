import { describe, expect, it } from "vitest"
import { calculateRoundScore, findWinner } from "./scoring.js"
import type { PlayerState } from "./model.js"

function player(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: "player",
    name: "Player",
    seat: 0,
    totalScore: 0,
    roundStatus: "active",
    numberCards: [],
    modifierCards: [],
    hasSecondChance: false,
    actionCardsInFront: [],
    lockedRoundScore: null,
    ...overrides,
  }
}

describe("round scoring", () => {
  it("multiplies only the number sum before additive modifiers and the Flip Seven bonus", () => {
    const scoringPlayer = player({
      numberCards: [
        { id: "n1", kind: "number", value: 12 },
        { id: "n2", kind: "number", value: 11 },
        { id: "n3", kind: "number", value: 7 },
        { id: "n4", kind: "number", value: 6 },
      ],
      modifierCards: [
        { id: "m1", kind: "modifier", operation: "multiply", value: 2 },
        { id: "m2", kind: "modifier", operation: "add", value: 10 },
      ],
    })

    expect(calculateRoundScore(scoringPlayer, true)).toBe(97)
  })

  it("always awards zero to a busted player", () => {
    expect(calculateRoundScore(player({
      roundStatus: "busted",
      modifierCards: [{ id: "m", kind: "modifier", operation: "add", value: 10 }],
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
