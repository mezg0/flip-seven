import { useEffect, useMemo, useState } from "react"
import { io } from "socket.io-client"
import type {
  GameClaimResponse,
  GameCreateResponse,
  GameEndResponse,
  GameResponse,
  GameSnapshot,
  ServerStatus,
} from "@flip-seven/protocol"

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000"
const maximumPlayers = 4

type StoredSession = {
  readonly gameId: string
  readonly playerId: string
  readonly accessToken: string
}

const statusDotClassNames: Record<ServerStatus["status"], string> = {
  connecting: "bg-amber-400",
  ready: "bg-emerald-400",
  disconnected: "bg-red-500",
}

export function App() {
  const [status, setStatus] = useState<ServerStatus>({ status: "connecting" })
  const [socket, setSocket] = useState<ReturnType<typeof io> | null>(null)
  const [username, setUsername] = useState("")
  const [roomCode, setRoomCode] = useState("")
  const [session, setSession] = useState<StoredSession | null>(() => readSession())
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    const nextSocket = io(serverUrl)
    setSocket(nextSocket)
    nextSocket.on("connect", () => setStatus({ status: "ready" }))
    nextSocket.on("disconnect", () => setStatus({ status: "disconnected" }))
    nextSocket.on("game:snapshot", setSnapshot)
    nextSocket.on("game:ended", clearGame)

    return () => nextSocket.disconnect()
  }, [])

  useEffect(() => {
    if (socket === null || status.status !== "ready" || session === null) return
    socket.emit("game:get", { gameId: session.gameId, accessToken: session.accessToken }, (response: GameResponse) => {
      if (response.ok) setSnapshot(response.snapshot)
    })
  }, [session, socket, status.status])

  const playerId = useMemo(() => toPlayerId(username), [username])
  const isHost = snapshot?.state.players[0]?.id === session?.playerId
  const canStart = isHost && snapshot !== null && snapshot.state.players.length >= 3

  function remember(gameId: string, playerId: string, accessToken: string) {
    const nextSession = { gameId, playerId, accessToken }
    sessionStorage.setItem("flip-seven-session", JSON.stringify(nextSession))
    setSession(nextSession)
  }

  function clearGame() {
    sessionStorage.removeItem("flip-seven-session")
    setSession(null)
    setSnapshot(null)
    setError(null)
  }

  function createLobby() {
    if (socket === null || !validUsername(username)) return
    setIsSubmitting(true)
    setError(null)
    const gameId = makeRoomCode()
    socket.emit("game:create", { gameId, creatorId: playerId, creatorName: username.trim() }, (response: GameCreateResponse) => {
      setIsSubmitting(false)
      if (!response.ok) return setError(response.error.message)
      remember(gameId, response.credential.playerId, response.credential.accessToken)
      setSnapshot(response.snapshot)
    })
  }

  function joinLobby() {
    if (socket === null || !validUsername(username) || roomCode.trim().length === 0) return
    setIsSubmitting(true)
    setError(null)
    const gameId = roomCode.trim().toUpperCase()
    socket.emit("game:join", { gameId, playerId, playerName: username.trim() }, (response: GameClaimResponse) => {
      setIsSubmitting(false)
      if (!response.ok) return setError(response.error.message)
      remember(gameId, response.credential.playerId, response.credential.accessToken)
      setSnapshot(response.snapshot)
    })
  }

  function startGame() {
    if (socket === null || session === null || snapshot === null || !canStart) return
    setError(null)
    socket.emit("game:command", {
      gameId: session.gameId,
      accessToken: session.accessToken,
      command: { type: "START_GAME", actorId: session.playerId },
    }, (response: GameResponse) => {
      if (!response.ok) setError(response.error.message)
    })
  }

  function endGame() {
    if (socket === null || session === null || !window.confirm("End this game for everyone?")) return
    socket.emit("game:end", { gameId: session.gameId, accessToken: session.accessToken }, (response: GameEndResponse) => {
      if (!response.ok) setError(response.error.message)
    })
  }

  function submitGameCommand(type: "HIT" | "STAY" | "SELECT_ACTION_TARGET", targetId?: string) {
    if (socket === null || session === null || snapshot === null) return
    setError(null)
    const command = type === "SELECT_ACTION_TARGET"
      ? { type, actorId: session.playerId, targetId: targetId ?? "", expectedRevision: snapshot.state.revision }
      : { type, actorId: session.playerId, expectedRevision: snapshot.state.revision }
    socket.emit("game:command", { gameId: session.gameId, accessToken: session.accessToken, command }, (response: GameResponse) => {
      if (!response.ok) setError(response.error.message)
    })
  }

  if (snapshot !== null) {
    return snapshot.state.phase === "lobby"
      ? <Lobby snapshot={snapshot} roomCode={session?.gameId ?? ""} isHost={isHost} canStart={canStart} error={error} onStart={startGame} onEnd={endGame} />
      : <GameTable snapshot={snapshot} playerId={session?.playerId ?? ""} isHost={isHost} error={error} onCommand={submitGameCommand} onEnd={endGame} />
  }

  const usernameInvalid = username.length > 0 && !validUsername(username)
  return (
    <main className="min-h-screen bg-night px-5 py-7 text-parchment md:px-10 md:py-10">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-5">
        <div className="font-display text-2xl font-bold tracking-[-0.02em]">Flip Seven</div>
        <div className="flex items-center gap-2 text-sm text-slate-300" role="status" aria-live="polite">
          <span className={`size-2 rounded-full ${statusDotClassNames[status.status]}`} />
          {status.status === "ready" ? "Connected" : status.status}
        </div>
      </header>

      <section className="mx-auto grid min-h-[calc(100vh-7rem)] w-full max-w-5xl place-items-center py-12" aria-labelledby="lobby-title">
        <div className="w-full max-w-xl">
          <p className="mb-3 text-sm font-bold text-bronze">A game for three or four</p>
          <h1 id="lobby-title" className="font-display text-5xl font-bold leading-[0.95] tracking-[-0.03em] text-balance md:text-6xl">
            Gather your gods.
          </h1>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-slate-300">
            Pick a username, then create a room or enter a friend’s room code.
          </p>

          <label className="mt-10 block text-sm font-bold text-slate-200" htmlFor="username">
            Your username
          </label>
          <input id="username" value={username} onChange={(event) => setUsername(event.target.value)} maxLength={64} autoComplete="nickname" placeholder="e.g. Athena" className="mt-2 w-full rounded-xl border border-slate-600 bg-slate-950 px-4 py-3 text-base text-white outline-none transition focus:border-bronze focus:ring-2 focus:ring-bronze/30" />
          {usernameInvalid && <p className="mt-2 text-sm text-red-300">Use 2–64 letters, numbers, spaces, hyphens, or underscores.</p>}

          <div className="mt-7 grid gap-4 sm:grid-cols-2">
            <button type="button" onClick={createLobby} disabled={isSubmitting || status.status !== "ready" || !validUsername(username)} className="rounded-xl bg-bronze px-5 py-4 text-left font-bold text-night transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-bronze focus:ring-offset-2 focus:ring-offset-night disabled:cursor-not-allowed disabled:opacity-45">
              Create a lobby
              <span className="mt-1 block text-sm font-medium text-night/75">You’ll receive a room code to share.</span>
            </button>
            <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
              <label className="sr-only" htmlFor="room-code">Room code</label>
              <input id="room-code" value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} maxLength={24} placeholder="ROOM CODE" className="w-full bg-transparent px-2 py-1.5 text-sm font-bold tracking-[0.08em] text-white outline-none placeholder:text-slate-400" />
              <button type="button" onClick={joinLobby} disabled={isSubmitting || status.status !== "ready" || !validUsername(username) || roomCode.trim().length === 0} className="mt-2 w-full rounded-lg bg-slate-100 px-3 py-2.5 font-bold text-slate-950 transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-white disabled:cursor-not-allowed disabled:opacity-45">Join lobby</button>
            </div>
          </div>
          {error && <p className="mt-5 rounded-lg bg-red-950/60 px-4 py-3 text-sm font-medium text-red-200" role="alert">{error}</p>}
        </div>
      </section>
    </main>
  )
}

