import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import { io } from "socket.io-client"
import { numberCardDefinition, type AssetKey, type CardDefinition, type PowerCardDefinition } from "@favour-of-olympus/content"
import type {
  GameClaimResponse,
  GameCreateResponse,
  GameEndResponse,
  GameResponse,
  GameSnapshot,
  ServerStatus,
} from "@favour-of-olympus/protocol"
import { GameCard } from "./components/GameCard.tsx"
import { GodChoicePanel } from "./components/GodChoicePanel.tsx"
import "./components/GameTable.css"
import "./components/GodReveal.css"

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000"
const maximumPlayers = 4
const winningScore = 200
const mythicAdjectives = ["Golden", "Stormborn", "Moonlit", "Swift", "Brazen", "Starlit", "Wild", "Laurel"] as const
const mythicFigures = ["Oracle", "Titan", "Nymph", "Voyager", "Champion", "Sphinx", "Muse", "Griffin"] as const

type EntryScreen = "title" | "gateway"
type LobbyMode = "create" | "join"

type StoredSession = {
  readonly gameId: string
  readonly playerId: string
  readonly accessToken: string
}

type DealAnimation = {
  readonly key: string
  readonly cardId: string
  readonly recipientId: string
  readonly card: CardDefinition
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
  const [entryScreen, setEntryScreen] = useState<EntryScreen>(() => readSession() === null ? "title" : "gateway")
  const [lobbyMode, setLobbyMode] = useState<LobbyMode>("create")
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [revealedGod, setRevealedGod] = useState<{ readonly god: string; readonly playerName: string } | null>(null)
  const [roundGods, setRoundGods] = useState<readonly { readonly id: string; readonly god: string }[]>([])
  const [dealQueue, setDealQueue] = useState<readonly DealAnimation[]>([])
  const handledGodReveals = useRef(new Set<string>())
  const handledDeals = useRef(new Set<string>())

  useEffect(() => {
    const nextSocket = io(serverUrl)
    setSocket(nextSocket)
    nextSocket.on("connect", () => setStatus({ status: "ready" }))
    nextSocket.on("disconnect", () => setStatus({ status: "disconnected" }))
    nextSocket.on("game:snapshot", setSnapshot)
    nextSocket.on("game:ended", clearGame)

    return () => {
      nextSocket.disconnect()
    }
  }, [])

  useEffect(() => {
    if (socket === null || status.status !== "ready" || session === null) return
    socket.emit("game:get", { gameId: session.gameId, accessToken: session.accessToken }, (response: GameResponse) => {
      if (response.ok) setSnapshot(response.snapshot)
    })
  }, [session, socket, status.status])

  useEffect(() => {
    if (snapshot === null) return
    if (snapshot.events.some((event) => event.type === "ROUND_STARTED")) {
      handledGodReveals.current.clear()
      setRoundGods([])
    }
    const event = [...snapshot.events].reverse().find(isGodRevealEvent)
    if (event === undefined) return
    const godCard = event.card
    const key = `${snapshot.state.revision}:${godCard.id}`
    if (handledGodReveals.current.has(key)) return
    handledGodReveals.current.add(key)
    setRoundGods((current) => current.some((card) => card.id === godCard.id)
      ? current
      : [...current, { id: godCard.id, god: godCard.god }])
    const playerName = snapshot.state.players.find((player) => player.id === event.recipientId)?.name ?? "A player"
    setRevealedGod({ god: godCard.god, playerName })
  }, [snapshot])

  useEffect(() => {
    if (snapshot === null) return
    const startsRound = snapshot.events.some((event) => event.type === "ROUND_STARTED")
    if (startsRound) handledDeals.current.clear()

    const incoming: DealAnimation[] = []
    for (const event of snapshot.events) {
      if (event.type !== "CARD_REVEALED" || event.card.kind === "god" || event.source === "aphrodite") continue
      const key = `${snapshot.state.revision}:${event.card.id}:${event.recipientId}`
      if (handledDeals.current.has(key)) continue
      handledDeals.current.add(key)
      incoming.push({
        key,
        cardId: event.card.id,
        recipientId: event.recipientId,
        card: event.card.kind === "number"
          ? numberCardDefinition(event.card.value)
          : modifierCardDefinition(event.card.operation, event.card.value),
      })
    }
    if (startsRound || incoming.length > 0) {
      setDealQueue((current) => startsRound ? incoming : [...current, ...incoming])
    }
  }, [snapshot])

  useEffect(() => {
    if (revealedGod === null) return
    const timeout = window.setTimeout(() => setRevealedGod(null), 3_400)
    return () => window.clearTimeout(timeout)
  }, [revealedGod])

  const playerId = useMemo(() => toPlayerId(username), [username])
  const isHost = snapshot?.state.players[0]?.id === session?.playerId
  const canStart = isHost && snapshot !== null && snapshot.state.players.length >= 3

  function remember(gameId: string, playerId: string, accessToken: string) {
    const nextSession = { gameId, playerId, accessToken }
    sessionStorage.setItem("favour-of-olympus-session", JSON.stringify(nextSession))
    setSession(nextSession)
  }

  function clearGame() {
    sessionStorage.removeItem("favour-of-olympus-session")
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

  function generateUsername() {
    const adjective = mythicAdjectives[Math.floor(Math.random() * mythicAdjectives.length)]
    const figure = mythicFigures[Math.floor(Math.random() * mythicFigures.length)]
    setUsername(`${adjective} ${figure}`)
    setError(null)
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

  function submitGameCommand(type: "HIT" | "STAY") {
    if (socket === null || session === null || snapshot === null) return
    setError(null)
    const command = { type, actorId: session.playerId, expectedRevision: snapshot.state.revision }
    socket.emit("game:command", { gameId: session.gameId, accessToken: session.accessToken, command }, (response: GameResponse) => {
      if (!response.ok) setError(response.error.message)
    })
  }

  function submitChoice(choiceId: string, selection: unknown) {
    if (socket === null || session === null || snapshot === null) return
    setError(null)
    socket.emit("game:command", {
      gameId: session.gameId,
      accessToken: session.accessToken,
      command: { type: "SUBMIT_CHOICE", actorId: session.playerId, choiceId, selection, expectedRevision: snapshot.state.revision },
    }, (response: GameResponse) => {
      if (!response.ok) setError(response.error.message)
    })
  }

  if (snapshot !== null) {
    const screen = snapshot.state.phase === "lobby"
      ? <Lobby snapshot={snapshot} roomCode={session?.gameId ?? ""} isHost={isHost} canStart={canStart} error={error} onStart={startGame} onEnd={endGame} />
      : <GameTable snapshot={snapshot} playerId={session?.playerId ?? ""} isHost={isHost} roundGods={roundGods} activeDeal={revealedGod === null ? dealQueue[0] : undefined} pendingDeals={dealQueue} error={error} onCommand={submitGameCommand} onSubmitChoice={submitChoice} onDealComplete={() => setDealQueue((current) => current.slice(1))} onEnd={endGame} />
    return <>{screen}{revealedGod && <GodRevealOverlay god={revealedGod.god} playerName={revealedGod.playerName} onDismiss={() => setRevealedGod(null)} />}</>
  }

  const usernameInvalid = username.length > 0 && !validUsername(username)
  if (entryScreen === "title") {
    return <TitleScreen status={status} onEnter={() => setEntryScreen("gateway")} />
  }

  return (
    <main className="entry-screen text-parchment">
      <div className="entry-screen__veil" />
      <header className="entry-header">
        <button type="button" className="entry-back" onClick={() => setEntryScreen("title")} aria-label="Back to title screen">
          <BackIcon />
          <span>Title</span>
        </button>
        <ConnectionStatus status={status} />
      </header>

      <section className="entry-layout" aria-labelledby="lobby-title">
        <div className="entry-intro">
          <p className="entry-kicker">The gates of Olympus await</p>
          <h1 id="lobby-title">Claim your place<br />among the gods.</h1>
          <p>Choose a mortal name, then raise a private table or answer a friend’s summons.</p>
        </div>

        <form className="olympus-panel" onSubmit={(event) => { event.preventDefault(); lobbyMode === "create" ? createLobby() : joinLobby() }}>
          <div className="olympus-panel__crest" aria-hidden="true"><span>VII</span></div>
          <p className="olympus-panel__eyebrow">Player identity</p>
          <h2>Choose your name</h2>
          <p className="olympus-panel__lead">This is how your rivals will know you at the table.</p>

          <label className="field-label" htmlFor="username">Display name</label>
          <div className="name-field">
            <input
              id="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={64}
              autoComplete="nickname"
              placeholder="e.g. Golden Oracle"
              aria-invalid={usernameInvalid}
              aria-describedby={usernameInvalid ? "username-error" : "username-help"}
            />
            <button type="button" onClick={generateUsername} aria-label="Generate a mythic name" title="Generate a mythic name">
              <SparkIcon />
            </button>
          </div>
          {usernameInvalid
            ? <p id="username-error" className="field-message field-message--error" role="alert">Use 2–64 letters, numbers, spaces, hyphens, or underscores.</p>
            : <p id="username-help" className="field-message">Need inspiration? Let fate choose with the star button.</p>}

          <fieldset className="lobby-choice">
            <legend>How will you enter?</legend>
            <div className="lobby-choice__tabs">
              <button type="button" className={lobbyMode === "create" ? "is-active" : ""} onClick={() => { setLobbyMode("create"); setError(null) }} aria-pressed={lobbyMode === "create"}>
                Create lobby
              </button>
              <button type="button" className={lobbyMode === "join" ? "is-active" : ""} onClick={() => { setLobbyMode("join"); setError(null) }} aria-pressed={lobbyMode === "join"}>
                Join by code
              </button>
            </div>
          </fieldset>

          {lobbyMode === "join" && <div className="room-code-field">
            <label className="field-label" htmlFor="room-code">Room code</label>
            <input id="room-code" value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} maxLength={24} autoCapitalize="characters" spellCheck={false} placeholder="OLY-XXXXXX" />
          </div>}

          <button type="submit" className="olympus-cta" disabled={isSubmitting || status.status !== "ready" || !validUsername(username) || (lobbyMode === "join" && roomCode.trim().length === 0)}>
            <span>{isSubmitting ? "Calling the gods…" : lobbyMode === "create" ? "Create private lobby" : "Enter the lobby"}</span>
            {!isSubmitting && <ChevronIcon />}
          </button>
          <p className="olympus-panel__note">{lobbyMode === "create" ? "You’ll receive a code to share with up to three rivals." : "Enter the exact code shared by your host."}</p>
          {error && <p className="entry-error" role="alert">{error}</p>}
        </form>
      </section>
    </main>
  )
}


function TitleScreen({ status, onEnter }: { readonly status: ServerStatus; readonly onEnter: () => void }) {
  return <main className="title-screen text-parchment">
    <div className="title-screen__shade" />
    <h1 className="sr-only">Favour of Olympus</h1>
    <div className="title-screen__status"><ConnectionStatus status={status} compact /></div>
    <div className="title-screen__action">
      <p>Outwit your rivals. Win the gods’ favour.</p>
      <button type="button" onClick={onEnter}>
        <span>Enter Olympus</span>
        <ChevronIcon />
      </button>
      <small>3–4 players · Online multiplayer</small>
    </div>
  </main>
}

function ConnectionStatus({ status, compact = false }: { readonly status: ServerStatus; readonly compact?: boolean }) {
  const label = status.status === "ready" ? "Connected" : status.status === "connecting" ? "Connecting" : "Disconnected"
  return <div className={`connection-status ${compact ? "connection-status--compact" : ""}`} role="status" aria-live="polite">
    <span className={statusDotClassNames[status.status]} />
    <span>{label}</span>
  </div>
}

type CardRevealEvent = Extract<GameSnapshot["events"][number], { readonly type: "CARD_REVEALED" }>
type GodRevealEvent = CardRevealEvent & { readonly card: Extract<CardRevealEvent["card"], { readonly kind: "god" }> }

function isGodRevealEvent(event: GameSnapshot["events"][number]): event is GodRevealEvent {
  return event.type === "CARD_REVEALED" && event.card.kind === "god"
}

function GodRevealOverlay({ god, playerName, onDismiss }: { readonly god: string; readonly playerName: string; readonly onDismiss: () => void }) {
  const card = godCardDefinition(god)
  const reducedMotion = useReducedMotion()
  const revealTransition = { duration: reducedMotion ? 0 : 0.65, ease: [0.22, 1, 0.36, 1] as const }
  return <motion.div className="god-reveal" role="dialog" aria-modal="true" aria-label={`${card.deityName} revealed`} onClick={onDismiss} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reducedMotion ? 0 : 0.3 }}>
    <motion.p className="god-reveal__eyebrow" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...revealTransition, delay: reducedMotion ? 0 : 0.2 }}>{playerName} invoked</motion.p>
    <div className="god-reveal__cards" aria-hidden="true">
      <motion.div className="god-reveal__back" initial={{ opacity: 1, rotateY: 0, scale: 0.86 }} animate={reducedMotion ? { opacity: 0 } : { opacity: [1, 1, 0], rotateY: [0, 0, 90], scale: [0.86, 1, 1] }} transition={{ duration: reducedMotion ? 0 : 1.1, times: [0, 0.35, 1], ease: [0.22, 1, 0.36, 1] }}><GameCard card={card} face="back" size="preview" /></motion.div>
      <motion.div className="god-reveal__front" initial={{ opacity: 0, rotateY: reducedMotion ? 0 : -90, scale: reducedMotion ? 1 : 0.86 }} animate={{ opacity: 1, rotateY: 0, scale: 1 }} transition={{ ...revealTransition, delay: reducedMotion ? 0 : 0.42 }}><GameCard card={card} size="preview" /></motion.div>
    </div>
    <motion.h2 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...revealTransition, delay: reducedMotion ? 0 : 0.8 }}>{card.deityName}</motion.h2>
    <motion.p className="god-reveal__effect" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...revealTransition, delay: reducedMotion ? 0 : 0.9 }}>{card.effectName}</motion.p>
    <motion.button type="button" onClick={onDismiss} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...revealTransition, delay: reducedMotion ? 0 : 1 }}>Continue</motion.button>
  </motion.div>
}

function BackIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
}

function SparkIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5-6.5-2L10 9l2-6.5Z" /><path d="m18.5 16 .75 2.25L21.5 19l-2.25.75L18.5 22l-.75-2.25L15.5 19l2.25-.75L18.5 16Z" /></svg>
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
}

function Lobby({ snapshot, roomCode, isHost, canStart, error, onStart, onEnd }: { readonly snapshot: GameSnapshot; readonly roomCode: string; readonly isHost: boolean; readonly canStart: boolean; readonly error: string | null; readonly onStart: () => void; readonly onEnd: () => void }) {
  const players = snapshot.state.players
  const emptySeats = Array.from({ length: maximumPlayers - players.length })
  const hasStarted = snapshot.state.phase !== "lobby"
  const playersNeeded = Math.max(0, 3 - players.length)

  return <main className="waiting-lobby text-parchment">
    <div className="waiting-lobby__veil" />
    <header className="waiting-lobby__header">
      <div className="waiting-lobby__brand"><span aria-hidden="true">VII</span><strong>Favour of Olympus</strong></div>
      <div className="waiting-lobby__count" aria-label={`${players.length} of ${maximumPlayers} players joined`}>
        <span>{players.length}</span> / {maximumPlayers} players
      </div>
    </header>

    <section className="waiting-lobby__layout" aria-labelledby="room-title">
      <div className="lobby-invitation">
        <div className="lobby-invitation__ornament" aria-hidden="true"><span>VII</span></div>
        <p className="lobby-invitation__eyebrow">Private table</p>
        <h1 id="room-title">Gather your rivals</h1>
        <p className="lobby-invitation__intro">Share this room code with your friends. The gods will receive up to four players.</p>

        <div className="lobby-code" aria-label={`Room code ${roomCode}`}>
          <span>Room code</span>
          <strong>{roomCode}</strong>
        </div>

        <div className="lobby-roster__heading">
          <div><p>Seats at the table</p><span>{players.length >= 3 ? "The table is ready" : `Waiting for ${playersNeeded} more player${playersNeeded === 1 ? "" : "s"}`}</span></div>
          <div className="lobby-progress" aria-hidden="true">{Array.from({ length: maximumPlayers }, (_, index) => <span key={index} className={index < players.length ? "is-filled" : ""} />)}</div>
        </div>

        <ol className="lobby-roster">
          {players.map((player) => <li key={player.id} className="lobby-seat lobby-seat--filled">
            <span className="lobby-seat__number">{player.seat + 1}</span>
            <div><p>{player.name}</p><span>{player.seat === 0 ? "Host · Ready" : "Ready"}</span></div>
          </li>)}
          {emptySeats.map((_, index) => <li key={`empty-${index}`} className="lobby-seat lobby-seat--empty">
            <span className="lobby-seat__number"><PlusIcon /></span>
            <div><p>Open seat</p><span>Waiting for player</span></div>
          </li>)}
        </ol>

        {isHost && <div className="lobby-actions">
          {!hasStarted && <button type="button" onClick={onStart} disabled={!canStart} className="lobby-start" aria-describedby={!canStart ? "lobby-start-help" : undefined}>
            <span>{canStart ? "Start the game" : `Need ${playersNeeded} more player${playersNeeded === 1 ? "" : "s"}`}</span>
            {canStart && <ChevronIcon />}
          </button>}
          {!canStart && !hasStarted && <p id="lobby-start-help">A game needs at least three players.</p>}
          <button type="button" onClick={onEnd} className="lobby-end">End this lobby</button>
        </div>}

        {!isHost && !hasStarted && <p className="lobby-waiting-note">The host can begin once at least three players have joined.</p>}
        {hasStarted && <p className="lobby-success">The game has started. Entering the table…</p>}
        {error && <p className="entry-error" role="alert">{error}</p>}
      </div>
    </section>
  </main>
}

