import { createDeck, shuffleCards } from "./deck.js"
import {
  defaultGameConfig,
  GameRuleError,
  type AresFrame,
  type ApplyCommandResult,
  type Card,
  type DrawSource,
  type GameCommand,
  type GameConfig,
  type GameEvent,
  type GameState,
  type GodCard,
  type GodKind,
  type GodResolutionFrame,
  type ModifierCard,
  type ModifierInstance,
  type NumberCard,
  type NumberInstance,
  type PendingChoice,
  type PersistentGodEffect,
  type PlayerInput,
  type PlayerState,
  type PublicGameState,
  type PublicPendingChoice,
  type ResolutionTask,
} from "./model.js"
import { calculateRoundScore, findWinner } from "./scoring.js"

export interface CreateGameOptions {
  readonly dealerSeat?: number
  readonly config?: Partial<GameConfig>
}

type EngineContext = {
  readonly state: GameState
  readonly events: GameEvent[]
}

type NumberOutcome = "accepted" | "protectedByZeus" | "busted"

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
    resolvingCards: [],
    roundNumber: 0,
    initialDealSeatsRemaining: [],
    pendingChoice: null,
    resolutionStack: [],
    resolutionTasks: [],
    godResolutionHistory: [],
    favourOfOlympusPlayerIds: [],
    roundEndRequested: false,
    winnerId: null,
    eventLog: [],
    revision: 0,
    randomState: shuffled.randomState,
    nextSequence: 0,
    config,
  }
}

/** Adds a player while the game is still waiting in its lobby. */
export function addPlayerToLobby(state: GameState, player: Omit<PlayerInput, "seat">): GameState {
  if (state.phase !== "lobby") {
    throw new GameRuleError("COMMAND_NOT_ALLOWED", "Players can only join before the game starts")
  }
  if (state.players.length >= state.config.maximumPlayers) {
    throw new GameRuleError("INVALID_PLAYERS", `A game supports at most ${state.config.maximumPlayers} players`)
  }
  if (state.players.some((existing) => existing.id === player.id)) {
    throw new GameRuleError("INVALID_PLAYERS", "That player has already joined this game")
  }

  const nextState = structuredClone(state)
  const nextSeat = Math.max(...nextState.players.map((existing) => existing.seat)) + 1
  nextState.players.push(createPlayerState({ ...player, seat: nextSeat }))
  nextState.revision += 1
  return nextState
}

export function applyCommand(state: GameState, command: GameCommand): ApplyCommandResult {
  validateCommand(state, command)
  const nextState = structuredClone(state)
  const context: EngineContext = { state: nextState, events: [] }

  switch (command.type) {
    case "START_GAME":
      startRound(context)
      runResolution(context)
      break
    case "HIT":
      beginTurnDraw(context, command.actorId)
      runResolution(context)
      break
    case "STAY":
      stay(context, command.actorId)
      runResolution(context)
      break
    case "ADVANCE_ROUND":
      advanceRound(context)
      runResolution(context)
      break
    case "SUBMIT_CHOICE":
      submitChoice(context, command.choiceId, command.selection)
      runResolution(context)
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
      if (command.type === "STAY" && !hasPhysicalCardsInFront(actor)) {
        throw new GameRuleError("CANNOT_STAY_WITHOUT_CARDS", "A player needs at least one card before staying")
      }
      return
    case "ADVANCE_ROUND":
      if (state.phase !== "roundScoring") {
        throw new GameRuleError("COMMAND_NOT_ALLOWED", "The round can only advance after scoring")
      }
      if (actor.seat !== 0) {
        throw new GameRuleError("COMMAND_NOT_ALLOWED", "Only the host can advance the round")
      }
      return
    case "SUBMIT_CHOICE":
      if (state.phase !== "awaitingChoice" || state.pendingChoice === null) {
        throw new GameRuleError("COMMAND_NOT_ALLOWED", "No God power is waiting for a choice")
      }
      if (state.pendingChoice.controllerId !== command.actorId) {
        throw new GameRuleError("NOT_CHOICE_CONTROLLER", "Only this God's controller can submit its choice")
      }
      if (state.pendingChoice.id !== command.choiceId) {
        throw new GameRuleError("INVALID_CHOICE", "The choice is no longer current")
      }
  }
}

export function toPublicGameState(state: GameState, viewerId?: string): PublicGameState {
  return {
    id: state.id,
    phase: state.phase,
    players: structuredClone(state.players),
    dealerSeat: state.dealerSeat,
    currentTurnSeat: state.currentTurnSeat,
    remainingCardCount: state.drawPile.length,
    discardCount: state.discardPile.length,
    roundNumber: state.roundNumber,
    pendingChoice: publicPendingChoice(state, viewerId),
    favourOfOlympusPlayerIds: [...state.favourOfOlympusPlayerIds],
    winnerId: state.winnerId,
    revision: state.revision,
  }
}

