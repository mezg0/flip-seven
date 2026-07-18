import { randomUUID } from "node:crypto"
import {
  GameRuleError,
  addPlayerToLobby,
  applyCommand,
  createGame,
  toPublicGameState,
  type GameCommand,
  type GameEvent,
  type GameState,
  type PlayerInput,
} from "@favour-of-olympus/game"
import type { GameSnapshot, PlayerCredential, PlayerInvitation } from "@favour-of-olympus/protocol"
import { Data, Effect, SynchronizedRef } from "effect"

export type RegistryErrorCode =
  | "GAME_NOT_FOUND"
  | "GAME_ALREADY_EXISTS"
  | "UNAUTHORIZED"
  | "LOBBY_FULL"
  | "LOBBY_CLOSED"
  | "PLAYER_ALREADY_JOINED"

export class RegistryError extends Data.TaggedError("RegistryError")<{
  readonly code: RegistryErrorCode
  readonly message: string
}> {}

export interface CreatedGame {
  readonly snapshot: GameSnapshot
  readonly credential: PlayerCredential
  readonly invitations: readonly PlayerInvitation[]
}

export interface ClaimedGame {
  readonly snapshot: GameSnapshot
  readonly credential: PlayerCredential
}

export interface AccessedGame {
  readonly playerId: string
  readonly snapshot: GameSnapshot
}

export interface SubmittedGame {
  readonly snapshot: GameSnapshot
  readonly publicSnapshot: GameSnapshot
  readonly privateSnapshot: { readonly playerId: string; readonly snapshot: GameSnapshot } | null
}

interface RegisteredGame {
  readonly state: GameState
  readonly playersByAccessToken: ReadonlyMap<string, string>
  readonly playersByInvitationToken: ReadonlyMap<string, string>
}

interface InitialAccess {
  readonly credential: PlayerCredential
  readonly invitations: readonly PlayerInvitation[]
  readonly playersByAccessToken: ReadonlyMap<string, string>
  readonly playersByInvitationToken: ReadonlyMap<string, string>
}

export class GameRegistry {
  readonly #games: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, RegisteredGame>>
  readonly #createSeed: () => string
  readonly #createSecret: () => string

  private constructor(
    games: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, RegisteredGame>>,
    createSeed: () => string,
    createSecret: () => string,
  ) {
    this.#games = games
    this.#createSeed = createSeed
    this.#createSecret = createSecret
  }

  static make(
    createSeed: () => string = randomUUID,
    createSecret: () => string = randomUUID,
  ): Effect.Effect<GameRegistry> {
    return SynchronizedRef.make<ReadonlyMap<string, RegisteredGame>>(new Map()).pipe(
      Effect.map((games) => new GameRegistry(games, createSeed, createSecret)),
    )
  }

