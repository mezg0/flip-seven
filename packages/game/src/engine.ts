import { createDeck, shuffleCards } from "./deck.js"
import {
  defaultGameConfig,
  GameRuleError,
  type ActionCard,
  type ApplyCommandResult,
  type Card,
  type DrawSource,
  type FlipThreeContext,
  type GameCommand,
  type GameConfig,
  type GameEvent,
  type GameState,
  type PendingAction,
  type PendingActionKind,
  type PlayerInput,
  type PlayerState,
  type PublicGameState,
} from "./model.js"
import { calculateRoundScore, findWinner } from "./scoring.js"

export interface CreateGameOptions {
  readonly dealerSeat?: number
  readonly config?: Partial<GameConfig>
}

type Resolution = {
  readonly outcome: "resolved" | "survivedDuplicate" | "busted" | "flipSeven" | "discarded"
  readonly flowHandled?: boolean
}

type EngineContext = {
  readonly state: GameState
  readonly events: GameEvent[]
}

export function createGame(
  id: string,
  players: readonly PlayerInput[],
  seed: number | string,
  options: CreateGameOptions = {},
): GameState {
  const config = { ...defaultGameConfig, ...options.config }
  validatePlayers(players, config.maximumPlayers)
  const orderedPlayers = [...players].sort((left, right) => left.seat - right.seat)
  const dealerSeat = options.dealerSeat ?? orderedPlayers[0]?.seat
  if (dealerSeat === undefined || !orderedPlayers.some((player) => player.seat === dealerSeat)) {
    throw new GameRuleError("INVALID_PLAYERS", "Dealer seat must belong to a player")
  }

  const shuffled = createDeck(seed, id)
  return {
    id,
    phase: "lobby",
    players: orderedPlayers.map(createPlayerState),
    dealerSeat,
    currentTurnSeat: null,
    drawPile: shuffled.cards,
    discardPile: [],
    roundNumber: 0,
    initialDealSeatsRemaining: [],
    pendingAction: null,
    flipThreeStack: [],
    flipSevenPlayerId: null,
    winnerId: null,
    eventLog: [],
    revision: 0,
    randomState: shuffled.randomState,
    config,
  }
}

export function applyCommand(state: GameState, command: GameCommand): ApplyCommandResult {
  validateCommand(state, command)
  const nextState = structuredClone(state)
  const context: EngineContext = { state: nextState, events: [] }

  switch (command.type) {
    case "START_GAME":
      startGame(context)
      break
    case "HIT":
      drawForTurn(context, command.actorId)
      break
    case "STAY":
      stay(context, command.actorId)
      break
    case "SELECT_ACTION_TARGET":
      selectActionTarget(context, command.actorId, command.targetId)
      break
  }

  nextState.revision += 1
  nextState.eventLog.push(...context.events)
  return { nextState, events: context.events }
}

export function validateCommand(state: GameState, command: GameCommand): void {
  const actor = state.players.find((player) => player.id === command.actorId)
  if (actor === undefined) {
    throw new GameRuleError("ACTOR_NOT_FOUND", "Command actor is not a player in this game")
  }

  if (command.type !== "START_GAME" && command.expectedRevision !== state.revision) {
    throw new GameRuleError("STALE_REVISION", "The game changed before this command was received")
  }

  switch (command.type) {
    case "START_GAME":
      if (state.phase !== "lobby") {
        throw new GameRuleError("COMMAND_NOT_ALLOWED", "The game has already started")
      }
      if (state.players.length < state.config.minimumPlayers) {
        throw new GameRuleError("NOT_ENOUGH_PLAYERS", `At least ${state.config.minimumPlayers} players are required`)
      }
      return
    case "HIT":
    case "STAY":
      if (state.phase !== "awaitingTurnChoice") {
        throw new GameRuleError("COMMAND_NOT_ALLOWED", "Hit and stay require an active turn choice")
      }
      if (actor.seat !== state.currentTurnSeat) {
        throw new GameRuleError("NOT_CURRENT_PLAYER", "Only the current player can act")
      }
      if (actor.roundStatus !== "active") {
        throw new GameRuleError("PLAYER_NOT_ACTIVE", "The current player is no longer active")
      }
      if (command.type === "STAY" && !hasCardsInFront(actor)) {
        throw new GameRuleError("CANNOT_STAY_WITHOUT_CARDS", "A player needs at least one card before staying")
      }
      return
    case "SELECT_ACTION_TARGET": {
      if (state.phase !== "awaitingActionTarget" || state.pendingAction === null) {
        throw new GameRuleError("COMMAND_NOT_ALLOWED", "No action is waiting for a target")
      }
      if (state.pendingAction.chooserId !== command.actorId) {
        throw new GameRuleError("NOT_ACTION_CHOOSER", "Only the player dealt this action can choose its target")
      }
      const eligible = eligibleTargets(state, state.pendingAction)
      if (!eligible.some((player) => player.id === command.targetId)) {
        throw new GameRuleError("INVALID_ACTION_TARGET", "The selected player is not eligible for this action")
      }
    }
  }
}