function publicPendingChoice(state: GameState, viewerId?: string): PublicPendingChoice | null {
  const { pendingChoice: choice } = state
  if (choice === null) return null
  const copy = structuredClone(choice)
  if (copy.kind === "reorderDeckTop" && copy.controllerId !== viewerId) {
    return { ...copy, physicalCardIds: [], cards: [] }
  }
  if (copy.kind === "reorderDeckTop") {
    return { ...copy, cards: cardsById(state.resolvingCards, copy.physicalCardIds) }
  }
  if (copy.kind === "chooseDiscardNumber" || copy.kind === "chooseDiscardModifier") {
    return { ...copy, cards: cardsById(state.discardPile, copy.physicalCardIds) }
  }
  return copy
}

function cardsById(cards: readonly Card[], ids: readonly string[]): Card[] {
  const byId = new Map(cards.map((card) => [card.id, card]))
  return ids.flatMap((id) => {
    const card = byId.get(id)
    return card === undefined ? [] : [card]
  })
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
    godEffects: [],
    godCardsInFront: [],
    lockedRoundScore: null,
  }
}

function emit(context: EngineContext, event: GameEvent): void {
  context.events.push(event)
}

function nextId(state: GameState, prefix: string): string {
  const id = `${prefix}-${state.nextSequence}`
  state.nextSequence += 1
  return id
}

function startRound(context: EngineContext): void {
  const { state } = context
  state.roundNumber += 1
  state.phase = "initialDeal"
  state.currentTurnSeat = null
  state.pendingChoice = null
  state.resolutionStack = []
  state.resolutionTasks = []
  state.resolvingCards = []
  state.godResolutionHistory = []
  state.favourOfOlympusPlayerIds = []
  state.roundEndRequested = false
  for (const player of state.players) resetPlayerRound(player)
  state.initialDealSeatsRemaining = seatsStartingAt(state, state.dealerSeat)
  emit(context, {
    type: "ROUND_STARTED",
    round: state.roundNumber,
    dealerId: playerAtSeat(state, state.dealerSeat).id,
  })
  continueInitialDeal(context)
}

function resetPlayerRound(player: PlayerState): void {
  player.roundStatus = "active"
  player.numberCards = []
  player.modifierCards = []
  player.godEffects = []
  player.godCardsInFront = []
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
    if (seat === undefined) break
    const player = playerAtSeat(state, seat)
    if (player.roundStatus !== "active") continue
    pushTask(state, { kind: "resumeSource", source: "initialDeal" })
    pushTask(state, { kind: "reveal", recipientId: player.id, source: "initialDeal" })
    return
  }

  if (roundShouldEnd(state)) {
    finishRound(context)
    return
  }
  startTurnAtOrAfter(context, state.dealerSeat)
}

function beginTurnDraw(context: EngineContext, playerId: string): void {
  context.state.phase = "resolvingCards"
  pushTask(context.state, { kind: "resumeSource", source: "normalDraw" })
  pushTask(context.state, { kind: "reveal", recipientId: playerId, source: "normalDraw" })
}

function runResolution(context: EngineContext): void {
  const { state } = context
  while (state.pendingChoice === null && state.phase !== "gameOver") {
    const task = state.resolutionTasks.pop()
    if (task === undefined) {
      if (state.resolutionStack.length > 0) {
        throw new Error("Resolution stack stopped without a pending choice or continuation")
      }
      if (roundShouldEnd(state)) finishRound(context)
      return
    }
    processTask(context, task)
  }
}

function processTask(context: EngineContext, task: ResolutionTask): void {
  switch (task.kind) {
    case "reveal":
      if (!context.state.roundEndRequested) revealAndResolve(context, task.recipientId, task.source)
      return
    case "resumeSource":
      resumeAfterSource(context, task.source)
      return
    case "aresContinue":
      continueAres(context, task.godFrameId, task.aresFrameId)
      return
    case "finishGod":
      finishGod(context, task.godFrameId, task.keepPhysicalCard, task.copiedGod)
  }
}

function pushTask(state: GameState, task: ResolutionTask): void {
  state.resolutionTasks.push(task)
}

function revealAndResolve(context: EngineContext, recipientId: string, source: DrawSource): void {
  const card = source === "initialDeal" ? drawOpeningCard(context) : drawCard(context)
  context.state.resolvingCards.push(card)
  emit(context, { type: "CARD_REVEALED", recipientId, card, source })

  if (card.kind === "number") {
    resolveIncomingNumber(context, recipientId, deckNumberInstance(card))
    removeResolvingCard(context.state, card.id)
    finishAtomicNumberChanges(context, [recipientId])
    return
  }
  if (card.kind === "modifier") {
    playerById(context.state, recipientId).modifierCards.push(deckModifierInstance(card))
    removeResolvingCard(context.state, card.id)
    return
  }
  beginGodResolution(context, card.god, recipientId, card.id, true, true, card.god)
}

function drawOpeningCard(context: EngineContext): Card {
  const { drawPile } = context.state
  const index = drawPile.findLastIndex((card) => card.kind !== "god")
  if (index < 0) {
    throw new GameRuleError("NO_DRAWABLE_CARDS", "No non-God cards remain for the opening deal")
  }
  const [card] = drawPile.splice(index, 1)
  if (card === undefined) throw new Error("Opening card disappeared from the draw pile")
  return card
}

