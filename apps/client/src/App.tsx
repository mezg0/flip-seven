import { useEffect, useState } from "react"
import { io } from "socket.io-client"
import type { CardDefinition } from "@flip-seven/content"
import type { ServerStatus } from "@flip-seven/protocol"
import { GameCard } from "./components/GameCard.tsx"

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000"

const statusDotClassNames: Record<ServerStatus["status"], string> = {
  connecting: "bg-amber-400 shadow-[0_0_0_0.25rem_oklch(0.8_0.13_83/15%)]",
  ready: "bg-emerald-400 shadow-[0_0_0_0.25rem_oklch(0.76_0.18_145/15%)]",
  disconnected: "bg-red-500 shadow-[0_0_0_0.25rem_oklch(0.68_0.2_24/15%)]",
}

const samplePowerCard = {
  kind: "power",
  effectName: "Sudden Reversal",
  deityName: "Hermes",
  description: "Choose any two players. Swap their number cards.",
  typography: {
    deitySize: "small",
    effectSize: "small",
    effectWeight: "medium",
    descriptionSize: "small",
    effectLines: ["Sudden Reversal"],
    descriptionLines: ["Choose any two players.", "Swap their number cards."],
  },
  artwork: "cards/powers/hermes-test.jpg",
  icon: "cards/icons/placeholder.svg",
  theme: "storm",
} satisfies CardDefinition

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
    <main className="min-h-screen bg-night px-5 py-5 text-parchment md:px-14 md:py-14">
      <header className="mx-auto mb-12 flex w-full max-w-[74rem] items-end justify-between gap-8 max-md:flex-col max-md:items-start max-md:mb-10">
        <div>
          <p className="mb-3 text-sm font-bold text-bronze">Flip Seven · Card system</p>
          <h1
            id="page-title"
            className="font-display text-[clamp(2.75rem,7vw,5rem)] leading-none font-bold tracking-[-0.025em] text-balance"
          >
            Mythology,<br />at a glance.
          </h1>
          <p className="mt-5 max-w-[42rem] text-[clamp(1rem,2vw,1.15rem)] leading-relaxed text-slate-400 text-pretty">
            Bold enough for the reveal. Clear enough for the table.
          </p>
        </div>
        <div
          className="flex shrink-0 items-center gap-2.5 text-sm font-bold text-slate-300 capitalize"
          role="status"
          aria-live="polite"
        >
          <span className={`size-2.5 rounded-full ${statusDotClassNames[status.status]}`} />
          Server: {status.status}
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-[74rem] justify-center" aria-labelledby="card-showcase-title">
        <h2 id="card-showcase-title" className="sr-only">
          Power card component
        </h2>
        <div className="grid justify-items-center gap-5">
          <GameCard card={samplePowerCard} size="preview" />
          <p className="m-0 text-xs font-extrabold tracking-[0.1em] text-slate-400 uppercase">Power card</p>
        </div>
      </section>
    </main>
  )
}
