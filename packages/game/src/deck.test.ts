import { describe, expect, it } from "vitest"
import { createDeck, createUnshuffledDeck } from "./deck.js"

describe("Flip Seven deck", () => {
  it("contains all 94 uniquely identified cards in the required distribution", () => {
    const deck = createUnshuffledDeck("test")

    expect(deck).toHaveLength(94)
    expect(new Set(deck.map((card) => card.id))).toHaveLength(94)
    for (let value = 0; value <= 12; value += 1) {
      const expected = value === 0 ? 1 : value
      expect(deck.filter((card) => card.kind === "number" && card.value === value)).toHaveLength(expected)
    }
    for (const action of ["freeze", "flipThree", "secondChance"] as const) {
      expect(deck.filter((card) => card.kind === "action" && card.action === action)).toHaveLength(3)
    }
    expect(deck.filter((card) => card.kind === "modifier")).toHaveLength(6)
  })

  it("shuffles deterministically from a seed", () => {
    const first = createDeck("repeatable", "game")
    const second = createDeck("repeatable", "game")
    const different = createDeck("different", "game")

    expect(first).toEqual(second)
    expect(first.cards.map((card) => card.id)).not.toEqual(different.cards.map((card) => card.id))
  })
})