function Lobby({ snapshot, roomCode, isHost, canStart, error, onStart, onEnd }: { readonly snapshot: GameSnapshot; readonly roomCode: string; readonly isHost: boolean; readonly canStart: boolean; readonly error: string | null; readonly onStart: () => void; readonly onEnd: () => void }) {
  const players = snapshot.state.players
  const emptySeats = Array.from({ length: maximumPlayers - players.length })
  const hasStarted = snapshot.state.phase !== "lobby"
  return <main className="min-h-screen bg-night px-5 py-7 text-parchment md:px-10 md:py-10">
    <header className="mx-auto flex w-full max-w-4xl items-center justify-between gap-5"><div className="font-display text-2xl font-bold">Flip Seven</div><span className="rounded-full bg-bronze/15 px-3 py-1 text-sm font-bold text-bronze">{players.length} / {maximumPlayers} players</span></header>
    <section className="mx-auto mt-16 w-full max-w-4xl" aria-labelledby="room-title">
      <p className="text-sm font-bold text-bronze">Room code</p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-5"><div><h1 id="room-title" className="font-display text-5xl font-bold tracking-[-0.025em]">{roomCode}</h1><p className="mt-3 text-slate-300">Share this code with your friends. The table seats up to four.</p></div>{isHost && <div className="flex gap-3">{!hasStarted && <button type="button" onClick={onStart} disabled={!canStart} className="rounded-xl bg-bronze px-5 py-3 font-bold text-night transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-bronze focus:ring-offset-2 focus:ring-offset-night disabled:cursor-not-allowed disabled:opacity-45">{canStart ? "Start game" : `Need ${3 - players.length} more player${players.length === 2 ? "" : "s"}`}</button>}<button type="button" onClick={onEnd} className="rounded-xl border border-red-400/60 px-4 py-3 text-sm font-bold text-red-200 transition hover:bg-red-950/60 focus:outline-none focus:ring-2 focus:ring-red-300">End game</button></div>}</div>
      <ol className="mt-12 grid gap-3 sm:grid-cols-2">{players.map((player) => <li key={player.id} className="flex items-center gap-4 rounded-xl bg-slate-900 px-5 py-4"><span className="grid size-9 place-items-center rounded-full bg-bronze text-sm font-extrabold text-night">{player.seat + 1}</span><div><p className="font-bold text-white">{player.name}</p><p className="text-sm text-slate-400">{player.seat === 0 ? "Host" : "Ready"}</p></div></li>)}{emptySeats.map((_, index) => <li key={`empty-${index}`} className="flex items-center gap-4 rounded-xl border border-dashed border-slate-700 px-5 py-4 text-slate-400"><span className="grid size-9 place-items-center rounded-full border border-slate-700 text-sm">+</span>Waiting for player</li>)}</ol>
      {!isHost && !hasStarted && <p className="mt-8 text-sm text-slate-300">Waiting for the host to start once at least three players have joined.</p>}
      {hasStarted && <p className="mt-8 rounded-lg bg-emerald-950/50 px-4 py-3 text-sm font-medium text-emerald-200">The game has started. Gameplay table coming next.</p>}
      {error && <p className="mt-5 rounded-lg bg-red-950/60 px-4 py-3 text-sm font-medium text-red-200" role="alert">{error}</p>}
    </section>
  </main>
}

