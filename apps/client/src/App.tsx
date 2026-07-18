import { useEffect, useMemo, useState } from "react"
import { io } from "socket.io-client"
import type { CardDefinition } from "@flip-seven/content"
import type {
  GameClaimResponse,
  GameCreateResponse,
  GameEndResponse,
  GameResponse,
  GameSnapshot,
  ServerStatus,
} from "@flip-seven/protocol"
import { GameCard } from "./components/GameCard.tsx"
import "./components/GameTable.css"

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
  const showChoice = isYourTurn || targetRequest || error !== null

  return <main className="min-h-screen bg-night px-3 py-4 text-parchment md:px-6 md:py-6">
    <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4"><div><p className="text-xs font-bold tracking-[0.08em] text-bronze uppercase">Round {state.roundNumber}</p><h1 className="font-display text-2xl font-bold">Flip Seven</h1></div><div className="flex items-center gap-4"><p className="hidden text-sm text-slate-400 sm:block">First to 200 wins</p>{isHost && <button type="button" onClick={onEnd} className="rounded-lg border border-red-400/60 px-3 py-2 text-sm font-bold text-red-200 transition hover:bg-red-950/60 focus:outline-none focus:ring-2 focus:ring-red-300">End game</button>}</div></header>
    <section className="mx-auto mt-7 w-full max-w-7xl" aria-label="Game table">
      <div className="table-layout" data-players={state.players.length}>
        <Leaderboard players={state.players} />
        <div className="table-layout__deck"><GameCard card={numberCardDefinition(0)} face="back" size="table" /><p><strong>{state.remainingCardCount}</strong> cards left</p></div>
        <ol className="contents">{state.players.map((player) => <PlayerArea key={player.id} player={player} position={tablePositionFor(player.id, playerId, state.players.map((candidate) => candidate.id))} isCurrent={player.id === currentPlayer?.id} isYou={player.id === playerId} />)}</ol>
        {showChoice && <aside className="game-action-panel" aria-live="polite"><h2 className="font-display text-lg font-bold">Your choice</h2>{you === undefined ? <p className="mt-1 text-sm text-slate-400">Waiting for your seat.</p> : targetRequest ? <><p className="mt-1 text-sm leading-relaxed text-slate-300">Choose who receives {state.pendingAction?.action === "freeze" ? "the freeze" : "this action"}.</p><div className="mt-3 grid gap-2">{state.players.filter((player) => player.id !== playerId && player.roundStatus === "active").map((player) => <button key={player.id} type="button" onClick={() => onCommand("SELECT_ACTION_TARGET", player.id)} className="rounded-lg bg-slate-700 px-3 py-2 text-left text-sm font-bold transition hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-bronze">{player.name}</button>)}</div></> : isYourTurn ? <><p className="mt-1 text-sm leading-relaxed text-slate-300">Press your luck, or preserve this round’s score.</p><div className="mt-3 grid grid-cols-2 gap-2"><button type="button" onClick={() => onCommand("HIT")} className="rounded-lg bg-bronze px-3 py-2.5 font-bold text-night transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-bronze">Hit</button><button type="button" onClick={() => onCommand("STAY")} disabled={you.numberCards.length === 0} className="rounded-lg border border-slate-500 px-3 py-2.5 font-bold transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-45">Stay</button></div></> : null}{error && <p className="mt-3 rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-200" role="alert">{error}</p>}</aside>}
      </div>
    </section>
  </main>
}

function PlayerArea({ player, position, isCurrent, isYou }: { readonly player: GameSnapshot["state"]["players"][number]; readonly position: "top" | "left" | "right" | "bottom"; readonly isCurrent: boolean; readonly isYou: boolean }) {
  const cards = [
    ...player.numberCards.map((card) => ({ id: card.id, definition: numberCardDefinition(card.value) })),
    ...player.modifierCards.map((card) => ({ id: card.id, definition: modifierCardDefinition(card.operation, card.value) })),
    ...player.actionCardsInFront.map((card) => ({ id: card.id, definition: actionCardDefinition(card.action) })),
  ]
  return <li className={`table-player table-player--${position} ${isCurrent ? "table-player--active" : ""} ${isYou ? "table-player--you" : ""}`}><div className="table-player__identity"><div><p>{player.name}{isYou && <span>You</span>}</p>{player.roundStatus !== "active" && <small>{player.roundStatus}</small>}</div></div><div className="table-player__hand">{cards.length > 0 ? cards.map((card, index) => <div key={card.id} className={index === 0 ? "shrink-0" : "-ml-12 shrink-0 sm:-ml-10"}><GameCard card={card.definition} size="table" /></div>) : <p>Waiting for a card</p>}</div></li>
}

function Leaderboard({ players }: { readonly players: readonly GameSnapshot["state"]["players"][number][] }) {
  const ranking = [...players].sort((left, right) => right.totalScore - left.totalScore || left.seat - right.seat)
  return <aside className="table-leaderboard" aria-label="Current scores"><p>Current scores</p><ol>{ranking.map((player) => <li key={player.id}><span>{player.name}</span><strong>{player.totalScore}</strong></li>)}</ol></aside>
}

function tablePositionFor(playerId: string, currentPlayerId: string, playerIds: readonly string[]): "top" | "left" | "right" | "bottom" {
  if (playerId === currentPlayerId) return "bottom"
  const opponentIndex = playerIds.filter((id) => id !== currentPlayerId).indexOf(playerId)
  if (playerIds.length === 3) {
    return (["left", "right"] as const)[opponentIndex] ?? "left"
  }
  return (["top", "left", "right"] as const)[opponentIndex] ?? "top"
}

function numberCardDefinition(value: number): CardDefinition {
  return { kind: "number", value: value as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12, figureName: "Olympian number", artwork: "cards/numbers/placeholder.svg" }
}

function modifierCardDefinition(operation: "add" | "multiply", value: number): CardDefinition {
  const effectName = operation === "add" ? `+${value} favour` : "Double favour"
  return { kind: "power", deityName: operation === "add" ? "Hephaestus" : "Zeus", effectName, description: operation === "add" ? `Add ${value} to your round score.` : "Double your number-card total.", artwork: "cards/powers/hermes-test.jpg", icon: "cards/icons/placeholder.svg", theme: operation === "add" ? "ember" : "storm" }
}

function actionCardDefinition(action: "freeze" | "flipThree" | "secondChance"): CardDefinition {
  const details = { freeze: ["Artemis", "Freeze", "Choose a player. They must stay."], flipThree: ["Hermes", "Flip three", "Choose a player to draw three cards."], secondChance: ["Athena", "Second chance", "Ignore one duplicate number."] } as const
  const [deityName, effectName, description] = details[action]
  return { kind: "power", deityName, effectName, description, artwork: "cards/powers/hermes-test.jpg", icon: "cards/icons/placeholder.svg", theme: "storm" }
}


function validUsername(value: string): boolean { return /^[a-zA-Z0-9 _-]{2,64}$/.test(value.trim()) }
function toPlayerId(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, "-") }
function makeRoomCode(): string { return `OLY-${crypto.randomUUID().slice(0, 6).toUpperCase()}` }
function readSession(): StoredSession | null { try { const value = sessionStorage.getItem("flip-seven-session"); return value === null ? null : JSON.parse(value) as StoredSession } catch { return null } }