export function toPublicGameState(state: GameState): PublicGameState {
  return {
    id: state.id,
    phase: state.phase,
    players: structuredClone(state.players),
    dealerSeat: state.dealerSeat,
    currentTurnSeat: state.currentTurnSeat,
    remainingCardCount: state.drawPile.length,
    discardCount: state.discardPile.length,
    roundNumber: state.roundNumber,
    pendingAction: structuredClone(state.pendingAction),
    flipSevenPlayerId: state.flipSevenPlayerId,
    winnerId: state.winnerId,
    revision: state.revision,
  }
}

function validatePlayers(players: readonly PlayerInput[], maximumPlayers: number): void {
  if (players.length === 0) {
    throw new GameRuleError("INVALID_PLAYERS", "A game needs at least one player")
  }
  if (players.length > maximumPlayers) {
    throw new GameRuleError("INVALID_PLAYERS", `A game supports at most ${maximumPlayers} players`)
  }
  const ids = new Set(players.map((player) => player.id))
  const seats = new Set(players.map((player) => player.seat))
  if (ids.size !== players.length || seats.size !== players.length || players.some((player) => player.seat < 0)) {
    throw new GameRuleError("INVALID_PLAYERS", "Player IDs and non-negative seats must be unique")
  }
}

function createPlayerState(player: PlayerInput): PlayerState {
  return {
    ...player,
    totalScore: 0,
    roundStatus: "active",
    numberCards: [],
    modifierCards: [],
    hasSecondChance: false,
    actionCardsInFront: [],
    lockedRoundScore: null,
  }
}

function emit(context: EngineContext, event: GameEvent): void {
  context.events.push(event)
}

function startGame(context: EngineContext): void {
  startRound(context)
}

function startRound(context: EngineContext): void {
  const { state } = context
  state.roundNumber += 1
  state.phase = "initialDeal"
  state.currentTurnSeat = null
  state.pendingAction = null
  state.flipThreeStack = []
  state.flipSevenPlayerId = null
  for (const player of state.players) {
    resetPlayerRound(player)
  }
  state.initialDealSeatsRemaining = seatsStartingAt(state, state.dealerSeat)
  const dealer = playerAtSeat(state, state.dealerSeat)
  emit(context, { type: "ROUND_STARTED", round: state.roundNumber, dealerId: dealer.id })
  continueInitialDeal(context)
}

function resetPlayerRound(player: PlayerState): void {
  player.roundStatus = "active"
  player.numberCards = []
  player.modifierCards = []
  player.hasSecondChance = false
  player.actionCardsInFront = []
  player.lockedRoundScore = null
}

function continueInitialDeal(context: EngineContext): void {
  const { state } = context
  state.phase = "initialDeal"
  while (state.initialDealSeatsRemaining.length > 0) {
    if (roundShouldEnd(state)) {
      finishRound(context)
      return
    }
    const seat = state.initialDealSeatsRemaining.shift()
    if (seat === undefined) {
      break
    }
    const player = playerAtSeat(state, seat)
    if (player.roundStatus !== "active") {
      continue
    }
    if (drawAndResolve(context, player.id, "initialDeal")) {
      return
    }
  }

  if (roundShouldEnd(state)) {
    finishRound(context)
    return
  }
  startTurnAtOrAfter(context, state.dealerSeat)
}

function drawForTurn(context: EngineContext, playerId: string): void {
  context.state.phase = "resolvingCards"
  if (!drawAndResolve(context, playerId, "normalDraw")) {
    resumeAfterSource(context, "normalDraw")
  }
}

function drawAndResolve(context: EngineContext, recipientId: string, source: DrawSource): boolean {
  const card = drawCard(context)
  emit(context, { type: "CARD_REVEALED", recipientId, card, source })
  const resolution = resolveAlreadyDrawnCard(context, recipientId, card, source)
  if (resolution.outcome === "flipSeven") {
    finishRound(context)
    return true
  }
  return resolution.flowHandled === true
}

