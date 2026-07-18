import type { PlayerState } from "./model.js"

export function demeterBonus(player: PlayerState): number {
  if (player.numberCards.length === 0) return 0
  const lowest = Math.min(...player.numberCards.map((card) => card.value))
  const blessings = player.godEffects.filter((effect) => effect.kind === "demeter").length
  return lowest * blessings
}

export function calculateRoundScore(player: PlayerState, achievedFlipSeven: boolean): number {
  if (player.roundStatus === "busted") return 0

  const baseNumbers = player.numberCards.reduce((sum, card) => sum + card.value, 0)
  const effectiveNumbers = baseNumbers + demeterBonus(player)
  const hasMultiplier = player.modifierCards.some((card) => card.operation === "multiply")
  const additiveTotal = player.modifierCards.reduce(
    (sum, card) => sum + (card.operation === "add" ? card.value : 0),
    0,
  )
  const nikeBonus = achievedFlipSeven
    ? player.godEffects.filter((effect) => effect.kind === "nike").length * 10
    : 0

  return effectiveNumbers * (hasMultiplier ? 2 : 1)
    + additiveTotal
    + (achievedFlipSeven ? 15 : 0)
    + nikeBonus
}

export function findWinner(players: readonly PlayerState[], targetScore = 200): PlayerState | null {
  const highScore = Math.max(...players.map((player) => player.totalScore))
  if (highScore < targetScore) return null
  const leaders = players.filter((player) => player.totalScore === highScore)
  return leaders.length === 1 ? (leaders[0] ?? null) : null
}