function GameTable({ snapshot, playerId, isHost, roundGods, activeDeal, pendingDeals, error, onCommand, onSubmitChoice, onDealComplete, onEnd }: { readonly snapshot: GameSnapshot; readonly playerId: string; readonly isHost: boolean; readonly roundGods: readonly { readonly id: string; readonly god: string }[]; readonly activeDeal: DealAnimation | undefined; readonly pendingDeals: readonly DealAnimation[]; readonly error: string | null; readonly onCommand: (type: "HIT" | "STAY") => void; readonly onSubmitChoice: (choiceId: string, selection: unknown) => void; readonly onDealComplete: () => void; readonly onEnd: () => void }) {
  const { state } = snapshot
  const currentPlayer = state.players.find((player) => player.seat === state.currentTurnSeat)
  const you = state.players.find((player) => player.id === playerId)
  const isYourTurn = currentPlayer?.id === playerId && state.phase === "awaitingTurnChoice"
  const pendingChoice = state.phase === "awaitingChoice" && state.pendingChoice?.controllerId === playerId
    ? state.pendingChoice
    : null
  const showTurnChoice = isYourTurn || (error !== null && pendingChoice === null)
  const pendingCardIds = new Set(pendingDeals.map((deal) => deal.cardId))
  const pendingRecipientIds = new Set(pendingDeals.map((deal) => deal.recipientId))

  return <main className="min-h-screen bg-night px-3 py-4 text-parchment md:px-6 md:py-6">
    <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4"><div><p className="text-xs font-bold tracking-[0.08em] text-bronze uppercase">Round {state.roundNumber}</p><h1 className="font-display text-2xl font-bold">Favour of Olympus</h1></div><div className="flex items-center gap-4"><p className="hidden text-sm text-slate-400 sm:block">First to 200 wins</p>{isHost && <button type="button" onClick={onEnd} className="rounded-lg border border-red-400/60 px-3 py-2 text-sm font-bold text-red-200 transition hover:bg-red-950/60 focus:outline-none focus:ring-2 focus:ring-red-300">End game</button>}</div></header>
    <section className="mx-auto mt-7 w-full max-w-7xl" aria-label="Game table">
      <div className="table-layout" data-players={state.players.length}>
        <Scoreboard players={state.players} currentPlayerId={currentPlayer?.id ?? null} roundGods={roundGods} targetScore={winningScore} />
        <div className="table-layout__deck"><GameCard card={numberCardDefinition(0)} face="back" size="table" /><p><strong>{state.remainingCardCount}</strong> cards left</p></div>
        <ol className="contents">{state.players.map((player) => <PlayerArea key={player.id} player={player} position={tablePositionFor(player.id, playerId, state.players.map((candidate) => candidate.id))} isCurrent={player.id === currentPlayer?.id} isYou={player.id === playerId} pendingCardIds={pendingCardIds} hasIncomingCard={pendingRecipientIds.has(player.id)} />)}</ol>
        {activeDeal !== undefined && <DealingCard key={activeDeal.key} deal={activeDeal} onComplete={onDealComplete} />}
        {showTurnChoice && <aside className="game-action-panel" aria-live="polite"><p className="game-action-panel__eyebrow">Your turn</p><h2>Your choice</h2>{you === undefined ? <p className="game-action-panel__copy">Waiting for your seat.</p> : isYourTurn ? <><p className="game-action-panel__copy">Press your luck, or preserve this round’s score.</p><div className="turn-actions"><button type="button" onClick={() => onCommand("HIT")} className="turn-action turn-action--hit"><span>Hit</span><small>Draw a card</small></button><button type="button" onClick={() => onCommand("STAY")} disabled={you.numberCards.length === 0} className="turn-action turn-action--stay"><span>Stay</span><small>Bank your score</small></button></div></> : null}{error && <p className="game-action-panel__error" role="alert">{error}</p>}</aside>}
        {pendingChoice !== null && <div className="god-choice-overlay"><aside className="game-action-panel game-action-panel--god" role="dialog" aria-modal="true" aria-labelledby="god-choice-title"><p className="game-action-panel__eyebrow game-action-panel__god">{godCardDefinition(pendingChoice.god).deityName}</p><h2 id="god-choice-title">Choose an action</h2><GodChoicePanel choice={pendingChoice} players={state.players} onSubmit={onSubmitChoice} />{error && <p className="game-action-panel__error" role="alert">{error}</p>}</aside></div>}
      </div>
    </section>
  </main>
}

