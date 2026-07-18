import type { PlayerState } from "./model.js"

export function calculateRoundScore(player: PlayerState, achievedFlipSeven: boolean): number {
  if (player.roundStatus === "busted") {
    return 0
  }

  const numberTotal = player.numberCards.reduce((sum, card) => sum + card.value, 0)
  const hasMultiplier = player.modifierCards.some((card) => card.operation === "multiply")
  const additiveTotal = player.modifierCards.reduce(
    (sum, card) => sum + (card.operation === "add" ? card.value : 0),
    0,
  )

  return numberTotal * (hasMultiplier ? 2 : 1) + additiveTotal + (achievedFlipSeven ? 15 : 0)
}

export function findWinner(players: readonly PlayerState[], targetScore = 200): PlayerState | null {
  const highScore = Math.max(...players.map((player) => player.totalScore))
  if (highScore < targetScore) {
    return null
  }

  const leaders = players.filter((player) => player.totalScore === highScore)
  return leaders.length === 1 ? (leaders[0] ?? null) : null
}
