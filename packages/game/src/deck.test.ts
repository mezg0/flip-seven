import { describe, expect, it } from "vitest"
import { GOD_KINDS } from "./model.js"
import { createDeck, createUnshuffledDeck } from "./deck.js"

describe("Greek-god variant deck", () => {
  it("contains 97 uniquely identified physical cards", () => {
    const deck = createUnshuffledDeck("test")

    expect(deck).toHaveLength(97)
    expect(new Set(deck.map((card) => card.id))).toHaveLength(97)
    expect(deck.filter((card) => card.kind === "number")).toHaveLength(79)
    expect(deck.filter((card) => card.kind === "modifier")).toHaveLength(6)
    expect(deck.filter((card) => card.kind === "god")).toHaveLength(12)
    for (const god of GOD_KINDS) {
      expect(deck.filter((card) => card.kind === "god" && card.god === god)).toHaveLength(1)
    }
  })

  it("shuffles deterministically from a seed", () => {
    const first = createDeck("repeatable", "game")
    const second = createDeck("repeatable", "game")
    const different = createDeck("different", "game")

    expect(first).toEqual(second)
    expect(first.cards.map((card) => card.id)).not.toEqual(different.cards.map((card) => card.id))
  })
})