function drawCard(context: EngineContext): Card {
  const { state } = context
  if (state.drawPile.length === 0) {
    if (state.discardPile.length === 0) {
      throw new GameRuleError("NO_DRAWABLE_CARDS", "No cards remain in the draw or discard piles")
    }
    const shuffled = shuffleCards(state.discardPile, state.randomState)
    state.drawPile = shuffled.cards
    state.randomState = shuffled.randomState
    state.discardPile = []
    emit(context, { type: "DECK_RESHUFFLED" })
  }

  const card = state.drawPile.pop()
  if (card === undefined) {
    throw new GameRuleError("NO_DRAWABLE_CARDS", "No card could be drawn")
  }
  return card
}

function resolveAlreadyDrawnCard(
  context: EngineContext,
  recipientId: string,
  card: Card,
  source: DrawSource,
): Resolution {
  switch (card.kind) {
    case "number":
      return resolveNumberCard(context, recipientId, card)
    case "modifier":
      playerById(context.state, recipientId).modifierCards.push(card)
      return { outcome: "resolved" }
    case "action":
      return resolveActionCard(context, recipientId, card, source)
  }
}

function resolveNumberCard(
  context: EngineContext,
  playerId: string,
  card: Extract<Card, { kind: "number" }>,
): Resolution {
  const player = playerById(context.state, playerId)
  const duplicate = player.numberCards.some((existing) => existing.value === card.value)

  if (duplicate && player.hasSecondChance) {
    player.hasSecondChance = false
    const secondChance = removeActionCard(player, (candidate) => candidate.action === "secondChance")
    context.state.discardPile.push(secondChance, card)
    emit(context, { type: "SECOND_CHANCE_USED", playerId, duplicateValue: card.value })
    return { outcome: "survivedDuplicate" }
  }

  if (duplicate) {
    player.numberCards.push(card)
    player.roundStatus = "busted"
    player.lockedRoundScore = 0
    emit(context, { type: "PLAYER_BUSTED", playerId, duplicateValue: card.value })
    return { outcome: "busted" }
  }

  player.numberCards.push(card)
  if (new Set(player.numberCards.map((numberCard) => numberCard.value)).size === 7) {
    context.state.flipSevenPlayerId = playerId
    emit(context, { type: "FLIP_SEVEN_ACHIEVED", playerId })
    return { outcome: "flipSeven" }
  }
  return { outcome: "resolved" }
}

function resolveActionCard(
  context: EngineContext,
  recipientId: string,
  card: ActionCard,
  source: DrawSource,
): Resolution {
  const recipient = playerById(context.state, recipientId)
  recipient.actionCardsInFront.push(card)

  if (card.action === "secondChance") {
    if (!recipient.hasSecondChance) {
      recipient.hasSecondChance = true
      return { outcome: "resolved" }
    }

    const pending: PendingAction = {
      cardId: card.id,
      action: "secondChanceTransfer",
      chooserId: recipientId,
      targetId: null,
      source,
    }
    const eligible = eligibleTargets(context.state, pending)
    if (eligible.length === 0) {
      context.state.discardPile.push(removeActionCard(recipient, (candidate) => candidate.id === card.id))
      return { outcome: "discarded" }
    }
    requestActionTarget(context, pending)
    return { outcome: "resolved", flowHandled: true }
  }

  requestActionTarget(context, {
    cardId: card.id,
    action: card.action,
    chooserId: recipientId,
    targetId: null,
    source,
  })
  return { outcome: "resolved", flowHandled: true }
}

function requestActionTarget(context: EngineContext, pending: PendingAction): void {
  const eligible = eligibleTargets(context.state, pending)
  if (eligible.length === 0) {
    if (roundShouldEnd(context.state)) {
      finishRound(context)
      return
    }
    throw new GameRuleError("INVALID_ACTION_TARGET", "This action has no eligible target")
  }
  if (eligible.length === 1) {
    resolveActionTarget(context, pending, eligible[0]?.id ?? "")
    return
  }

  context.state.pendingAction = pending
  context.state.phase = "awaitingActionTarget"
  emit(context, {
    type: "ACTION_TARGET_REQUESTED",
    chooserId: pending.chooserId,
    action: pending.action,
    eligibleTargetIds: eligible.map((player) => player.id),
  })
}

function selectActionTarget(context: EngineContext, actorId: string, targetId: string): void {
  const pending = context.state.pendingAction
  if (pending === null || pending.chooserId !== actorId) {
    throw new GameRuleError("NOT_ACTION_CHOOSER", "No action is waiting for this player's choice")
  }
  context.state.pendingAction = null
  context.state.phase = "resolvingCards"
  resolveActionTarget(context, pending, targetId)
}

