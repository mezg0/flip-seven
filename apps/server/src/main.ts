import { createServer } from "node:http"
import { GameRuleError } from "@favour-of-olympus/game"
import {
  GameCommandRequest,
  GameClaimRequest,
  GameCreateRequest,
  GameEndRequest,
  GameJoinRequest,
  GameLookupRequest,
  type ClientToServerEvents,
  type GameCreateResponse,
  type GameClaimResponse,
  type GameProtocolError,
  type GameResponse,
  type ServerToClientEvents,
} from "@favour-of-olympus/protocol"
import { Effect, Schema } from "effect"
import { Server } from "socket.io"
import {
  GameRegistry,
  RegistryError,
  type AccessedGame,
  type ClaimedGame,
  type CreatedGame,
  type SubmittedGame,
} from "./game-registry.js"

const port = Number(process.env.PORT ?? 3000)
const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173"

const program = Effect.gen(function*() {
  const games = yield* GameRegistry.make()

  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const httpServer = createServer()
      const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
        cors: { origin: clientOrigin },
      })
      const socketPlayers = new Map<string, Map<string, string>>()

      io.on("connection", (socket) => {
        socketPlayers.set(socket.id, new Map())
        socket.on("system:status", (acknowledge) => {
          acknowledge({ status: "ready" })
        })

        socket.on("game:create", (payload, acknowledge) => {
          runEffectRequest(
            Schema.decodeUnknown(GameCreateRequest)(payload).pipe(
              Effect.flatMap((request) => games.create(request.gameId, request.creatorId, request.creatorName)),
            ),
            (error) => acknowledge(failure(error)),
            (created) => {
              bindSocketPlayer(socketPlayers, socket.id, created.snapshot.state.id, created.credential.playerId)
              void socket.join(created.snapshot.state.id)
              acknowledge(gameCreated(created))
            },
          )
        })

        socket.on("game:join", (payload, acknowledge) => {
          runEffectRequest(
            Schema.decodeUnknown(GameJoinRequest)(payload).pipe(
              Effect.flatMap((request) => games.join(request.gameId, request.playerId, request.playerName)),
            ),
            (error) => acknowledge(failure(error)),
            (joined) => {
              void socket.join(joined.snapshot.state.id)
              io.to(joined.snapshot.state.id).emit("game:snapshot", joined.snapshot)
              acknowledge(gameClaimed(joined))
            },
          )
        })

        socket.on("game:claim", (payload, acknowledge) => {
          runEffectRequest(
            Schema.decodeUnknown(GameClaimRequest)(payload).pipe(
              Effect.flatMap((request) => games.claim(
                request.gameId,
                request.playerId,
                request.invitationToken,
              )),
            ),
            (error) => acknowledge(failure(error)),
            (claimed) => {
              bindSocketPlayer(socketPlayers, socket.id, claimed.snapshot.state.id, claimed.credential.playerId)
              void socket.join(claimed.snapshot.state.id)
              acknowledge(gameClaimed(claimed))
            },
          )
        })

        socket.on("game:get", (payload, acknowledge) => {
          runEffectRequest(
            Schema.decodeUnknown(GameLookupRequest)(payload).pipe(
              Effect.flatMap((request) => games.get(request.gameId, request.accessToken)),
            ),
            (error) => acknowledge(failure(error)),
            (accessed) => {
              bindSocketPlayer(socketPlayers, socket.id, accessed.snapshot.state.id, accessed.playerId)
              void socket.join(accessed.snapshot.state.id)
              acknowledge(gameAccessed(accessed))
            },
          )
        })

        socket.on("game:end", (payload, acknowledge) => {
          runEffectRequest(
            Schema.decodeUnknown(GameEndRequest)(payload).pipe(
              Effect.flatMap((request) => games.end(request.gameId, request.accessToken).pipe(
                Effect.as(request.gameId),
              )),
            ),
            (error) => acknowledge(failure(error)),
            (gameId) => {
              io.to(gameId).emit("game:ended")
              acknowledge({ ok: true })
            },
          )
        })

        socket.on("game:command", (payload, acknowledge) => {
          runEffectRequest(
            Schema.decodeUnknown(GameCommandRequest)(payload).pipe(
              Effect.flatMap((request) => games.submit(request.gameId, request.accessToken, request.command)),
            ),
            (error) => acknowledge(failure(error)),
            (submitted) => {
              broadcastSubmittedGame(io, socketPlayers, submitted)
              acknowledge({ ok: true, snapshot: submitted.snapshot })
            },
          )
        })

        socket.on("disconnect", () => {
          socketPlayers.delete(socket.id)
        })
      })

      return { httpServer, io }
    }),
    ({ httpServer }) =>
      Effect.async<void, Error>((resume) => {
        httpServer.once("error", (error) => resume(Effect.fail(error)))
        httpServer.listen(port, () => {
          console.log(`Favour of Olympus server listening on http://localhost:${port}`)
        })
      }),
    ({ httpServer, io }) =>
      Effect.sync(() => {
        io.close()
        httpServer.close()
      }),
  )
})

function runEffectRequest<Result, ErrorType>(
  request: Effect.Effect<Result, ErrorType>,
  onFailure: (error: ErrorType) => void,
  onSuccess: (result: Result) => void,
): void {
  Effect.runFork(request.pipe(
    Effect.match({
      onFailure,
      onSuccess,
    }),
  ))
}

function gameCreated(created: CreatedGame): GameCreateResponse {
  return {
    ok: true,
    snapshot: created.snapshot,
    credential: created.credential,
    invitations: created.invitations,
  }
}

function gameClaimed(claimed: ClaimedGame): GameClaimResponse {
  return { ok: true, snapshot: claimed.snapshot, credential: claimed.credential }
}

function gameAccessed(accessed: AccessedGame): GameResponse {
  return { ok: true, snapshot: accessed.snapshot }
}

function bindSocketPlayer(
  socketPlayers: Map<string, Map<string, string>>,
  socketId: string,
  gameId: string,
  playerId: string,
): void {
  socketPlayers.get(socketId)?.set(gameId, playerId)
}

function broadcastSubmittedGame(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  socketPlayers: ReadonlyMap<string, ReadonlyMap<string, string>>,
  submitted: SubmittedGame,
): void {
  const gameId = submitted.publicSnapshot.state.id
  for (const socketId of io.sockets.adapter.rooms.get(gameId) ?? []) {
    const playerId = socketPlayers.get(socketId)?.get(gameId)
    const recipient = io.sockets.sockets.get(socketId)
    if (playerId === undefined || recipient === undefined) continue
    const snapshot = playerId === submitted.privateSnapshot?.playerId
      ? submitted.privateSnapshot.snapshot
      : submitted.publicSnapshot
    recipient.emit("game:snapshot", snapshot)
  }
}

function failure(error: unknown): Extract<GameResponse, { readonly ok: false }> {
  if (error instanceof GameRuleError || error instanceof RegistryError) {
    const protocolError: GameProtocolError = { code: error.code, message: error.message }
    return { ok: false, error: protocolError }
  }
  return { ok: false, error: { code: "INVALID_PAYLOAD", message: String(error) } }
}

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
