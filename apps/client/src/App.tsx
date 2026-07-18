import { useEffect, useState } from "react"
import { io } from "socket.io-client"
import type { ServerStatus } from "@flip-seven/protocol"

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000"

export function App() {
  const [status, setStatus] = useState<ServerStatus>({ status: "connecting" })

  useEffect(() => {
    const socket = io(serverUrl)

    socket.on("connect", () => {
      socket.emit("system:status", (nextStatus: ServerStatus) => {
        setStatus(nextStatus)
      })
    })
    socket.on("disconnect", () => {
      setStatus({ status: "disconnected" })
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Online multiplayer</p>
        <h1 id="page-title">Flip Seven</h1>
        <p className="lede">
          The monorepo foundation is ready. Game rooms, rules, and artwork slot
          into their own packages as the product takes shape.
        </p>
        <div className="status" role="status" aria-live="polite">
          <span className={`status-dot status-dot--${status.status}`} />
          Server: {status.status}
        </div>
      </section>
    </main>
  )
}