function drawCard(context: EngineContext): Card {
  const card = drawCardOptional(context)
  if (card === null) {
    throw new GameRuleError("NO_DRAWABLE_CARDS", "No cards remain in the draw or discard piles")
  }
  return card
}

function drawCardOptional(context: EngineContext): Card | null {
  const { state } = context
  if (state.drawPile.length === 0) {
    if (state.discardPile.length === 0) return null
    const shuffled = shuffleCards(state.discardPile, state.randomState)
    state.drawPile = shuffled.cards
    state.randomState = shuffled.randomState
    state.discardPile = []
    emit(context, { type: "DECK_RESHUFFLED" })
  }
  return state.drawPile.pop() ?? null
}

function deckNumberInstance(card: NumberCard): NumberInstance {
  return { instanceId: card.id, value: card.value, physicalCardId: card.id, origin: "deck" }
}

function deckModifierInstance(card: ModifierCard): ModifierInstance {
  return {
    instanceId: card.id,
    operation: card.operation,
    value: card.value,
    physicalCardId: card.id,
    origin: "deck",
  }
}

function resolveIncomingNumber(
  context: EngineContext,
  playerId: string,
  incoming: NumberInstance,
): NumberOutcome {
  const player = requireActivePlayer(context.state, playerId)
  const duplicate = player.numberCards.some((card) => card.value === incoming.value)
  if (!duplicate) {
    player.numberCards.push(incoming)
    return "accepted"
  }

  const zeus = player.godEffects.find((effect) => effect.kind === "zeus")
  if (zeus !== undefined) {
    player.godEffects = player.godEffects.filter((effect) => effect.effectId !== zeus.effectId)
    discardPersistentGodCard(context.state, player, zeus)
    discardOrDestroyNumber(context.state, incoming)
    emit(context, { type: "ZEUS_TRIGGERED", playerId, duplicateValue: incoming.value })
    return "protectedByZeus"
  }

  player.numberCards.push(incoming)
  player.roundStatus = "busted"
  player.lockedRoundScore = 0
  emit(context, { type: "PLAYER_BUSTED", playerId, duplicateValue: incoming.value })
  return "busted"
}

function finishAtomicNumberChanges(context: EngineContext, affectedPlayerIds: readonly string[]): void {
  const uniqueIds = [...new Set(affectedPlayerIds)]
    .sort((left, right) => playerById(context.state, left).seat - playerById(context.state, right).seat)
  const achievers = uniqueIds.filter((playerId) => {
    const player = playerById(context.state, playerId)
    return player.roundStatus === "active" && new Set(player.numberCards.map((card) => card.value)).size >= 7
  })

  for (const playerId of achievers) {
    if (!context.state.favourOfOlympusPlayerIds.includes(playerId)) {
      context.state.favourOfOlympusPlayerIds.push(playerId)
      emit(context, { type: "FAVOUR_OF_OLYMPUS_ACHIEVED", playerId })
    }
  }
  if (achievers.length > 0) context.state.roundEndRequested = true
}

function beginGodResolution(
  context: EngineContext,
  god: GodKind,
  controllerId: string,
  physicalCardId: string | null,
  canKeepPhysicalCard: boolean,
  recordHistory: boolean,
  actualGod: GodKind,
): void {
  const frame: GodResolutionFrame = {
    kind: "god",
    id: nextId(context.state, "god-frame"),
    god,
    actualGod,
    controllerId,
    physicalCardId,
    canKeepPhysicalCard,
    recordHistory,
  }
  context.state.resolutionStack.push(frame)
  executeGodEffect(context, frame)
}

function executeGodEffect(context: EngineContext, frame: GodResolutionFrame): void {
  switch (frame.god) {
    case "zeus":
      resolveZeus(context, frame)
      return
    case "ares":
    case "dionysus": {
      const eligible = activePlayers(context.state).map((player) => player.id)
      if (eligible.length === 0) finishGod(context, frame.id, false, null)
      else requestPlayers(context, frame, eligible, 1, 1)
      return
    }
    case "athena":
      resolveAthena(context, frame)
      return
    case "hades":
      requestHadesChoice(context, frame)
      return
    case "hermes":
      requestHermesChoice(context, frame)
      return
    case "artemis":
      requestArtemisChoice(context, frame)
      return
    case "aphrodite": {
      const eligible = activePlayers(context.state).map((player) => player.id)
      if (eligible.length < 2) finishGod(context, frame.id, false, null)
      else requestPlayers(context, frame, eligible, 2, 2)
      return
    }
    case "hephaestus":
      resolveOrRequestHephaestus(context, frame)
      return
    case "demeter": {
      const eligible = activePlayers(context.state)
        .filter((player) => player.numberCards.length > 0)
        .map((player) => player.id)
      if (eligible.length === 0) finishGod(context, frame.id, false, null)
      else requestPlayers(context, frame, eligible, 1, 1)
      return
    }
    case "nike":
      addPersistentEffect(context.state, frame, frame.controllerId, "nike")
      finishGod(context, frame.id, frame.canKeepPhysicalCard, null)
      return
    case "prometheus":
      resolvePrometheus(context, frame)
  }
}

