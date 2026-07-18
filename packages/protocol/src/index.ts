import type { GameEvent, GameRuleErrorCode, PublicGameState } from "@flip-seven/game"
import { Schema } from "effect"

export const ServerStatus = Schema.Struct({
  status: Schema.Literal("connecting", "ready", "disconnected"),
})

export type ServerStatus = typeof ServerStatus.Type

const GameId = Schema.NonEmptyString.pipe(Schema.maxLength(128))
const PlayerId = Schema.NonEmptyString.pipe(Schema.maxLength(128))
const PlayerName = Schema.NonEmptyString.pipe(Schema.maxLength(64))
const AccessToken = Schema.NonEmptyString.pipe(Schema.maxLength(256))

const StartGameCommand = Schema.Struct({
  type: Schema.Literal("START_GAME"),
  actorId: PlayerId,
})

const RevisionedActorCommandFields = {
  actorId: PlayerId,
  expectedRevision: Schema.NonNegativeInt,
}

const HitCommand = Schema.Struct({
  type: Schema.Literal("HIT"),
  ...RevisionedActorCommandFields,
})

const StayCommand = Schema.Struct({
  type: Schema.Literal("STAY"),
  ...RevisionedActorCommandFields,
})

const SubmitChoiceCommand = Schema.Struct({
  type: Schema.Literal("SUBMIT_CHOICE"),
  ...RevisionedActorCommandFields,
  choiceId: Schema.NonEmptyString.pipe(Schema.maxLength(128)),
  selection: Schema.Unknown,
})

export const GameCommand = Schema.Union(
  StartGameCommand,
  HitCommand,
  StayCommand,
  SubmitChoiceCommand,
)

export type GameCommand = typeof GameCommand.Type

export const GameCreateRequest = Schema.Struct({
  gameId: GameId,
  creatorId: PlayerId,
  creatorName: PlayerName,
})

export type GameCreateRequest = typeof GameCreateRequest.Type

export const GameJoinRequest = Schema.Struct({
  gameId: GameId,
  playerId: PlayerId,
  playerName: PlayerName,
})

export type GameJoinRequest = typeof GameJoinRequest.Type

export const GameClaimRequest = Schema.Struct({
  gameId: GameId,
  playerId: PlayerId,
  invitationToken: AccessToken,
})

export type GameClaimRequest = typeof GameClaimRequest.Type

export const GameLookupRequest = Schema.Struct({
  gameId: GameId,
  accessToken: AccessToken,
})

export type GameLookupRequest = typeof GameLookupRequest.Type

export const GameEndRequest = Schema.Struct({
  gameId: GameId,
  accessToken: AccessToken,
})

export type GameEndRequest = typeof GameEndRequest.Type

export const GameCommandRequest = Schema.Struct({
  gameId: GameId,
  accessToken: AccessToken,
  command: GameCommand,
})

export type GameCommandRequest = typeof GameCommandRequest.Type

export type GameProtocolErrorCode =
  | GameRuleErrorCode
  | "INVALID_PAYLOAD"
  | "GAME_NOT_FOUND"
  | "GAME_ALREADY_EXISTS"
  | "UNAUTHORIZED"
  | "LOBBY_FULL"
  | "LOBBY_CLOSED"
  | "PLAYER_ALREADY_JOINED"

export type GameProtocolError = {
  readonly code: GameProtocolErrorCode
  readonly message: string
}

export type GameSnapshot = {
  readonly state: PublicGameState
  readonly events: readonly GameEvent[]
}

export type GameResponse =
  | { readonly ok: true; readonly snapshot: GameSnapshot }
  | { readonly ok: false; readonly error: GameProtocolError }

export type GameEndResponse =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: GameProtocolError }

export type PlayerCredential = {
  readonly playerId: string
  readonly accessToken: string
}

export type PlayerInvitation = {
  readonly playerId: string
  readonly invitationToken: string
}

export type GameCreateResponse =
  | {
    readonly ok: true
    readonly snapshot: GameSnapshot
    readonly credential: PlayerCredential
    readonly invitations: readonly PlayerInvitation[]
  }
  | { readonly ok: false; readonly error: GameProtocolError }

export type GameClaimResponse =
  | { readonly ok: true; readonly snapshot: GameSnapshot; readonly credential: PlayerCredential }
  | { readonly ok: false; readonly error: GameProtocolError }

export interface ClientToServerEvents {
  "system:status": (acknowledge: (status: ServerStatus) => void) => void
  "game:create": (payload: unknown, acknowledge: (response: GameCreateResponse) => void) => void
  "game:join": (payload: unknown, acknowledge: (response: GameClaimResponse) => void) => void
  "game:claim": (payload: unknown, acknowledge: (response: GameClaimResponse) => void) => void
  "game:get": (payload: unknown, acknowledge: (response: GameResponse) => void) => void
  "game:end": (payload: unknown, acknowledge: (response: GameEndResponse) => void) => void
  "game:command": (payload: unknown, acknowledge: (response: GameResponse) => void) => void
}

export interface ServerToClientEvents {
  "game:snapshot": (snapshot: GameSnapshot) => void
  "game:ended": () => void
}
