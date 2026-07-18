import { createServer } from "node:http"
import { Effect } from "effect"
import { Server } from "socket.io"
import type { ClientToServerEvents, ServerToClientEvents } from "@flip-seven/protocol"

const port = 3000

const program = Effect.acquireUseRelease(
  Effect.sync(() => {
    const httpServer = createServer()
    const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
      cors: { origin: "http://localhost:5173" },
    })

    io.on("connection", (socket) => {
      socket.on("system:status", (acknowledge) => {
        acknowledge({ status: "ready" })
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

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
