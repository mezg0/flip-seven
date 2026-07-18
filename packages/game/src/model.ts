export type GameRevision = number

export type GamePhase =
  | "lobby"
  | "initialDeal"
  | "awaitingTurnChoice"
  | "awaitingChoice"
  | "resolvingCards"
  | "roundScoring"
  | "gameOver"

export type PlayerRoundStatus = "active" | "stayed" | "busted"

export type GodKind =
  | "zeus"
  | "ares"
  | "dionysus"
  | "athena"
  | "hades"
  | "hermes"
  | "artemis"
  | "aphrodite"
  | "hephaestus"
  | "demeter"
  | "nike"
  | "prometheus"

export const GOD_KINDS: readonly GodKind[] = [
  "zeus",
  "ares",
  "dionysus",
  "athena",
  "hades",
  "hermes",
  "artemis",
  "aphrodite",
  "hephaestus",
  "demeter",
  "nike",
  "prometheus",
]

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

export type GodCard = {
  readonly id: string
  readonly kind: "god"
  readonly god: GodKind
}

export type Card = NumberCard | ModifierCard | GodCard
export type DrawSource = "initialDeal" | "normalDraw" | "ares" | "aphrodite"

export interface NumberInstance {
  readonly instanceId: string
  readonly value: number
  readonly physicalCardId: string | null
  readonly origin: "deck" | "aphrodite"
}

export interface ModifierInstance {
  readonly instanceId: string
  readonly operation: "add" | "multiply"
  readonly value: 2 | 4 | 6 | 8 | 10
  readonly physicalCardId: string | null
  readonly origin: "deck" | "aphrodite" | "hephaestusFallback"
}

export interface PersistentGodEffect {
  readonly effectId: string
  readonly kind: "zeus" | "demeter" | "nike"
  readonly ownerId: string
  readonly physicalCardId: string | null
  readonly grantedBy: GodKind
}

export interface GodResolutionRecord {
  readonly god: GodKind
  readonly controllerId: string
  readonly copiedGod: GodKind | null
  readonly completedAtSequence: number
}

export interface PlayerInput {
  readonly id: string
  readonly name: string
  readonly seat: number
}

export interface PlayerState extends PlayerInput {
  totalScore: number
  roundStatus: PlayerRoundStatus
  numberCards: NumberInstance[]
  modifierCards: ModifierInstance[]
  godEffects: PersistentGodEffect[]
  godCardsInFront: GodCard[]
  lockedRoundScore: number | null
}

interface PendingChoiceBase {
  readonly id: string
  readonly controllerId: string
  readonly godFrameId: string
  readonly god: GodKind
}

export type PendingChoice =
  | PendingChoiceBase & {
    readonly kind: "choosePlayers"
    readonly min: number
    readonly max: number
    readonly eligiblePlayerIds: readonly string[]
    readonly distinct: boolean
  }
  | PendingChoiceBase & {
    readonly kind: "choosePlayerNumber"
    readonly eligible: ReadonlyArray<{ readonly playerId: string; readonly instanceIds: readonly string[] }>
  }
  | PendingChoiceBase & {
    readonly kind: "chooseHermesExchange"
    readonly eligible: ReadonlyArray<{ readonly playerId: string; readonly instanceIds: readonly string[] }>
  }
  | PendingChoiceBase & {
    readonly kind: "chooseDiscardNumber"
    readonly physicalCardIds: readonly string[]
    readonly eligiblePlayerIds: readonly string[]
  }
  | PendingChoiceBase & {
    readonly kind: "chooseDiscardModifier"
    readonly physicalCardIds: readonly string[]
    readonly eligiblePlayerIds: readonly string[]
  }
  | PendingChoiceBase & {
    readonly kind: "reorderDeckTop"
    readonly physicalCardIds: readonly string[]
  }

export interface GodResolutionFrame {
  readonly kind: "god"
  readonly id: string
  readonly god: GodKind
  readonly actualGod: GodKind
  readonly controllerId: string
  readonly physicalCardId: string | null
  readonly canKeepPhysicalCard: boolean
  readonly recordHistory: boolean
}

export interface AresFrame {
  readonly kind: "ares"
  readonly id: string
  readonly godFrameId: string
  readonly controllerId: string
  readonly targetId: string
  cardsRemaining: number
}

export type ResolutionFrame = GodResolutionFrame | AresFrame

export type ResolutionTask =
  | { readonly kind: "reveal"; readonly recipientId: string; readonly source: DrawSource }
  | { readonly kind: "resumeSource"; readonly source: "initialDeal" | "normalDraw" }
  | { readonly kind: "aresContinue"; readonly godFrameId: string; readonly aresFrameId: string }
  | { readonly kind: "finishGod"; readonly godFrameId: string; readonly keepPhysicalCard: boolean; readonly copiedGod: GodKind | null }

export interface GameConfig {
  targetScore: number
  minimumPlayers: number
  maximumPlayers: number
  choiceTimeoutMs: number
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
  | { readonly type: "CHOICE_REQUESTED"; readonly choiceId: string; readonly controllerId: string; readonly god: GodKind; readonly kind: PendingChoice["kind"] }
  | { readonly type: "GOD_RESOLVED"; readonly god: GodKind; readonly controllerId: string; readonly copiedGod: GodKind | null }
  | { readonly type: "ZEUS_TRIGGERED"; readonly playerId: string; readonly duplicateValue: number }
  | { readonly type: "PLAYER_BUSTED"; readonly playerId: string; readonly duplicateValue: number }
  | { readonly type: "PLAYER_STAYED"; readonly playerId: string; readonly score: number }
  | { readonly type: "PLAYER_FORCED_TO_STAY"; readonly targetId: string; readonly score: number }
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
  resolvingCards: Card[]
  roundNumber: number
  initialDealSeatsRemaining: number[]
  pendingChoice: PendingChoice | null
  resolutionStack: ResolutionFrame[]
  resolutionTasks: ResolutionTask[]
  godResolutionHistory: GodResolutionRecord[]
  flipSevenPlayerIds: string[]
  roundEndRequested: boolean
  winnerId: string | null
  eventLog: GameEvent[]
  revision: GameRevision
  randomState: number
  nextSequence: number
  config: GameConfig
}

export type GameCommand =
  | { readonly type: "START_GAME"; readonly actorId: string }
  | { readonly type: "HIT"; readonly actorId: string; readonly expectedRevision: number }
  | { readonly type: "STAY"; readonly actorId: string; readonly expectedRevision: number }
  | {
    readonly type: "SUBMIT_CHOICE"
    readonly actorId: string
    readonly choiceId: string
    readonly selection: unknown
    readonly expectedRevision: number
  }

export type GameRuleErrorCode =
  | "ACTOR_NOT_FOUND"
  | "COMMAND_NOT_ALLOWED"
  | "STALE_REVISION"
  | "NOT_CURRENT_PLAYER"
  | "PLAYER_NOT_ACTIVE"
  | "CANNOT_STAY_WITHOUT_CARDS"
  | "NOT_CHOICE_CONTROLLER"
  | "INVALID_CHOICE"
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

export type PublicPendingChoice = Omit<PendingChoice, "physicalCardIds"> & {
  readonly physicalCardIds?: readonly string[]
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
  readonly pendingChoice: PublicPendingChoice | null
  readonly flipSevenPlayerIds: readonly string[]
  readonly winnerId: string | null
  readonly revision: GameRevision
}