function DealingCard({ deal, onComplete }: { readonly deal: DealAnimation; readonly onComplete: () => void }) {
  const elementRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()
  const [travel, setTravel] = useState({ x: 0, y: 0, ready: false })

  useLayoutEffect(() => {
    const element = elementRef.current
    const table = element?.closest(".table-layout")
    const deck = table?.querySelector(".table-layout__deck")
    const destination = table?.querySelector(`[data-player-id="${CSS.escape(deal.recipientId)}"] .table-player__hand`)
    if (deck === null || deck === undefined || destination === null || destination === undefined) {
      setTravel({ x: 0, y: 0, ready: true })
      return
    }
    const deckRect = deck.getBoundingClientRect()
    const destinationRect = destination.getBoundingClientRect()
    setTravel({
      x: destinationRect.left + destinationRect.width / 2 - (deckRect.left + deckRect.width / 2),
      y: destinationRect.top + destinationRect.height / 2 - (deckRect.top + deckRect.height / 2),
      ready: true,
    })
  }, [deal.recipientId])

  return <div ref={elementRef} className="deal-animation" aria-hidden="true">
    {travel.ready && <motion.div
      className="deal-animation__card"
      initial={{ ...(reducedMotion ? { opacity: 0 } : {}), x: 0, y: 0, rotate: -5, scale: 0.84 }}
      animate={reducedMotion
        ? { opacity: [0, 1, 0], x: travel.x, y: travel.y }
        : { x: [0, 0, travel.x * 0.72, travel.x], y: [0, -28, travel.y - 16, travel.y], rotate: [-7, -2, 3, 0], scale: [0.8, 1.12, 1.06, 1] }}
      transition={{ delay: reducedMotion ? 0 : 0.08, duration: reducedMotion ? 0.16 : 0.78, times: reducedMotion ? [0, 0.5, 1] : [0, 0.14, 0.76, 1], ease: [0.22, 1, 0.36, 1] }}
      onAnimationComplete={onComplete}
    >
      <GameCard card={deal.card} size="table" />
    </motion.div>}
  </div>
}