function resolveZeus(context: EngineContext, frame: GodResolutionFrame): void {
  const player = playerById(context.state, frame.controllerId)
  if (player.godEffects.some((effect) => effect.kind === "zeus")) {
    finishGod(context, frame.id, false, null)
    return
  }
  addPersistentEffect(context.state, frame, player.id, "zeus")
  finishGod(context, frame.id, frame.canKeepPhysicalCard, null)
}

function addPersistentEffect(
  state: GameState,
  frame: GodResolutionFrame,
  ownerId: string,
  kind: PersistentGodEffect["kind"],
): void {
  playerById(state, ownerId).godEffects.push({
    effectId: nextId(state, "effect"),
    kind,
    ownerId,
    physicalCardId: frame.canKeepPhysicalCard ? frame.physicalCardId : null,
    grantedBy: frame.actualGod,
  })
}

function requestPlayers(
  context: EngineContext,
  frame: GodResolutionFrame,
  eligiblePlayerIds: readonly string[],
  min: number,
  max: number,
): void {
  requestChoice(context, {
    id: nextId(context.state, "choice"),
    kind: "choosePlayers",
    controllerId: frame.controllerId,
    godFrameId: frame.id,
    god: frame.god,
    min,
    max,
    eligiblePlayerIds: [...eligiblePlayerIds],
    distinct: true,
  })
}

function resolveAthena(context: EngineContext, frame: GodResolutionFrame): void {
  const cards: Card[] = []
  while (cards.length < 3) {
    const card = drawCardOptional(context)
    if (card === null) break
    cards.push(card)
    context.state.resolvingCards.push(card)
  }
  if (cards.length === 0) {
    finishGod(context, frame.id, false, null)
    return
  }
  requestChoice(context, {
    id: nextId(context.state, "choice"),
    kind: "reorderDeckTop",
    controllerId: frame.controllerId,
    godFrameId: frame.id,
    god: frame.god,
    physicalCardIds: cards.map((card) => card.id),
  })
}

function requestHadesChoice(context: EngineContext, frame: GodResolutionFrame): void {
  const physicalCardIds = context.state.discardPile
    .filter((card): card is NumberCard => card.kind === "number")
    .map((card) => card.id)
  const eligiblePlayerIds = activePlayers(context.state).map((player) => player.id)
  if (physicalCardIds.length === 0 || eligiblePlayerIds.length === 0) {
    finishGod(context, frame.id, false, null)
    return
  }
  requestChoice(context, {
    id: nextId(context.state, "choice"),
    kind: "chooseDiscardNumber",
    controllerId: frame.controllerId,
    godFrameId: frame.id,
    god: frame.god,
    physicalCardIds,
    eligiblePlayerIds,
  })
}

function requestHermesChoice(context: EngineContext, frame: GodResolutionFrame): void {
  const eligible = activePlayers(context.state)
    .filter((player) => player.numberCards.length > 0)
    .map((player) => ({ playerId: player.id, instanceIds: player.numberCards.map((card) => card.instanceId) }))
  if (eligible.length < 2) {
    finishGod(context, frame.id, false, null)
    return
  }
  requestChoice(context, {
    id: nextId(context.state, "choice"),
    kind: "chooseHermesExchange",
    controllerId: frame.controllerId,
    godFrameId: frame.id,
    god: frame.god,
    eligible,
  })
}

function requestArtemisChoice(context: EngineContext, frame: GodResolutionFrame): void {
  const eligible = activePlayers(context.state)
    .filter((player) => player.numberCards.length > 0)
    .map((player) => ({ playerId: player.id, instanceIds: player.numberCards.map((card) => card.instanceId) }))
  if (eligible.length === 0) {
    finishGod(context, frame.id, false, null)
    return
  }
  requestChoice(context, {
    id: nextId(context.state, "choice"),
    kind: "choosePlayerNumber",
    controllerId: frame.controllerId,
    godFrameId: frame.id,
    god: frame.god,
    eligible,
  })
}

function resolveOrRequestHephaestus(context: EngineContext, frame: GodResolutionFrame): void {
  const physicalCardIds = context.state.discardPile
    .filter((card): card is ModifierCard => card.kind === "modifier")
    .map((card) => card.id)
  if (physicalCardIds.length === 0) {
    playerById(context.state, frame.controllerId).modifierCards.push({
      instanceId: nextId(context.state, "hephaestus-modifier"),
      operation: "add",
      value: 4,
      physicalCardId: null,
      origin: "hephaestusFallback",
    })
    finishGod(context, frame.id, false, null)
    return
  }
  requestChoice(context, {
    id: nextId(context.state, "choice"),
    kind: "chooseDiscardModifier",
    controllerId: frame.controllerId,
    godFrameId: frame.id,
    god: frame.god,
    physicalCardIds,
    eligiblePlayerIds: activePlayers(context.state).map((player) => player.id),
  })
}

function resolvePrometheus(context: EngineContext, frame: GodResolutionFrame): void {
  const previous = context.state.godResolutionHistory.at(-1)
  if (previous === undefined || previous.god === "prometheus") {
    finishGod(context, frame.id, false, null)
    return
  }
  pushTask(context.state, {
    kind: "finishGod",
    godFrameId: frame.id,
    keepPhysicalCard: false,
    copiedGod: previous.god,
  })
  beginGodResolution(context, previous.god, frame.controllerId, null, false, false, "prometheus")
}

