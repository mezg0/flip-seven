import type { ActionCard, Card, ModifierCard, NumberCard } from "./model.js"

export interface ShuffledCards {
  readonly cards: Card[]
  readonly randomState: number
}

export function seedToState(seed: number | string): number {
  if (typeof seed === "number") {
    return seed >>> 0
  }

  let hash = 2_166_136_261
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

export function nextRandom(randomState: number): { readonly value: number; readonly randomState: number } {
  const nextState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0
  return { value: nextState / 4_294_967_296, randomState: nextState }
}

export function shuffleCards(cards: readonly Card[], initialRandomState: number): ShuffledCards {
  const shuffled = [...cards]
  let randomState = initialRandomState

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const next = nextRandom(randomState)
    randomState = next.randomState
    const swapIndex = Math.floor(next.value * (index + 1))
    const current = shuffled[index]
    const replacement = shuffled[swapIndex]
    if (current === undefined || replacement === undefined) {
      continue
    }
    shuffled[index] = replacement
    shuffled[swapIndex] = current
  }

  return { cards: shuffled, randomState }
}

export function createUnshuffledDeck(idPrefix = "card"): Card[] {
  let nextId = 0
  const id = (): string => `${idPrefix}-${nextId++}`
  const cards: Card[] = []

  for (let copy = 0; copy < 1; copy += 1) {
    cards.push({ id: id(), kind: "number", value: 0 } satisfies NumberCard)
  }

  for (let value = 1; value <= 12; value += 1) {
    for (let copy = 0; copy < value; copy += 1) {
      cards.push({ id: id(), kind: "number", value } satisfies NumberCard)
    }
  }

  for (const action of ["freeze", "flipThree", "secondChance"] as const) {
    for (let copy = 0; copy < 3; copy += 1) {
      cards.push({ id: id(), kind: "action", action } satisfies ActionCard)
    }
  }

  for (const value of [2, 4, 6, 8, 10] as const) {
    cards.push({ id: id(), kind: "modifier", operation: "add", value } satisfies ModifierCard)
  }
  cards.push({ id: id(), kind: "modifier", operation: "multiply", value: 2 } satisfies ModifierCard)

  return cards
}

export function createDeck(seed: number | string, idPrefix = "card"): ShuffledCards {
  return shuffleCards(createUnshuffledDeck(idPrefix), seedToState(seed))
}
