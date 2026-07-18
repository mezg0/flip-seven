import { createServer } from "node:http"
import { GameRuleError } from "@flip-seven/game"
import {
  GameCommandRequest,
  GameClaimRequest,
  GameCreateRequest,
  GameLookupRequest,
  type ClientToServerEvents,
  type GameCreateResponse,
  type GameClaimResponse,
  type GameProtocolError,
  type GameResponse,
  type ServerToClientEvents,
} from "@flip-seven/protocol"
import { Effect, Schema } from "effect"
import { Server } from "socket.io"
import {
  GameRegistry,
  RegistryError,
  type ClaimedGame,
  type CreatedGame,
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

      io.on("connection", (socket) => {
        socket.on("system:status", (acknowledge) => {
          acknowledge({ status: "ready" })
        })

        socket.on("game:create", (payload, acknowledge) => {
          runEffectRequest(
            Schema.decodeUnknown(GameCreateRequest)(payload).pipe(
              Effect.flatMap((request) => games.create(request.gameId, request.creatorId, request.players)),
            ),
            (error) => acknowledge(failure(error)),
            (created) => {
              void socket.join(created.snapshot.state.id)
              acknowledge(gameCreated(created))
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
            (snapshot) => {
              void socket.join(snapshot.state.id)
              acknowledge({ ok: true, snapshot })
            },
          )
        })

        socket.on("game:command", (payload, acknowledge) => {
          runEffectRequest(
            Schema.decodeUnknown(GameCommandRequest)(payload).pipe(
              Effect.flatMap((request) => games.submit(request.gameId, request.accessToken, request.command)),
            ),
            (error) => acknowledge(failure(error)),
            (snapshot) => {
              io.to(snapshot.state.id).emit("game:snapshot", snapshot)
              acknowledge({ ok: true, snapshot })
            },
          )
        })
      })

      return { httpServer, io }
    }),
    ({ httpServer }) =>
      Effect.async<void, Error>((resume) => {
        httpServer.once("error", (error) => resume(Effect.fail(error)))
        httpServer.listen(port, () => {
          console.log(`Flip Seven server listening on http://localhost:${port}`)
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