function requestChoice(context: EngineContext, choice: PendingChoice): void {
  context.state.pendingChoice = choice
  context.state.phase = "awaitingChoice"
  emit(context, {
    type: "CHOICE_REQUESTED",
    choiceId: choice.id,
    controllerId: choice.controllerId,
    god: choice.god,
    kind: choice.kind,
  })
}

function submitChoice(context: EngineContext, choiceId: string, selection: unknown): void {
  const choice = context.state.pendingChoice
  if (choice === null || choice.id !== choiceId) {
    throw new GameRuleError("INVALID_CHOICE", "The choice is no longer current")
  }
  const frame = requireGodFrame(context.state, choice.godFrameId)
  context.state.pendingChoice = null
  context.state.phase = "resolvingCards"

  switch (choice.kind) {
    case "choosePlayers":
      completePlayerChoice(context, frame, choice, selection)
      return
    case "reorderDeckTop":
      completeAthena(context, frame, choice, selection)
      return
    case "chooseDiscardNumber":
      completeHades(context, frame, choice, selection)
      return
    case "chooseHermesExchange":
      completeHermes(context, frame, choice, selection)
      return
    case "choosePlayerNumber":
      completeArtemis(context, frame, choice, selection)
      return
    case "chooseDiscardModifier":
      completeHephaestus(context, frame, choice, selection)
  }
}

function completePlayerChoice(
  context: EngineContext,
  frame: GodResolutionFrame,
  choice: Extract<PendingChoice, { kind: "choosePlayers" }>,
  selection: unknown,
): void {
  const playerIds = requireStringArray(selection)
  const unique = new Set(playerIds)
  if (
    playerIds.length < choice.min
    || playerIds.length > choice.max
    || (choice.distinct && unique.size !== playerIds.length)
    || playerIds.some((id) => !choice.eligiblePlayerIds.includes(id))
  ) {
    invalidChoice("Select the required number of eligible players")
  }

  if (frame.god === "ares") {
    const targetId = playerIds[0]
    if (targetId === undefined) invalidChoice("Ares requires one target")
    const aresFrame: AresFrame = {
      kind: "ares",
      id: nextId(context.state, "ares-frame"),
      godFrameId: frame.id,
      controllerId: frame.controllerId,
      targetId,
      cardsRemaining: 3,
    }
    context.state.resolutionStack.push(aresFrame)
    pushTask(context.state, { kind: "aresContinue", godFrameId: frame.id, aresFrameId: aresFrame.id })
    return
  }
  if (frame.god === "dionysus") {
    const target = requireActivePlayer(context.state, playerIds[0] ?? "")
    target.roundStatus = "stayed"
    target.lockedRoundScore = calculateRoundScore(target, false)
    emit(context, { type: "PLAYER_FORCED_TO_STAY", targetId: target.id, score: target.lockedRoundScore })
    finishGod(context, frame.id, false, null)
    return
  }
  if (frame.god === "demeter") {
    const targetId = playerIds[0]
    if (targetId === undefined) invalidChoice("Demeter requires one target")
    const target = requireActivePlayer(context.state, targetId)
    if (target.numberCards.length === 0) invalidChoice("Demeter's target needs a Number Card")
    addPersistentEffect(context.state, frame, targetId, "demeter")
    finishGod(context, frame.id, frame.canKeepPhysicalCard, null)
    return
  }
  if (frame.god === "aphrodite") {
    const first = playerIds[0]
    const second = playerIds[1]
    if (first === undefined || second === undefined) invalidChoice("Aphrodite requires two targets")
    resolveAphrodite(context, frame, first, second)
    return
  }
  invalidChoice("This God does not accept a player-list choice")
}

function continueAres(context: EngineContext, godFrameId: string, aresFrameId: string): void {
  const aresFrame = context.state.resolutionStack.find(
    (frame): frame is AresFrame => frame.kind === "ares" && frame.id === aresFrameId,
  )
  if (aresFrame === undefined || aresFrame.godFrameId !== godFrameId) {
    throw new Error("Ares continuation frame is missing")
  }
  const target = playerById(context.state, aresFrame.targetId)
  if (context.state.roundEndRequested || target.roundStatus !== "active" || aresFrame.cardsRemaining === 0) {
    popResolutionFrame(context.state, aresFrame.id)
    finishGod(context, godFrameId, false, null)
    return
  }
  aresFrame.cardsRemaining -= 1
  pushTask(context.state, { kind: "aresContinue", godFrameId, aresFrameId })
  pushTask(context.state, { kind: "reveal", recipientId: target.id, source: "ares" })
}

function completeAthena(
  context: EngineContext,
  frame: GodResolutionFrame,
  choice: Extract<PendingChoice, { kind: "reorderDeckTop" }>,
  selection: unknown,
): void {
  const orderedIds = requireStringArray(selection)
  if (!isExactPermutation(orderedIds, choice.physicalCardIds)) {
    invalidChoice("Athena requires an exact permutation of the peeked cards")
  }
  const cards = orderedIds.map((id) => requireResolvingCard(context.state, id))
  for (const card of cards) removeResolvingCard(context.state, card.id)
  for (const card of [...cards].reverse()) context.state.drawPile.push(card)
  finishGod(context, frame.id, false, null)
}