  create(
    gameId: string,
    creatorId: string,
    creatorName: string,
  ): Effect.Effect<CreatedGame, RegistryError | GameRuleError> {
    return SynchronizedRef.modifyEffect<
      ReadonlyMap<string, RegisteredGame>,
      CreatedGame,
      RegistryError | GameRuleError,
      never
    >(this.#games, (games) => {
      if (games.has(gameId)) {
        return Effect.fail(new RegistryError({
          code: "GAME_ALREADY_EXISTS",
          message: `Game ${gameId} already exists`,
        }))
      }
      const players: readonly PlayerInput[] = [{ id: creatorId, name: creatorName, seat: 0 }]

      return attemptGameOperation(() => createGame(gameId, players, this.#createSeed())).pipe(
        Effect.map((state) => {
          const initialAccess = createInitialAccess(players, creatorId, this.#createSecret)
          const registered: RegisteredGame = {
            state,
            playersByAccessToken: initialAccess.playersByAccessToken,
            playersByInvitationToken: initialAccess.playersByInvitationToken,
          }
          const nextGames = new Map(games)
          nextGames.set(gameId, registered)
          return [{
            snapshot: snapshot(state, [], creatorId),
            credential: initialAccess.credential,
            invitations: initialAccess.invitations,
          }, nextGames] as const
        }),
      )
    })
  }

  join(
    gameId: string,
    playerId: string,
    playerName: string,
  ): Effect.Effect<ClaimedGame, RegistryError | GameRuleError> {
    return SynchronizedRef.modifyEffect<
      ReadonlyMap<string, RegisteredGame>,
      ClaimedGame,
      RegistryError | GameRuleError,
      never
    >(this.#games, (games) => {
      const game = games.get(gameId)
      if (game === undefined) return Effect.fail(gameNotFound(gameId))
      if (game.state.phase !== "lobby") {
        return Effect.fail(new RegistryError({ code: "LOBBY_CLOSED", message: "This game has already started" }))
      }
      if (game.state.players.some((player) => player.id === playerId)) {
        return Effect.fail(new RegistryError({ code: "PLAYER_ALREADY_JOINED", message: "This player has already joined the lobby" }))
      }
      if (game.state.players.length >= game.state.config.maximumPlayers) {
        return Effect.fail(new RegistryError({ code: "LOBBY_FULL", message: "This lobby already has four players" }))
      }

      return attemptGameOperation(() => addPlayerToLobby(game.state, { id: playerId, name: playerName })).pipe(
        Effect.map((state) => {
          const usedSecrets = new Set([...game.playersByAccessToken.keys(), ...game.playersByInvitationToken.keys()])
          const accessToken = createUniqueSecret(this.#createSecret, usedSecrets)
          const playersByAccessToken = new Map(game.playersByAccessToken)
          playersByAccessToken.set(accessToken, playerId)
          const nextGames = new Map(games)
          nextGames.set(gameId, { ...game, state, playersByAccessToken })
          return [{ snapshot: snapshot(state, []), credential: { playerId, accessToken } }, nextGames] as const
        }),
      )
    })
  }

  claim(
    gameId: string,
    playerId: string,
    invitationToken: string,
  ): Effect.Effect<ClaimedGame, RegistryError> {
    return SynchronizedRef.modifyEffect<
      ReadonlyMap<string, RegisteredGame>,
      ClaimedGame,
      RegistryError,
      never
    >(this.#games, (games) => {
      const game = games.get(gameId)
      if (game === undefined) {
        return Effect.fail(gameNotFound(gameId))
      }
      if (game.playersByInvitationToken.get(invitationToken) !== playerId) {
        return Effect.fail(unauthorized())
      }

      const usedSecrets = new Set([
        ...game.playersByAccessToken.keys(),
        ...game.playersByInvitationToken.keys(),
      ])
      const accessToken = createUniqueSecret(this.#createSecret, usedSecrets)
      const playersByAccessToken = new Map(game.playersByAccessToken)
      const playersByInvitationToken = new Map(game.playersByInvitationToken)
      playersByAccessToken.set(accessToken, playerId)
      playersByInvitationToken.delete(invitationToken)

      const nextGames = new Map(games)
      nextGames.set(gameId, { ...game, playersByAccessToken, playersByInvitationToken })
      return Effect.succeed([{
        snapshot: snapshot(game.state, [], playerId),
        credential: { playerId, accessToken },
      }, nextGames] as const)
    })
  }

  get(gameId: string, accessToken: string): Effect.Effect<AccessedGame, RegistryError> {
    return SynchronizedRef.get(this.#games).pipe(
      Effect.flatMap((games) => {
        const game = games.get(gameId)
        if (game === undefined) {
          return Effect.fail(gameNotFound(gameId))
        }
        const playerId = game.playersByAccessToken.get(accessToken)
        return playerId === undefined
          ? Effect.fail(unauthorized())
          : Effect.succeed({ playerId, snapshot: snapshot(game.state, [], playerId) })
      }),
    )
  }

  end(gameId: string, accessToken: string): Effect.Effect<void, RegistryError> {
    return SynchronizedRef.modifyEffect(this.#games, (games) => {
      const game = games.get(gameId)
      if (game === undefined) return Effect.fail(gameNotFound(gameId))
      const playerId = game.playersByAccessToken.get(accessToken)
      const host = game.state.players.find((player) => player.seat === 0)
      if (playerId === undefined || playerId !== host?.id) {
        return Effect.fail(new RegistryError({ code: "UNAUTHORIZED", message: "Only the host can end this game" }))
      }
      const nextGames = new Map(games)
      nextGames.delete(gameId)
      return Effect.succeed([undefined, nextGames] as const)
    })
  }