function PlayerArea({ player, position, isCurrent, isYou, pendingCardIds, hasIncomingCard }: { readonly player: GameSnapshot["state"]["players"][number]; readonly position: "top" | "left" | "right" | "bottom"; readonly isCurrent: boolean; readonly isYou: boolean; readonly pendingCardIds: ReadonlySet<string>; readonly hasIncomingCard: boolean }) {
  const cards = [
    ...player.numberCards.map((card) => ({ id: card.instanceId, definition: numberCardDefinition(card.value) })),
    ...player.modifierCards.map((card) => ({ id: card.instanceId, definition: modifierCardDefinition(card.operation, card.value) })),
    ...player.godCardsInFront.map((card) => ({ id: card.id, definition: godCardDefinition(card.god) })),
  ].filter((card) => !pendingCardIds.has(card.id))
  const roundScore = player.lockedRoundScore ?? 0
  const outcomeLabel = player.roundStatus === "busted" ? "Busted — round score lost" : `Stayed — ${roundScore} points banked`

  return <li data-player-id={player.id} className={`table-player table-player--${position} table-player--${player.roundStatus} ${isCurrent ? "table-player--active" : ""} ${isYou ? "table-player--you" : ""}`} aria-label={`${player.name}. ${player.roundStatus === "active" ? isCurrent ? "Taking their turn" : "Still in the round" : outcomeLabel}`}>
    <div className="table-player__identity">
      <p>{player.name}{isYou && <span>You</span>}</p>
      {player.roundStatus === "active" && <span className={`round-status round-status--active ${isCurrent ? "round-status--current" : ""}`}><span className="round-status__dot" />{isCurrent ? "Taking turn" : "In play"}</span>}
    </div>
    <div className="table-player__hand">{cards.length > 0 ? cards.map((card, index) => <div key={card.id} className={index === 0 ? "shrink-0" : "-ml-12 shrink-0 sm:-ml-10"}><GameCard card={card.definition} size="table" /></div>) : <p>{hasIncomingCard ? "Dealing…" : "Waiting for a card"}</p>}</div>
    {player.roundStatus !== "active" && <div className={`round-outcome round-outcome--${player.roundStatus}`} role="status">
      <span className="round-outcome__icon"><RoundStatusIcon status={player.roundStatus} /></span>
      <span><strong>{player.roundStatus === "busted" ? "Busted" : "Stayed"}</strong><small>{player.roundStatus === "busted" ? "Round score lost" : `${roundScore} points banked`}</small></span>
    </div>}
  </li>
}