function completeHades(
  context: EngineContext,
  frame: GodResolutionFrame,
  choice: Extract<PendingChoice, { kind: "chooseDiscardNumber" }>,
  selection: unknown,
): void {
  const value = requireRecord(selection)
  const physicalCardId = requireString(value.physicalCardId)
  const targetId = requireString(value.targetId)
  if (!choice.physicalCardIds.includes(physicalCardId) || !choice.eligiblePlayerIds.includes(targetId)) {
    invalidChoice("Hades requires an eligible discarded Number Card and active target")
  }
  const card = removeDiscardCard(context.state, physicalCardId)
  if (card.kind !== "number") invalidChoice("Hades can only resurrect Number Cards")
  resolveIncomingNumber(context, targetId, deckNumberInstance(card))
  finishAtomicNumberChanges(context, [targetId])
  finishGod(context, frame.id, false, null)
}

function completeHermes(
  context: EngineContext,
  frame: GodResolutionFrame,
  choice: Extract<PendingChoice, { kind: "chooseHermesExchange" }>,
  selection: unknown,
): void {
  const value = requireRecord(selection)
  const left = requirePlayerInstanceSelection(value.left)
  const right = requirePlayerInstanceSelection(value.right)
  if (left.playerId === right.playerId) invalidChoice("Hermes requires two distinct players")
  validateOwnedSelection(choice.eligible, left)
  validateOwnedSelection(choice.eligible, right)
  const leftPlayer = requireActivePlayer(context.state, left.playerId)
  const rightPlayer = requireActivePlayer(context.state, right.playerId)
  const leftCard = removeNumberInstance(leftPlayer, left.instanceId)
  const rightCard = removeNumberInstance(rightPlayer, right.instanceId)
  const incoming = [
    { player: leftPlayer, card: rightCard },
    { player: rightPlayer, card: leftCard },
  ].sort((a, b) => a.player.seat - b.player.seat)
  for (const entry of incoming) resolveIncomingNumber(context, entry.player.id, entry.card)
  finishAtomicNumberChanges(context, [left.playerId, right.playerId])
  finishGod(context, frame.id, false, null)
}

function completeArtemis(
  context: EngineContext,
  frame: GodResolutionFrame,
  choice: Extract<PendingChoice, { kind: "choosePlayerNumber" }>,
  selection: unknown,
): void {
  const selected = requirePlayerInstanceSelection(selection)
  validateOwnedSelection(choice.eligible, selected)
  const player = requireActivePlayer(context.state, selected.playerId)
  discardOrDestroyNumber(context.state, removeNumberInstance(player, selected.instanceId))
  finishGod(context, frame.id, false, null)
}

function completeHephaestus(
  context: EngineContext,
  frame: GodResolutionFrame,
  choice: Extract<PendingChoice, { kind: "chooseDiscardModifier" }>,
  selection: unknown,
): void {
  const value = requireRecord(selection)
  const physicalCardId = requireString(value.physicalCardId)
  const targetId = requireString(value.targetId)
  if (!choice.physicalCardIds.includes(physicalCardId) || !choice.eligiblePlayerIds.includes(targetId)) {
    invalidChoice("Hephaestus requires an eligible discarded Modifier and active target")
  }
  const card = removeDiscardCard(context.state, physicalCardId)
  if (card.kind !== "modifier") invalidChoice("Hephaestus can only forge Modifier Cards")
  requireActivePlayer(context.state, targetId).modifierCards.push(deckModifierInstance(card))
  finishGod(context, frame.id, false, null)
}

function resolveAphrodite(
  context: EngineContext,
  frame: GodResolutionFrame,
  firstId: string,
  secondId: string,
): void {
  const targets = [
    requireActivePlayer(context.state, firstId),
    requireActivePlayer(context.state, secondId),
  ].sort((left, right) => left.seat - right.seat)
  const revealed = drawCardOptional(context)
  if (revealed === null) {
    finishGod(context, frame.id, false, null)
    return
  }
  context.state.resolvingCards.push(revealed)
  emit(context, { type: "CARD_REVEALED", recipientId: frame.controllerId, card: revealed, source: "aphrodite" })

  if (revealed.kind === "number") {
    for (const target of targets) {
      resolveIncomingNumber(context, target.id, {
        instanceId: nextId(context.state, "aphrodite-number"),
        value: revealed.value,
        physicalCardId: null,
        origin: "aphrodite",
      })
    }
    moveResolvingToDiscard(context.state, revealed.id)
    finishAtomicNumberChanges(context, targets.map((target) => target.id))
    finishGod(context, frame.id, false, null)
    return
  }
  if (revealed.kind === "modifier") {
    for (const target of targets) {
      target.modifierCards.push({
        instanceId: nextId(context.state, "aphrodite-modifier"),
        operation: revealed.operation,
        value: revealed.value,
        physicalCardId: null,
        origin: "aphrodite",
      })
    }
    moveResolvingToDiscard(context.state, revealed.id)
    finishGod(context, frame.id, false, null)
    return
  }

  pushTask(context.state, {
    kind: "finishGod",
    godFrameId: frame.id,
    keepPhysicalCard: false,
    copiedGod: null,
  })
  beginGodResolution(context, revealed.god, frame.controllerId, revealed.id, false, true, revealed.god)
}

