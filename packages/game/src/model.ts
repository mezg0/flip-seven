export type GameRevision = number

export type GamePhase =
  | "lobby"
  | "initialDeal"
  | "awaitingTurnChoice"
  | "awaitingActionTarget"
  | "resolvingCards"
  | "roundScoring"
  | "gameOver"

export type PlayerRoundStatus = "active" | "stayed" | "frozen" | "busted"

export type NumberCard = {
  readonly id: string
  readonly kind: "number"
  readonly value: number
}

export type AddModifierCard = {
  readonly id: string
  readonly kind: "modifier"
  readonly operation: "add"
  readonly value: 2 | 4 | 6 | 8 | 10
}

export type MultiplyModifierCard = {
  readonly id: string
  readonly kind: "modifier"
  readonly operation: "multiply"
  readonly value: 2
}

export type ModifierCard = AddModifierCard | MultiplyModifierCard

export type ActionCard = {
  readonly id: string
  readonly kind: "action"
  readonly action: "freeze" | "flipThree" | "secondChance"
}

export type Card = NumberCard | ModifierCard | ActionCard
export type DrawSource = "initialDeal" | "normalDraw" | "flipThree"

export interface PlayerInput {
  readonly id: string
  readonly name: string
  readonly seat: number
}

export interface PlayerState extends PlayerInput {
  totalScore: number
  roundStatus: PlayerRoundStatus
  numberCards: NumberCard[]
  modifierCards: ModifierCard[]
  hasSecondChance: boolean
  actionCardsInFront: ActionCard[]
  lockedRoundScore: number | null
}

export type PendingActionKind = "freeze" | "flipThree" | "secondChanceTransfer"

export interface PendingAction {
  cardId: string
  action: PendingActionKind
  chooserId: string
  targetId: string | null
  source: DrawSource
}

export interface FlipThreeContext {
  targetId: string
  cardsRemaining: number
  queuedActions: PendingAction[]
  source: DrawSource
}

export interface GameConfig {
  targetScore: number
  minimumPlayers: number
  maximumPlayers: number
  actionChoiceTimeoutMs: number
  turnChoiceTimeoutMs: number
  disconnectedPlayerPolicy: "pause" | "autoStay" | "bot"
}

export const defaultGameConfig: GameConfig = {
  targetScore: 200,
  minimumPlayers: 3,
  maximumPlayers: 4,
  actionChoiceTimeoutMs: 30_000,
  turnChoiceTimeoutMs: 30_000,
  disconnectedPlayerPolicy: "pause",
}

export type GameEvent =
  | { readonly type: "ROUND_STARTED"; readonly round: number; readonly dealerId: string }
  | { readonly type: "CARD_REVEALED"; readonly recipientId: string; readonly card: Card; readonly source: DrawSource }
  | { readonly type: "ACTION_TARGET_REQUESTED"; readonly chooserId: string; readonly action: PendingActionKind; readonly eligibleTargetIds: string[] }
  | { readonly type: "ACTION_TARGETED"; readonly chooserId: string; readonly targetId: string; readonly action: PendingActionKind }
  | { readonly type: "SECOND_CHANCE_USED"; readonly playerId: string; readonly duplicateValue: number }
  | { readonly type: "PLAYER_BUSTED"; readonly playerId: string; readonly duplicateValue: number }
  | { readonly type: "PLAYER_STAYED"; readonly playerId: string; readonly score: number }
  | { readonly type: "PLAYER_FROZEN"; readonly targetId: string; readonly score: number }
  | { readonly type: "FLIP_THREE_STARTED"; readonly targetId: string }
  | { readonly type: "FLIP_SEVEN_ACHIEVED"; readonly playerId: string }
  | { readonly type: "TURN_STARTED"; readonly playerId: string }
  | { readonly type: "ROUND_SCORE_AWARDED"; readonly playerId: string; readonly score: number }
  | { readonly type: "DECK_RESHUFFLED" }
  | { readonly type: "GAME_WON"; readonly playerId: string; readonly totalScore: number }

export interface GameState {
  id: string
  phase: GamePhase
  players: PlayerState[]
  dealerSeat: number
  currentTurnSeat: number | null
  drawPile: Card[]
  discardPile: Card[]
  roundNumber: number
  initialDealSeatsRemaining: number[]
  pendingAction: PendingAction | null
  flipThreeStack: FlipThreeContext[]
  flipSevenPlayerId: string | null
  winnerId: string | null
  eventLog: GameEvent[]
  revision: GameRevision
  randomState: number
  config: GameConfig
}

export type GameCommand =
  | { readonly type: "START_GAME"; readonly actorId: string }
  | { readonly type: "HIT"; readonly actorId: string; readonly expectedRevision: number }
  | { readonly type: "STAY"; readonly actorId: string; readonly expectedRevision: number }
  | { readonly type: "SELECT_ACTION_TARGET"; readonly actorId: string; readonly targetId: string; readonly expectedRevision: number }

export type GameRuleErrorCode =
  | "ACTOR_NOT_FOUND"
  | "COMMAND_NOT_ALLOWED"
  | "STALE_REVISION"
  | "NOT_CURRENT_PLAYER"
  | "PLAYER_NOT_ACTIVE"
  | "CANNOT_STAY_WITHOUT_CARDS"
  | "NOT_ACTION_CHOOSER"
  | "INVALID_ACTION_TARGET"
  | "NOT_ENOUGH_PLAYERS"
  | "INVALID_PLAYERS"
  | "NO_DRAWABLE_CARDS"

export class GameRuleError extends Error {
  readonly code: GameRuleErrorCode

  constructor(code: GameRuleErrorCode, message: string) {
    super(message)
    this.name = "GameRuleError"
    this.code = code
  }
}

export type ApplyCommandResult = {
  readonly nextState: GameState
  readonly events: GameEvent[]
}

export interface PublicGameState {
  readonly id: string
  readonly phase: GamePhase
  readonly players: readonly PlayerState[]
  readonly dealerSeat: number
  readonly currentTurnSeat: number | null
  readonly remainingCardCount: number
  readonly discardCount: number
  readonly roundNumber: number
  readonly pendingAction: PendingAction | null
  readonly flipSevenPlayerId: string | null
  readonly winnerId: string | null
  readonly revision: GameRevision
}