function Scoreboard({ players, currentPlayerId, roundGods, targetScore }: { readonly players: readonly GameSnapshot["state"]["players"][number][]; readonly currentPlayerId: string | null; readonly roundGods: readonly { readonly id: string; readonly god: string }[]; readonly targetScore: number }) {
  const ranking = [...players].sort((left, right) => right.totalScore - left.totalScore || left.seat - right.seat)
  return <aside className="table-scoreboard" aria-label={`Scoreboard. First player to ${targetScore} points wins.`} aria-live="polite">
    <header className="table-scoreboard__header"><div><p>Race to Olympus</p><h2>Scoreboard</h2></div><span>First to <strong>{targetScore}</strong></span></header>
    <ol>{ranking.map((player, index) => {
      const progress = Math.min(100, Math.max(0, player.totalScore / targetScore * 100))
      const isCurrent = player.id === currentPlayerId && player.roundStatus === "active"
      const roundLabel = player.roundStatus === "busted"
        ? "Busted · round lost"
        : player.roundStatus === "stayed"
          ? `Stayed · +${player.lockedRoundScore ?? 0} banked`
          : isCurrent ? "Taking turn" : "In play"
      return <li key={player.id} className={`scoreboard-player scoreboard-player--${player.roundStatus} ${isCurrent ? "scoreboard-player--current" : ""}`}>
        <span className="scoreboard-player__rank" aria-label={`Rank ${index + 1}`}>{index + 1}</span>
        <div className="scoreboard-player__details"><div><strong>{player.name}</strong><span className="scoreboard-player__score">{player.totalScore}<small> / {targetScore}</small></span></div><p><RoundStatusIcon status={player.roundStatus} />{roundLabel}</p><div className="scoreboard-player__progress" role="progressbar" aria-label={`${player.name} score progress`} aria-valuemin={0} aria-valuemax={targetScore} aria-valuenow={player.totalScore}><span style={{ width: `${progress}%` }} /></div></div>
      </li>
    })}</ol>
    {roundGods.length > 0 && <div className="table-scoreboard__gods"><p>Gods invoked this round</p><div>{roundGods.map((card) => <GameCard key={card.id} card={godCardDefinition(card.god)} size="table" />)}</div></div>}
  </aside>
}