function GameTable({ snapshot, playerId, isHost, error, onCommand, onEnd }: { readonly snapshot: GameSnapshot; readonly playerId: string; readonly isHost: boolean; readonly error: string | null; readonly onCommand: (type: "HIT" | "STAY" | "SELECT_ACTION_TARGET", targetId?: string) => void; readonly onEnd: () => void }) {
  const { state } = snapshot
  const currentPlayer = state.players.find((player) => player.seat === state.currentTurnSeat)
  const you = state.players.find((player) => player.id === playerId)
  const isYourTurn = currentPlayer?.id === playerId && state.phase === "awaitingTurnChoice"
  const targetRequest = state.phase === "awaitingActionTarget" && state.pendingAction?.chooserId === playerId

  return <main className="min-h-screen bg-night px-4 py-5 text-parchment md:px-8 md:py-8">
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4"><div><p className="text-xs font-bold tracking-[0.08em] text-bronze uppercase">Round {state.roundNumber}</p><h1 className="font-display text-2xl font-bold">Flip Seven</h1></div><div className="flex items-center gap-4"><div className="text-right"><p className="text-sm text-slate-400">Deck</p><p className="font-display text-2xl font-bold">{state.remainingCardCount}</p></div>{isHost && <button type="button" onClick={onEnd} className="rounded-lg border border-red-400/60 px-3 py-2 text-sm font-bold text-red-200 transition hover:bg-red-950/60 focus:outline-none focus:ring-2 focus:ring-red-300">End game</button>}</div></header>
    <section className="mx-auto mt-8 grid w-full max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]" aria-label="Game table">
      <div className="rounded-2xl bg-[oklch(0.16_0.032_158)] p-4 shadow-[inset_0_0_0_1px_oklch(0.35_0.07_158)] md:p-7">
        <div className="mb-8 flex items-center justify-between gap-4"><p className="text-sm font-bold text-emerald-100">{currentPlayer ? `${currentPlayer.name}'s turn` : "Resolving the table"}</p><div className="flex items-center gap-2"><div className="grid h-20 w-14 place-items-center rounded-lg border-2 border-bronze bg-slate-950 text-xs font-bold text-bronze">DRAW</div><p className="text-sm text-emerald-100/75">{state.discardCount} discarded</p></div></div>
        <ol className="grid gap-3 sm:grid-cols-2">{state.players.map((player) => <PlayerArea key={player.id} player={player} isCurrent={player.id === currentPlayer?.id} isYou={player.id === playerId} />)}</ol>
      </div>
      <aside className="rounded-xl bg-slate-900 p-5"><h2 className="font-display text-xl font-bold">Your choice</h2>{you === undefined ? <p className="mt-3 text-sm text-slate-400">Waiting for your seat.</p> : targetRequest ? <><p className="mt-3 text-sm leading-relaxed text-slate-300">Choose who receives {state.pendingAction?.action === "freeze" ? "the freeze" : "this action"}.</p><div className="mt-4 grid gap-2">{state.players.filter((player) => player.id !== playerId && player.roundStatus === "active").map((player) => <button key={player.id} type="button" onClick={() => onCommand("SELECT_ACTION_TARGET", player.id)} className="rounded-lg bg-slate-700 px-3 py-2 text-left text-sm font-bold transition hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-bronze">{player.name}</button>)}</div></> : isYourTurn ? <><p className="mt-3 text-sm leading-relaxed text-slate-300">Draw again and risk a duplicate, or lock in your score.</p><div className="mt-5 grid grid-cols-2 gap-3"><button type="button" onClick={() => onCommand("HIT")} className="rounded-lg bg-bronze px-3 py-3 font-bold text-night transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-bronze">Hit</button><button type="button" onClick={() => onCommand("STAY")} disabled={you.numberCards.length === 0} className="rounded-lg border border-slate-500 px-3 py-3 font-bold transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-45">Stay</button></div></> : <p className="mt-3 text-sm leading-relaxed text-slate-300">{state.phase === "gameOver" ? "The game is over." : "Watch the table — your next decision will appear here."}</p>}{error && <p className="mt-5 rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-200" role="alert">{error}</p>}</aside>
    </section>
  </main>
}