function finishGod(
  context: EngineContext,
  godFrameId: string,
  keepPhysicalCard: boolean,
  copiedGod: GodKind | null,
): void {
  const frame = requireGodFrame(context.state, godFrameId)
  const top = context.state.resolutionStack.at(-1)
  if (top?.id !== frame.id) throw new Error(`God frame ${frame.id} completed out of order`)

  if (frame.physicalCardId !== null) {
    const card = requireResolvingCard(context.state, frame.physicalCardId)
    if (card.kind !== "god") throw new Error("A God frame referenced a non-God card")
    removeResolvingCard(context.state, card.id)
    if (keepPhysicalCard) {
      const owner = context.state.players.find((player) =>
        player.godEffects.some((effect) => effect.physicalCardId === card.id),
      )
      if (owner === undefined) throw new Error("A retained God Card has no persistent effect owner")
      owner.godCardsInFront.push(card)
    } else {
      context.state.discardPile.push(card)
    }
  }

  popResolutionFrame(context.state, frame.id)
  if (frame.recordHistory) {
    context.state.godResolutionHistory.push({
      god: frame.god,
      controllerId: frame.controllerId,
      copiedGod,
      completedAtSequence: context.state.nextSequence,
    })
  }
  emit(context, { type: "GOD_RESOLVED", god: frame.god, controllerId: frame.controllerId, copiedGod })
}

function resumeAfterSource(context: EngineContext, source: "initialDeal" | "normalDraw"): void {
  if (roundShouldEnd(context.state)) {
    if (context.state.resolutionStack.length === 0) finishRound(context)
    return
  }
  if (source === "initialDeal") continueInitialDeal(context)
  else advanceTurn(context)
}

function stay(context: EngineContext, playerId: string): void {
  const player = playerById(context.state, playerId)
  player.roundStatus = "stayed"
  player.lockedRoundScore = calculateRoundScore(player, false)
  emit(context, { type: "PLAYER_STAYED", playerId, score: player.lockedRoundScore })
  if (roundShouldEnd(context.state)) finishRound(context)
  else advanceTurn(context)
}

function advanceTurn(context: EngineContext): void {
  if (roundShouldEnd(context.state)) {
    finishRound(context)
    return
  }
  const startingSeat = context.state.currentTurnSeat ?? context.state.dealerSeat
  const nextSeat = seatsStartingAfter(context.state, startingSeat)
    .find((seat) => playerAtSeat(context.state, seat).roundStatus === "active")
  if (nextSeat === undefined) finishRound(context)
  else beginTurn(context, nextSeat)
}

function startTurnAtOrAfter(context: EngineContext, seat: number): void {
  const nextSeat = seatsStartingAt(context.state, seat)
    .find((candidate) => playerAtSeat(context.state, candidate).roundStatus === "active")
  if (nextSeat === undefined) finishRound(context)
  else beginTurn(context, nextSeat)
}

function beginTurn(context: EngineContext, seat: number): void {
  context.state.currentTurnSeat = seat
  context.state.phase = "awaitingTurnChoice"
  emit(context, { type: "TURN_STARTED", playerId: playerAtSeat(context.state, seat).id })
}

function finishRound(context: EngineContext): void {
  const { state } = context
  if (state.phase === "roundScoring" || state.phase === "gameOver") return
  state.phase = "roundScoring"
  state.currentTurnSeat = null
  state.pendingChoice = null
  state.resolutionStack = []
  state.resolutionTasks = []
  state.initialDealSeatsRemaining = []

  for (const player of state.players) {
    const score = calculateRoundScore(player, state.favourOfOlympusPlayerIds.includes(player.id))
    player.totalScore += score
    emit(context, { type: "ROUND_SCORE_AWARDED", playerId: player.id, score })
  }
  state.winnerId = findWinner(state.players, state.config.targetScore)?.id ?? null
}

function advanceRound(context: EngineContext): void {
  const { state } = context
  collectInPlayCards(state)
  const winner = state.players.find((player) => player.id === state.winnerId) ?? null
  if (winner !== null) {
    state.phase = "gameOver"
    emit(context, { type: "GAME_WON", playerId: winner.id, totalScore: winner.totalScore })
    return
  }
  state.dealerSeat = nextSeat(state, state.dealerSeat)
  startRound(context)
}

function collectInPlayCards(state: GameState): void {
  for (const player of state.players) {
    for (const card of player.numberCards) discardOrDestroyNumber(state, card)
    for (const card of player.modifierCards) discardOrDestroyModifier(state, card)
    state.discardPile.push(...player.godCardsInFront)
    player.numberCards = []
    player.modifierCards = []
    player.godEffects = []
    player.godCardsInFront = []
  }
  state.discardPile.push(...state.resolvingCards)
  state.resolvingCards = []
}