function RoundStatusIcon({ status }: { readonly status: GameSnapshot["state"]["players"][number]["roundStatus"] }) {
  if (status === "busted") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="m9 9 6 6m0-6-6 6" /></svg>
  if (status === "stayed") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 19 6v5.2c0 4.2-2.8 7.5-7 9.3-4.2-1.8-7-5.1-7-9.3V6l7-2.5Z" /><path d="m8.8 12 2.1 2.1 4.5-4.6" /></svg>
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v4.8l3.2 1.8" /></svg>
}

function tablePositionFor(playerId: string, currentPlayerId: string, playerIds: readonly string[]): "top" | "left" | "right" | "bottom" {
  if (playerId === currentPlayerId) return "bottom"
  const opponentIndex = playerIds.filter((id) => id !== currentPlayerId).indexOf(playerId)
  if (playerIds.length === 3) {
    return (["left", "right"] as const)[opponentIndex] ?? "left"
  }
  return (["top", "left", "right"] as const)[opponentIndex] ?? "top"
}

function modifierCardDefinition(operation: "add" | "multiply", value: number): CardDefinition {
  const effectName = operation === "add" ? `+${value} favour` : "Double favour"
  return { kind: "power", deityName: operation === "add" ? "Hephaestus" : "Zeus", effectName, description: operation === "add" ? `Add ${value} to your round score.` : "Double your number-card total.", artwork: "cards/powers/hermes-test.jpg", icon: "cards/icons/placeholder.svg", theme: operation === "add" ? "ember" : "storm" }
}