function resolveActionTarget(context: EngineContext, pending: PendingAction, targetId: string): void {
  const targeted = { ...pending, targetId }
  emit(context, {
    type: "ACTION_TARGETED",
    chooserId: pending.chooserId,
    targetId,
    action: pending.action,
  })

  if (targeted.action === "secondChanceTransfer") {
    const chooser = playerById(context.state, targeted.chooserId)
    const target = playerById(context.state, targetId)
    const card = removeActionCard(chooser, (candidate) => candidate.id === targeted.cardId)
    target.actionCardsInFront.push(card)
    target.hasSecondChance = true
    resumeAfterSource(context, targeted.source)
    return
  }

  const chooser = playerById(context.state, targeted.chooserId)
  const target = playerById(context.state, targetId)
  const card = removeActionCard(chooser, (candidate) => candidate.id === targeted.cardId)
  target.actionCardsInFront.push(card)

  if (targeted.action === "freeze") {
    target.roundStatus = "frozen"
    target.lockedRoundScore = calculateRoundScore(target, false)
    emit(context, { type: "PLAYER_FROZEN", targetId, score: target.lockedRoundScore })
    if (roundShouldEnd(context.state)) {
      finishRound(context)
      return
    }
    resumeAfterSource(context, targeted.source)
    return
  }

  const flipThreeContext: FlipThreeContext = {
    targetId,
    cardsRemaining: 3,
    queuedActions: [],
    source: targeted.source,
  }
  context.state.flipThreeStack.push(flipThreeContext)
  emit(context, { type: "FLIP_THREE_STARTED", targetId })
  continueFlipThree(context)
}

function continueFlipThree(context: EngineContext): void {
  const flipContext = context.state.flipThreeStack.at(-1)
  if (flipContext === undefined) {
    return
  }
  context.state.phase = "resolvingCards"

  while (flipContext.cardsRemaining > 0) {
    if (context.state.flipSevenPlayerId !== null) {
      finishRound(context)
      return
    }
    const target = playerById(context.state, flipContext.targetId)
    if (target.roundStatus !== "active") {
      completeFlipThreeContext(context, flipContext)
      return
    }

    flipContext.cardsRemaining -= 1
    const card = drawCard(context)
    emit(context, { type: "CARD_REVEALED", recipientId: target.id, card, source: "flipThree" })

    if (card.kind === "action" && card.action !== "secondChance") {
      target.actionCardsInFront.push(card)
      flipContext.queuedActions.push({
        cardId: card.id,
        action: card.action,
        chooserId: target.id,
        targetId: null,
        source: "flipThree",
      })
      continue
    }

    const resolution = resolveAlreadyDrawnCard(context, target.id, card, "flipThree")
    if (resolution.outcome === "flipSeven") {
      finishRound(context)
      return
    }
    if (resolution.outcome === "busted") {
      completeFlipThreeContext(context, flipContext)
      return
    }
    if (resolution.flowHandled === true) {
      return
    }
  }

  if (roundShouldEnd(context.state)) {
    finishRound(context)
    return
  }
  const queued = flipContext.queuedActions.shift()
  if (queued !== undefined) {
    requestActionTarget(context, queued)
    return
  }
  completeFlipThreeContext(context, flipContext)
}

function completeFlipThreeContext(context: EngineContext, completed: FlipThreeContext): void {
  const popped = context.state.flipThreeStack.pop()
  if (popped !== completed) {
    throw new Error("Flip Three stack was resolved out of order")
  }

  if (context.state.flipThreeStack.length > 0) {
    continueFlipThree(context)
    return
  }
  resumeAfterSource(context, completed.source)
}

function stay(context: EngineContext, playerId: string): void {
  const player = playerById(context.state, playerId)
  player.roundStatus = "stayed"
  player.lockedRoundScore = calculateRoundScore(player, false)
  emit(context, { type: "PLAYER_STAYED", playerId, score: player.lockedRoundScore })
  if (roundShouldEnd(context.state)) {
    finishRound(context)
    return
  }
  advanceTurn(context)
}

function resumeAfterSource(context: EngineContext, source: DrawSource): void {
  if (context.state.phase === "gameOver") {
    return
  }
  if (roundShouldEnd(context.state)) {
    finishRound(context)
    return
  }
  if (source === "initialDeal") {
    continueInitialDeal(context)
    return
  }
  if (source === "normalDraw") {
    advanceTurn(context)
    return
  }
  continueFlipThree(context)
}