  submit(
    gameId: string,
    accessToken: string,
    command: GameCommand,
  ): Effect.Effect<SubmittedGame, RegistryError | GameRuleError> {
    return SynchronizedRef.modifyEffect<
      ReadonlyMap<string, RegisteredGame>,
      SubmittedGame,
      RegistryError | GameRuleError,
      never
    >(this.#games, (games) => {
      const game = games.get(gameId)
      if (game === undefined) {
        return Effect.fail(gameNotFound(gameId))
      }
      const authenticatedPlayerId = game.playersByAccessToken.get(accessToken)
      if (authenticatedPlayerId === undefined || authenticatedPlayerId !== command.actorId) {
        return Effect.fail(unauthorized())
      }

      return attemptGameOperation(() => applyCommand(game.state, command)).pipe(
        Effect.map((result) => {
          const nextGames = new Map(games)
          nextGames.set(gameId, { ...game, state: result.nextState })
          const publicSnapshot = snapshot(result.nextState, result.events)
          const privateChoice = result.nextState.pendingChoice?.kind === "reorderDeckTop"
            ? result.nextState.pendingChoice
            : null
          const privateSnapshot = privateChoice === null
            ? null
            : {
              playerId: privateChoice.controllerId,
              snapshot: snapshot(result.nextState, result.events, privateChoice.controllerId),
            }
          return [{
            snapshot: authenticatedPlayerId === privateSnapshot?.playerId
              ? privateSnapshot.snapshot
              : publicSnapshot,
            publicSnapshot,
            privateSnapshot,
          }, nextGames] as const
        }),
      )
    })
  }
}

function createInitialAccess(
  players: readonly PlayerInput[],
  creatorId: string,
  createSecret: () => string,
): InitialAccess {
  const usedSecrets = new Set<string>()
  const creatorAccessToken = createUniqueSecret(createSecret, usedSecrets)
  const invitations = players
    .filter((player) => player.id !== creatorId)
    .map((player) => ({
      playerId: player.id,
      invitationToken: createUniqueSecret(createSecret, usedSecrets),
    }))

  return {
    credential: { playerId: creatorId, accessToken: creatorAccessToken },
    invitations,
    playersByAccessToken: new Map([[creatorAccessToken, creatorId]]),
    playersByInvitationToken: new Map(
      invitations.map(({ playerId, invitationToken }) => [invitationToken, playerId]),
    ),
  }
}

function createUniqueSecret(createSecret: () => string, usedSecrets: Set<string>): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const secret = createSecret()
    if (!usedSecrets.has(secret)) {
      usedSecrets.add(secret)
      return secret
    }
  }
  throw new Error("Unable to generate a unique player credential")
}

function gameNotFound(gameId: string): RegistryError {
  return new RegistryError({ code: "GAME_NOT_FOUND", message: `Game ${gameId} does not exist` })
}

function unauthorized(): RegistryError {
  return new RegistryError({ code: "UNAUTHORIZED", message: "This player credential cannot access the game" })
}

function attemptGameOperation<Result>(operation: () => Result): Effect.Effect<Result, GameRuleError> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(operation())
    } catch (error: unknown) {
      return error instanceof GameRuleError ? Effect.fail(error) : Effect.die(error)
    }
  })
}

function snapshot(state: GameState, events: readonly GameEvent[], viewerId?: string): GameSnapshot {
  return { state: toPublicGameState(state, viewerId), events }
}