function PlayerArea({ player, isCurrent, isYou }: { readonly player: GameSnapshot["state"]["players"][number]; readonly isCurrent: boolean; readonly isYou: boolean }) {
  const visibleCards = [...player.numberCards.map((card) => `#${card.value}`), ...player.modifierCards.map((card) => card.operation === "add" ? `+${card.value}` : `×${card.value}`), ...player.actionCardsInFront.map((card) => card.action === "flipThree" ? "Flip 3" : card.action === "secondChance" ? "2nd chance" : "Freeze")]
  return <li className={`min-h-40 rounded-xl p-4 transition ${isCurrent ? "bg-emerald-800 ring-2 ring-bronze" : "bg-emerald-950/45"}`}><div className="flex items-start justify-between gap-3"><div><p className="font-bold text-white">{player.name}{isYou && <span className="ml-2 text-xs font-medium text-emerald-200">You</span>}</p><p className="mt-1 text-xs text-emerald-100/70">{player.roundStatus === "active" ? "Still playing" : player.roundStatus}</p></div><div className="text-right"><p className="text-xs text-emerald-100/70">Total</p><p className="font-display text-xl font-bold">{player.totalScore}</p></div></div><div className="mt-5 flex flex-wrap gap-2">{visibleCards.length > 0 ? visibleCards.map((card, index) => <span key={`${card}-${index}`} className="grid h-12 min-w-10 place-items-center rounded-md bg-slate-100 px-2 text-sm font-extrabold text-slate-950 shadow-sm">{card}</span>) : <span className="text-sm text-emerald-100/60">No cards yet</span>}</div></li>
}

function validUsername(value: string): boolean { return /^[a-zA-Z0-9 _-]{2,64}$/.test(value.trim()) }
function toPlayerId(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, "-") }
function makeRoomCode(): string { return `OLY-${crypto.randomUUID().slice(0, 6).toUpperCase()}` }
function readSession(): StoredSession | null { try { const value = sessionStorage.getItem("flip-seven-session"); return value === null ? null : JSON.parse(value) as StoredSession } catch { return null } }