function advanceTurn(context: EngineContext): void {
  const { state } = context
  if (roundShouldEnd(state)) {
    finishRound(context)
    return
  }
  const startingSeat = state.currentTurnSeat ?? state.dealerSeat
  const seats = seatsStartingAfter(state, startingSeat)
  const nextSeat = seats.find((seat) => playerAtSeat(state, seat).roundStatus === "active")
  if (nextSeat === undefined) {
    finishRound(context)
    return
  }
  beginTurn(context, nextSeat)
}

function startTurnAtOrAfter(context: EngineContext, seat: number): void {
  const seats = seatsStartingAt(context.state, seat)
  const nextSeat = seats.find((candidate) => playerAtSeat(context.state, candidate).roundStatus === "active")
  if (nextSeat === undefined) {
    finishRound(context)
    return
  }
  beginTurn(context, nextSeat)
}

function beginTurn(context: EngineContext, seat: number): void {
  context.state.currentTurnSeat = seat
  context.state.phase = "awaitingTurnChoice"
  emit(context, { type: "TURN_STARTED", playerId: playerAtSeat(context.state, seat).id })
}

function finishRound(context: EngineContext): void {
  const { state } = context
  state.phase = "roundScoring"
  state.currentTurnSeat = null
  state.pendingAction = null
  state.flipThreeStack = []
  state.initialDealSeatsRemaining = []

  for (const player of state.players) {
    const score = calculateRoundScore(player, player.id === state.flipSevenPlayerId)
    player.totalScore += score
    emit(context, { type: "ROUND_SCORE_AWARDED", playerId: player.id, score })
  }

  collectInPlayCards(state)

  const winner = findWinner(state.players, state.config.targetScore)
  if (winner !== null) {
    state.winnerId = winner.id
    state.phase = "gameOver"
    emit(context, { type: "GAME_WON", playerId: winner.id, totalScore: winner.totalScore })
    return
  }

  state.dealerSeat = nextSeat(state, state.dealerSeat)
  startRound(context)
}

function collectInPlayCards(state: GameState): void {
  for (const player of state.players) {
    state.discardPile.push(...player.numberCards, ...player.modifierCards, ...player.actionCardsInFront)
    player.numberCards = []
    player.modifierCards = []
    player.actionCardsInFront = []
    player.hasSecondChance = false
  }
}

function eligibleTargets(state: GameState, pending: PendingAction): PlayerState[] {
  return state.players.filter((player) => {
    if (player.roundStatus !== "active") {
      return false
    }
    if (pending.action === "secondChanceTransfer") {
      return player.id !== pending.chooserId && !player.hasSecondChance
    }
    return true
  })
}

function removeActionCard(player: PlayerState, predicate: (card: ActionCard) => boolean): ActionCard {
  const index = player.actionCardsInFront.findIndex(predicate)
  const [card] = index >= 0 ? player.actionCardsInFront.splice(index, 1) : []
  if (card === undefined) {
    throw new Error(`Expected action card in front of player ${player.id}`)
  }
  return card
}

function hasCardsInFront(player: PlayerState): boolean {
  return player.numberCards.length + player.modifierCards.length + player.actionCardsInFront.length > 0
}

function roundShouldEnd(state: GameState): boolean {
  return state.flipSevenPlayerId !== null || state.players.every((player) => player.roundStatus !== "active")
}

function playerById(state: GameState, playerId: string): PlayerState {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (player === undefined) {
    throw new GameRuleError("ACTOR_NOT_FOUND", `Unknown player ${playerId}`)
  }
  return player
}

function playerAtSeat(state: GameState, seat: number): PlayerState {
  const player = state.players.find((candidate) => candidate.seat === seat)
  if (player === undefined) {
    throw new GameRuleError("INVALID_PLAYERS", `No player occupies seat ${seat}`)
  }
  return player
}

function orderedSeats(state: GameState): number[] {
  return state.players.map((player) => player.seat).sort((left, right) => left - right)
}

function seatsStartingAt(state: GameState, seat: number): number[] {
  const seats = orderedSeats(state)
  const index = seats.indexOf(seat)
  return index < 0 ? seats : [...seats.slice(index), ...seats.slice(0, index)]
}

function seatsStartingAfter(state: GameState, seat: number): number[] {
  const seats = seatsStartingAt(state, seat)
  return seats.length <= 1 ? seats : [...seats.slice(1), seats[0] as number]
}

function nextSeat(state: GameState, seat: number): number {
  return seatsStartingAfter(state, seat)[0] ?? seat
}