function godCardDefinition(god: string): PowerCardDefinition {
  const details: Record<string, { readonly deityName: string; readonly effectName: string; readonly description: string; readonly artwork: AssetKey; readonly theme: "storm" | "ember" | "frost" }> = {
    zeus: { deityName: "Zeus", effectName: "Thunderbolt", description: "Rule the round with the king of Olympus.", artwork: "cards/powers/gods/zeus.png", theme: "storm" },
    ares: { deityName: "Ares", effectName: "War Cry", description: "Force the battle onward.", artwork: "cards/powers/gods/ares.png", theme: "ember" },
    dionysus: { deityName: "Dionysus", effectName: "Revelry", description: "Turn fortune in your favour.", artwork: "cards/powers/gods/dionysus.png", theme: "ember" },
    athena: { deityName: "Athena", effectName: "Strategy", description: "Choose with wisdom.", artwork: "cards/powers/gods/athena.png", theme: "storm" },
    hades: { deityName: "Hades", effectName: "Underworld", description: "Claim power from below.", artwork: "cards/powers/gods/hades.png", theme: "storm" },
    hermes: { deityName: "Hermes", effectName: "Swift Exchange", description: "Exchange fate between players.", artwork: "cards/powers/gods/hermes.png", theme: "storm" },
    artemis: { deityName: "Artemis", effectName: "Hunt", description: "Set a rival’s course.", artwork: "cards/powers/gods/artemis.png", theme: "frost" },
    aphrodite: { deityName: "Aphrodite", effectName: "Charm", description: "Draw from a new source.", artwork: "cards/powers/gods/aphrodite.png", theme: "ember" },
    hephaestus: { deityName: "Hephaestus", effectName: "Forge", description: "Forge a stronger score.", artwork: "cards/powers/gods/hephaestus.png", theme: "ember" },
    demeter: { deityName: "Demeter", effectName: "Harvest", description: "Change a number in play.", artwork: "cards/powers/gods/demeter.png", theme: "frost" },
    nike: { deityName: "Nike", effectName: "Victory", description: "Carry victory into the round.", artwork: "cards/powers/gods/nike.png", theme: "frost" },
    prometheus: { deityName: "Prometheus", effectName: "Borrowed Fire", description: "Borrow a god’s power.", artwork: "cards/powers/gods/prometheus.png", theme: "ember" },
  }
  const presentation = details[god] ?? { deityName: "Olympus", effectName: "Godly intervention", description: "Invoke a god’s power.", artwork: "cards/powers/placeholder.svg" as AssetKey, theme: "storm" as const }
  return { kind: "power", ...presentation, icon: "cards/icons/placeholder.svg" }
}


function validUsername(value: string): boolean { return /^[a-zA-Z0-9 _-]{2,64}$/.test(value.trim()) }
function toPlayerId(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, "-") }
function makeRoomCode(): string { return `OLY-${crypto.randomUUID().slice(0, 6).toUpperCase()}` }
function readSession(): StoredSession | null { try { const value = sessionStorage.getItem("favour-of-olympus-session"); return value === null ? null : JSON.parse(value) as StoredSession } catch { return null } }