function discardPersistentGodCard(
  state: GameState,
  player: PlayerState,
  effect: PersistentGodEffect,
): void {
  if (effect.physicalCardId === null) return
  const index = player.godCardsInFront.findIndex((card) => card.id === effect.physicalCardId)
  const [card] = index >= 0 ? player.godCardsInFront.splice(index, 1) : []
  if (card === undefined) throw new Error("Zeus physical card is missing from its owner")
  state.discardPile.push(card)
}

function discardOrDestroyNumber(state: GameState, instance: NumberInstance): void {
  if (instance.physicalCardId !== null) {
    state.discardPile.push({ id: instance.physicalCardId, kind: "number", value: instance.value })
  }
}

function discardOrDestroyModifier(state: GameState, instance: ModifierInstance): void {
  if (instance.physicalCardId === null) return
  state.discardPile.push(instance.operation === "add"
    ? { id: instance.physicalCardId, kind: "modifier", operation: "add", value: instance.value }
    : { id: instance.physicalCardId, kind: "modifier", operation: "multiply", value: 2 })
}

function moveResolvingToDiscard(state: GameState, cardId: string): void {
  const card = requireResolvingCard(state, cardId)
  removeResolvingCard(state, cardId)
  state.discardPile.push(card)
}

function removeResolvingCard(state: GameState, cardId: string): void {
  const index = state.resolvingCards.findIndex((card) => card.id === cardId)
  if (index < 0) throw new Error(`Resolving card ${cardId} is missing`)
  state.resolvingCards.splice(index, 1)
}

function requireResolvingCard(state: GameState, cardId: string): Card {
  const card = state.resolvingCards.find((candidate) => candidate.id === cardId)
  if (card === undefined) throw new Error(`Resolving card ${cardId} is missing`)
  return card
}

function removeDiscardCard(state: GameState, cardId: string): Card {
  const index = state.discardPile.findIndex((card) => card.id === cardId)
  const [card] = index >= 0 ? state.discardPile.splice(index, 1) : []
  if (card === undefined) invalidChoice("The selected discard card is no longer available")
  return card
}

function removeNumberInstance(player: PlayerState, instanceId: string): NumberInstance {
  const index = player.numberCards.findIndex((card) => card.instanceId === instanceId)
  const [card] = index >= 0 ? player.numberCards.splice(index, 1) : []
  if (card === undefined) invalidChoice("The selected Number Card is no longer owned by that player")
  return card
}

function requireGodFrame(state: GameState, frameId: string): GodResolutionFrame {
  const frame = state.resolutionStack.find(
    (candidate): candidate is GodResolutionFrame => candidate.kind === "god" && candidate.id === frameId,
  )
  if (frame === undefined) throw new Error(`God frame ${frameId} is missing`)
  return frame
}

function popResolutionFrame(state: GameState, frameId: string): void {
  const frame = state.resolutionStack.pop()
  if (frame?.id !== frameId) throw new Error(`Resolution frame ${frameId} completed out of order`)
}

function activePlayers(state: GameState): PlayerState[] {
  return state.players.filter((player) => player.roundStatus === "active")
}

function requireActivePlayer(state: GameState, playerId: string): PlayerState {
  const player = playerById(state, playerId)
  if (player.roundStatus !== "active") invalidChoice("The selected player is no longer active")
  return player
}

function playerById(state: GameState, playerId: string): PlayerState {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (player === undefined) throw new GameRuleError("ACTOR_NOT_FOUND", `Unknown player ${playerId}`)
  return player
}

function playerAtSeat(state: GameState, seat: number): PlayerState {
  const player = state.players.find((candidate) => candidate.seat === seat)
  if (player === undefined) throw new GameRuleError("INVALID_PLAYERS", `No player occupies seat ${seat}`)
  return player
}

function hasPhysicalCardsInFront(player: PlayerState): boolean {
  return player.numberCards.length + player.modifierCards.length + player.godCardsInFront.length > 0
}

function roundShouldEnd(state: GameState): boolean {
  return state.roundEndRequested || activePlayers(state).length === 0
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

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalidChoice("Choice selection must be an array of IDs")
  }
  return value as string[]
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidChoice("Choice selection must be an object")
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown): string {
  if (typeof value !== "string") invalidChoice("Choice field must be an ID")
  return value
}

function requirePlayerInstanceSelection(value: unknown): { playerId: string; instanceId: string } {
  const record = requireRecord(value)
  return { playerId: requireString(record.playerId), instanceId: requireString(record.instanceId) }
}

function validateOwnedSelection(
  eligible: ReadonlyArray<{ readonly playerId: string; readonly instanceIds: readonly string[] }>,
  selected: { readonly playerId: string; readonly instanceId: string },
): void {
  const player = eligible.find((candidate) => candidate.playerId === selected.playerId)
  if (player === undefined || !player.instanceIds.includes(selected.instanceId)) {
    invalidChoice("The selected Number Card is not eligible")
  }
}

function isExactPermutation(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every((id) => right.includes(id))
}

function invalidChoice(message: string): never {
  throw new GameRuleError("INVALID_CHOICE", message)
}
