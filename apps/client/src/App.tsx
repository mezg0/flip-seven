import { useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react"
import { io } from "socket.io-client"
import { numberCardDefinition } from "@favour-of-olympus/content"
import type { AssetKey, CardDefinition, PowerCardDefinition } from "@favour-of-olympus/content"
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
const minimumPlayers = 2
const maximumPlayers = 4
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
    const timeout = window.setTimeout(() => setRevealedGod(null), 5_500)
    return () => window.clearTimeout(timeout)
  }, [revealedGod])

  const playerId = useMemo(() => toPlayerId(username), [username])
  const isHost = snapshot?.state.players[0]?.id === session?.playerId
  const canStart = isHost && snapshot !== null && snapshot.state.players.length >= minimumPlayers

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

  function submitGameCommand(type: "HIT" | "STAY" | "ADVANCE_ROUND") {
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
    return <>
      {screen}
      <AnimatePresence>
        {revealedGod && <GodRevealOverlay god={revealedGod.god} playerName={revealedGod.playerName} onDismiss={() => setRevealedGod(null)} />}
      </AnimatePresence>
    </>
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
  const backdropTransition = { duration: reducedMotion ? 0 : 0.32, ease: [0.22, 1, 0.36, 1] as const }
  return <motion.div
    className="god-reveal"
    role="dialog"
    aria-modal="true"
    aria-label={`${card.deityName} revealed`}
    onClick={(event) => {
      if (event.target === event.currentTarget) onDismiss()
    }}
    initial={{ opacity: 0, backdropFilter: "blur(0px)" }}
    animate={{ opacity: 1, backdropFilter: reducedMotion ? "blur(0px)" : "blur(8px)" }}
    exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
    transition={backdropTransition}
  >
    <motion.p className="god-reveal__eyebrow" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...revealTransition, delay: reducedMotion ? 0 : 0.2 }}>{playerName} invoked</motion.p>
    <div className="god-reveal__cards" aria-hidden="true">
      <motion.div className="god-reveal__back" initial={{ opacity: 1, rotateY: 0, scale: 0.86 }} animate={reducedMotion ? { opacity: 0 } : { opacity: [1, 1, 0], rotateY: [0, 0, 90], scale: [0.86, 1, 1] }} transition={{ duration: reducedMotion ? 0 : 1.1, times: [0, 0.35, 1], ease: [0.22, 1, 0.36, 1] }}><GameCard card={card} face="back" size="preview" /></motion.div>
      <motion.div className="god-reveal__front" initial={{ opacity: 0, rotateY: reducedMotion ? 0 : -90, scale: reducedMotion ? 1 : 0.86 }} animate={{ opacity: 1, rotateY: 0, scale: 1 }} transition={{ ...revealTransition, delay: reducedMotion ? 0 : 0.42 }}><GameCard card={card} size="preview" /></motion.div>
    </div>
    <motion.h2 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...revealTransition, delay: reducedMotion ? 0 : 0.8 }}>{card.deityName}</motion.h2>
    <motion.p className="god-reveal__effect" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...revealTransition, delay: reducedMotion ? 0 : 0.9 }}>{card.effectName}</motion.p>
    <motion.p className="god-reveal__description" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...revealTransition, delay: reducedMotion ? 0 : 0.96 }}>{card.description}</motion.p>
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
  const playersNeeded = Math.max(0, minimumPlayers - players.length)

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
          {!canStart && !hasStarted && <p id="lobby-start-help">A game needs at least two players.</p>}
          <button type="button" onClick={onEnd} className="lobby-end">End this lobby</button>
        </div>}

        {!isHost && !hasStarted && <p className="lobby-waiting-note">The host can begin once two players have joined.</p>}
        {hasStarted && <p className="lobby-success">The game has started. Entering the table…</p>}
        {error && <p className="entry-error" role="alert">{error}</p>}
      </div>
    </section>
  </main>
}

function GameTable({ snapshot, playerId, isHost, roundGods, activeDeal, pendingDeals, error, onCommand, onSubmitChoice, onDealComplete, onEnd }: { readonly snapshot: GameSnapshot; readonly playerId: string; readonly isHost: boolean; readonly roundGods: readonly { readonly id: string; readonly god: string }[]; readonly activeDeal: DealAnimation | undefined; readonly pendingDeals: readonly DealAnimation[]; readonly error: string | null; readonly onCommand: (type: "HIT" | "STAY" | "ADVANCE_ROUND") => void; readonly onSubmitChoice: (choiceId: string, selection: unknown) => void; readonly onDealComplete: () => void; readonly onEnd: () => void }) {
  const { state } = snapshot
  const currentPlayer = state.players.find((player) => player.seat === state.currentTurnSeat)
  const you = state.players.find((player) => player.id === playerId)
  const isYourTurn = currentPlayer?.id === playerId && state.phase === "awaitingTurnChoice"
  const pendingChoice = state.phase === "awaitingChoice" && state.pendingChoice?.controllerId === playerId
    ? state.pendingChoice
    : null
  const reducedMotion = useReducedMotion()
  const [landingDealKey, setLandingDealKey] = useState<string | null>(null)
  const [inspectedHand, setInspectedHand] = useState<{ readonly cards: readonly CardDefinition[]; readonly playerName: string } | null>(null)
  const showTurnChoice = isYourTurn || (error !== null && pendingChoice === null)
  const pendingCardIds = new Set(pendingDeals.filter((deal) => deal.key !== landingDealKey).map((deal) => deal.cardId))
  const pendingRecipientIds = new Set(pendingDeals.filter((deal) => deal.key !== landingDealKey).map((deal) => deal.recipientId))

  useEffect(() => {
    setLandingDealKey(null)
    if (activeDeal === undefined) return
    const launchDelay = reducedMotion ? 0 : 90
    const travelDuration = reducedMotion ? 30 : 540
    const launch = window.setTimeout(() => setLandingDealKey(activeDeal.key), launchDelay)
    const complete = window.setTimeout(onDealComplete, launchDelay + travelDuration)
    return () => {
      window.clearTimeout(launch)
      window.clearTimeout(complete)
    }
  }, [activeDeal, onDealComplete, reducedMotion])

  return <main className="min-h-screen bg-night px-3 py-4 text-parchment md:px-6 md:py-6">
    <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4"><div><p className="text-xs font-bold tracking-[0.08em] text-bronze uppercase">Round {state.roundNumber}</p><h1 className="font-display text-2xl font-bold">Favour of Olympus</h1></div><div className="flex items-center gap-4"><p className="hidden text-sm text-slate-400 sm:block">First to 200 wins</p>{isHost && <button type="button" onClick={onEnd} className="rounded-lg border border-red-400/60 px-3 py-2 text-sm font-bold text-red-200 transition hover:bg-red-950/60 focus:outline-none focus:ring-2 focus:ring-red-300">End game</button>}</div></header>
    <section className="mx-auto mt-7 w-full max-w-7xl" aria-label="Game table">
      <div className="table-layout" data-players={state.players.length}>
        <LayoutGroup id={`game-table-${state.id}`}>
          <Leaderboard players={state.players} roundGods={roundGods} />
          <div className="table-layout__deck"><GameCard card={numberCardDefinition(0)} face="back" size="table" /><p><strong>{state.remainingCardCount}</strong> cards left</p></div>
          <ol className="contents">{state.players.map((player) => <PlayerArea key={player.id} player={player} position={tablePositionFor(player.id, playerId, state.players.map((candidate) => candidate.id))} isCurrent={player.id === currentPlayer?.id} isYou={player.id === playerId} pendingCardIds={pendingCardIds} hasIncomingCard={pendingRecipientIds.has(player.id)} reducedMotion={reducedMotion} onInspectCards={(cards) => setInspectedHand({ cards, playerName: player.name })} />)}</ol>
          {activeDeal !== undefined && landingDealKey !== activeDeal.key && <DealingCard key={activeDeal.key} deal={activeDeal} reducedMotion={reducedMotion} />}
          {showTurnChoice && <aside className="game-action-panel" aria-live="polite"><h2 className="font-display text-lg font-bold">Your choice</h2>{you === undefined ? <p className="mt-1 text-sm text-slate-400">Waiting for your seat.</p> : isYourTurn ? <><p className="mt-1 text-sm leading-relaxed text-slate-300">Press your luck, or preserve this round’s score.</p><div className="mt-3 grid grid-cols-2 gap-2"><button type="button" onClick={() => onCommand("HIT")} className="rounded-lg bg-bronze px-3 py-2.5 font-bold text-night transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-bronze">Hit</button><button type="button" onClick={() => onCommand("STAY")} disabled={you.numberCards.length === 0} className="rounded-lg border border-slate-500 px-3 py-2.5 font-bold transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-45">Stay</button></div></> : null}{error && <p className="mt-3 rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-200" role="alert">{error}</p>}</aside>}
          {pendingChoice !== null && <div className="god-choice-overlay"><aside className="game-action-panel game-action-panel--god" role="dialog" aria-modal="true" aria-labelledby="god-choice-title"><p className="game-action-panel__god">{godCardDefinition(pendingChoice.god).deityName}</p><h2 id="god-choice-title">Choose an action</h2><GodChoicePanel choice={pendingChoice} players={state.players} onSubmit={onSubmitChoice} />{error && <p className="mt-3 rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-200" role="alert">{error}</p>}</aside></div>}
          <AnimatePresence>
            {state.phase === "roundScoring" && <RoundScoringOverlay state={state} isHost={isHost} error={error} onAdvance={() => onCommand("ADVANCE_ROUND")} onInspectCards={(cards, playerName) => setInspectedHand({ cards, playerName })} />}
          </AnimatePresence>
        </LayoutGroup>
      </div>
    </section>
    <AnimatePresence>
      {inspectedHand !== null && <HandInspectionOverlay cards={inspectedHand.cards} playerName={inspectedHand.playerName} onClose={() => setInspectedHand(null)} />}
    </AnimatePresence>
  </main>
}

type RoundPlayer = GameSnapshot["state"]["players"][number]

type RoundScoreBreakdown = {
  readonly numberTotal: number
  readonly demeterBonus: number
  readonly multiplier: number
  readonly additiveBonus: number
  readonly favourOfOlympusBonus: number
  readonly nikeBonus: number
  readonly roundScore: number
}

function RoundScoringOverlay({ state, isHost, error, onAdvance, onInspectCards }: { readonly state: GameSnapshot["state"]; readonly isHost: boolean; readonly error: string | null; readonly onAdvance: () => void; readonly onInspectCards: (cards: readonly CardDefinition[], playerName: string) => void }) {
  const reducedMotion = useReducedMotion()
  const players = [...state.players].sort((left, right) => left.seat - right.seat)
  const [activeIndex, setActiveIndex] = useState(0)
  const player = players[activeIndex] ?? players[0]
  if (player === undefined) return null

  const achievedFavourOfOlympus = state.favourOfOlympusPlayerIds.includes(player.id)
  const breakdown = scoreBreakdownFor(player, achievedFavourOfOlympus)
  const previousTotal = player.totalScore - breakdown.roundScore
  const isLastPlayer = activeIndex === players.length - 1
  const cards = [
    ...player.numberCards.map((card) => ({ id: card.instanceId, definition: numberCardDefinition(card.value) })),
    ...player.modifierCards.map((card) => ({ id: card.instanceId, definition: modifierCardDefinition(card.operation, card.value) })),
    ...player.godCardsInFront.map((card) => ({ id: card.id, definition: godCardDefinition(card.god) })),
  ]
  const calculationSteps = scoreCalculationSteps(player, breakdown)
  const transition = { duration: reducedMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] as const }

  return <motion.div
    className="round-summary"
    role="dialog"
    aria-modal="true"
    aria-labelledby="round-summary-title"
    initial={{ opacity: 0, backdropFilter: "blur(0px)" }}
    animate={{ opacity: 1, backdropFilter: reducedMotion ? "blur(0px)" : "blur(7px)" }}
    exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
    transition={transition}
  >
    <section className="round-summary__panel">
      <header className="round-summary__header">
        <div><p>Round {state.roundNumber} complete</p><h2 id="round-summary-title">The scores are in</h2></div>
        <span>{activeIndex + 1} of {players.length}</span>
      </header>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          className="round-summary__player"
          key={player.id}
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -18 }}
          transition={transition}
        >
          <div className="round-summary__identity">
            <div><h3>{player.name}</h3><p>{player.roundStatus === "busted" ? "Busted this round" : achievedFavourOfOlympus ? "Earned Favour of Olympus" : "Round secured"}</p></div>
            <strong className={player.roundStatus === "busted" ? "round-summary__award round-summary__award--bust" : "round-summary__award"}>+{breakdown.roundScore}</strong>
          </div>

          <div
            className="round-summary__hand"
            aria-label={`View all cards held by ${player.name}`}
            role={cards.length > 0 ? "button" : undefined}
            tabIndex={cards.length > 0 ? 0 : undefined}
            onClick={() => cards.length > 0 && onInspectCards(cards.map((entry) => entry.definition), player.name)}
            onKeyDown={(event) => {
              if (cards.length > 0 && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault()
                onInspectCards(cards.map((entry) => entry.definition), player.name)
              }
            }}
          >
            {cards.length === 0
              ? <p>No cards in front</p>
              : cards.map((card, index) => <motion.div key={card.id} initial={reducedMotion ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...transition, delay: reducedMotion ? 0 : Math.min(index, 6) * 0.05 }}><GameCard card={card.definition} size="table" /></motion.div>)}
          </div>

          <div className="round-summary__calculation" aria-label="Score calculation">
            {calculationSteps.map((step, index) => <motion.div key={step.label} initial={reducedMotion ? false : { opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} transition={{ ...transition, delay: reducedMotion ? 0 : 0.18 + index * 0.07 }}><span>{step.label}</span><strong>{step.value}</strong></motion.div>)}
          </div>

          <div className="round-summary__total">
            <span>Total score</span>
            <p><small>{previousTotal}</small><b>+</b><strong>{breakdown.roundScore}</strong><b>=</b><em>{player.totalScore}</em></p>
          </div>
        </motion.div>
      </AnimatePresence>

      <footer className="round-summary__footer">
        {error && <p role="alert">{error}</p>}
        {!isLastPlayer
          ? <button type="button" onClick={() => setActiveIndex((current) => Math.min(current + 1, players.length - 1))}>Next player</button>
          : isHost
            ? <button type="button" onClick={onAdvance}>{state.winnerId === null ? "Start next round" : "Reveal winner"}</button>
            : <p>Waiting for the host to continue…</p>}
      </footer>
    </section>
  </motion.div>
}

function scoreBreakdownFor(player: RoundPlayer, achievedFavourOfOlympus: boolean): RoundScoreBreakdown {
  if (player.roundStatus === "busted") return { numberTotal: 0, demeterBonus: 0, multiplier: 1, additiveBonus: 0, favourOfOlympusBonus: 0, nikeBonus: 0, roundScore: 0 }
  const numberTotal = player.numberCards.reduce((sum, card) => sum + card.value, 0)
  const lowestNumber = player.numberCards.length === 0 ? 0 : Math.min(...player.numberCards.map((card) => card.value))
  const demeterBonus = lowestNumber * player.godEffects.filter((effect) => effect.kind === "demeter").length
  const multiplier = player.modifierCards.some((card) => card.operation === "multiply") ? 2 : 1
  const additiveBonus = player.modifierCards.reduce((sum, card) => sum + (card.operation === "add" ? card.value : 0), 0)
  const favourOfOlympusBonus = achievedFavourOfOlympus ? 15 : 0
  const nikeBonus = achievedFavourOfOlympus ? player.godEffects.filter((effect) => effect.kind === "nike").length * 10 : 0
  const roundScore = (numberTotal + demeterBonus) * multiplier + additiveBonus + favourOfOlympusBonus + nikeBonus
  return { numberTotal, demeterBonus, multiplier, additiveBonus, favourOfOlympusBonus, nikeBonus, roundScore }
}

function scoreCalculationSteps(player: RoundPlayer, breakdown: RoundScoreBreakdown): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  if (player.roundStatus === "busted") return [{ label: "Duplicate number — round bust", value: "0" }]
  const steps: Array<{ readonly label: string; readonly value: string }> = [{ label: "Number cards", value: `${breakdown.numberTotal}` }]
  if (breakdown.demeterBonus > 0) steps.push({ label: "Demeter's harvest", value: `+${breakdown.demeterBonus}` })
  if (breakdown.multiplier > 1) steps.push({ label: "×2 modifier", value: `×${breakdown.multiplier}` })
  if (breakdown.additiveBonus > 0) steps.push({ label: "Number modifiers", value: `+${breakdown.additiveBonus}` })
  if (breakdown.favourOfOlympusBonus > 0) steps.push({ label: "Favour of Olympus bonus", value: `+${breakdown.favourOfOlympusBonus}` })
  if (breakdown.nikeBonus > 0) steps.push({ label: "Nike bonus", value: `+${breakdown.nikeBonus}` })
  steps.push({ label: "Round award", value: `${breakdown.roundScore}` })
  return steps
}

function HandInspectionOverlay({ cards, playerName, onClose }: { readonly cards: readonly CardDefinition[]; readonly playerName: string; readonly onClose: () => void }) {
  const reducedMotion = useReducedMotion()
  const transition = { duration: reducedMotion ? 0 : 0.26, ease: [0.22, 1, 0.36, 1] as const }

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [onClose])

  return <motion.div
    className="card-inspection"
    role="dialog"
    aria-modal="true"
    aria-label={`${playerName}'s cards`}
    onClick={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}
    initial={{ opacity: 0, backdropFilter: "blur(0px)" }}
    animate={{ opacity: 1, backdropFilter: reducedMotion ? "blur(0px)" : "blur(8px)" }}
    exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
    transition={transition}
  >
    <motion.section className="card-inspection__content" initial={reducedMotion ? false : { opacity: 0, scale: 0.9, y: 18 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 10 }} transition={transition}>
      <button type="button" className="card-inspection__close" onClick={onClose} autoFocus aria-label="Close card viewer">×</button>
      <div className="card-inspection__cards" aria-label={`${playerName}'s ${cards.length} cards`}>
        {cards.map((card, index) => <motion.div
          key={`${cardName(card)}-${index}`}
          initial={reducedMotion ? false : { opacity: 0, y: 24, rotate: index % 2 === 0 ? -2 : 2, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.96 }}
          transition={{ ...transition, delay: reducedMotion ? 0 : Math.min(index, 7) * 0.045 }}
        ><GameCard card={card} size="hand" /></motion.div>)}
      </div>
    </motion.section>
  </motion.div>
}

function cardName(card: CardDefinition): string {
  return card.kind === "number" ? `${card.figureName} · ${card.value}` : `${card.deityName} · ${card.effectName}`
}

function DealingCard({ deal, reducedMotion }: { readonly deal: DealAnimation; readonly reducedMotion: boolean | null }) {
  return <motion.div
    className="deal-animation"
    aria-hidden="true"
    layoutId={dealLayoutId(deal.cardId)}
    initial={reducedMotion ? { opacity: 0 } : { opacity: 1, rotate: -4, scale: 0.88 }}
    animate={reducedMotion ? { opacity: 1 } : { opacity: 1, rotate: 0, scale: 1 }}
    transition={{ duration: reducedMotion ? 0 : 0.5, ease: [0.22, 1, 0.36, 1] }}
  >
    <GameCard card={deal.card} size="table" />
  </motion.div>
}

function PlayerArea({ player, position, isCurrent, isYou, pendingCardIds, hasIncomingCard, reducedMotion, onInspectCards }: { readonly player: GameSnapshot["state"]["players"][number]; readonly position: "top" | "left" | "right" | "bottom"; readonly isCurrent: boolean; readonly isYou: boolean; readonly pendingCardIds: ReadonlySet<string>; readonly hasIncomingCard: boolean; readonly reducedMotion: boolean | null; readonly onInspectCards: (cards: readonly CardDefinition[]) => void }) {
  const cards = [
    ...player.numberCards.map((card) => ({ id: card.instanceId, definition: numberCardDefinition(card.value) })),
    ...player.modifierCards.map((card) => ({ id: card.instanceId, definition: modifierCardDefinition(card.operation, card.value) })),
    ...player.godCardsInFront.map((card) => ({ id: card.id, definition: godCardDefinition(card.god) })),
  ].filter((card) => !pendingCardIds.has(card.id))
  const cardDefinitions = cards.map((card) => card.definition)
  return <li
    data-player-id={player.id}
    data-inspectable={cards.length > 0 || undefined}
    className={`table-player table-player--${position} ${isCurrent ? "table-player--active" : ""} ${isYou ? "table-player--you" : ""}`}
    role={cards.length > 0 ? "button" : undefined}
    tabIndex={cards.length > 0 ? 0 : undefined}
    aria-label={cards.length > 0 ? `View all cards held by ${player.name}` : undefined}
    onClick={() => cards.length > 0 && onInspectCards(cardDefinitions)}
    onKeyDown={(event) => {
      if (cards.length > 0 && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault()
        onInspectCards(cardDefinitions)
      }
    }}
  ><div className="table-player__identity"><div><p>{player.name}{isYou && <span>You</span>}</p>{player.roundStatus !== "active" && <small>{player.roundStatus}</small>}</div></div><div className="table-player__hand">{cards.length > 0 ? cards.map((card, index) => <motion.div key={card.id} layout="position" layoutId={dealLayoutId(card.id)} transition={{ layout: { duration: reducedMotion ? 0 : 0.5, ease: [0.22, 1, 0.36, 1] } }} className={`table-player__card ${index === 0 ? "shrink-0" : "-ml-12 shrink-0 sm:-ml-10"}`}><GameCard card={card.definition} size="table" /></motion.div>) : <p>{hasIncomingCard ? "Dealing…" : "Waiting for a card"}</p>}</div></li>
}

function dealLayoutId(cardId: string): string { return `dealt-card-${cardId}` }

function Leaderboard({ players, roundGods }: { readonly players: readonly GameSnapshot["state"]["players"][number][]; readonly roundGods: readonly { readonly id: string; readonly god: string }[] }) {
  const ranking = [...players].sort((left, right) => right.totalScore - left.totalScore || left.seat - right.seat)
  return <aside className="table-leaderboard" aria-label="Current scores"><p>Current scores</p><ol>{ranking.map((player) => <li key={player.id}><span>{player.name}</span><strong>{player.totalScore}</strong></li>)}</ol>{roundGods.length > 0 && <div className="table-leaderboard__gods"><p>Gods invoked</p><div>{roundGods.map((card) => <GameCard key={card.id} card={godCardDefinition(card.god)} size="table" />)}</div></div>}</aside>
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
    zeus: { deityName: "Zeus", effectName: "Thunderbolt", description: "Discard the next duplicate Number Card you draw instead of busting. One Zeus at a time.", artwork: "cards/powers/gods/zeus.png", theme: "storm" },
    ares: { deityName: "Ares", effectName: "War Cry", description: "Choose an active player. They draw up to 3 cards, stopping if their turn ends.", artwork: "cards/powers/gods/ares.png", theme: "ember" },
    dionysus: { deityName: "Dionysus", effectName: "Revelry", description: "Choose an active player. They immediately stay and keep their current round score.", artwork: "cards/powers/gods/dionysus.png", theme: "ember" },
    athena: { deityName: "Athena", effectName: "Strategy", description: "Look at the next 3 cards. Return them to the top in any order.", artwork: "cards/powers/gods/athena.png", theme: "storm" },
    hades: { deityName: "Hades", effectName: "Underworld", description: "Give a discarded Number Card to any active player. Resolve it normally.", artwork: "cards/powers/gods/hades.png", theme: "storm" },
    hermes: { deityName: "Hermes", effectName: "Swift Exchange", description: "Swap one Number Card between two active players. Resolve both cards normally.", artwork: "cards/powers/gods/hermes.png", theme: "storm" },
    artemis: { deityName: "Artemis", effectName: "Hunt", description: "Remove one Number Card from any active player.", artwork: "cards/powers/gods/artemis.png", theme: "frost" },
    aphrodite: { deityName: "Aphrodite", effectName: "Charm", description: "Choose 2 active players. Copy the next Number or Modifier to both; resolve a God yourself.", artwork: "cards/powers/gods/aphrodite.png", theme: "ember" },
    hephaestus: { deityName: "Hephaestus", effectName: "Forge", description: "Give a discarded Modifier to any active player. If none remain, gain +4.", artwork: "cards/powers/gods/hephaestus.png", theme: "ember" },
    demeter: { deityName: "Demeter", effectName: "Harvest", description: "Choose an active player. At scoring, add their lowest Number Card to their number total.", artwork: "cards/powers/gods/demeter.png", theme: "frost" },
    nike: { deityName: "Nike", effectName: "Victory", description: "If you Flip Seven this round, score +10 after the normal +15 bonus.", artwork: "cards/powers/gods/nike.png", theme: "frost" },
    prometheus: { deityName: "Prometheus", effectName: "Borrowed Fire", description: "Repeat the God resolved immediately before this card. Prometheus cannot copy itself.", artwork: "cards/powers/gods/prometheus.png", theme: "ember" },
  }
  const presentation = details[god] ?? { deityName: "Olympus", effectName: "Godly intervention", description: "Invoke a god’s power.", artwork: "cards/powers/placeholder.svg" as AssetKey, theme: "storm" as const }
  return { kind: "power", ...presentation, typography: { descriptionSize: "small" }, icon: "cards/icons/placeholder.svg" }
}


function validUsername(value: string): boolean { return /^[a-zA-Z0-9 _-]{2,64}$/.test(value.trim()) }
function toPlayerId(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, "-") }
function makeRoomCode(): string { return `OLY-${crypto.randomUUID().slice(0, 6).toUpperCase()}` }
function readSession(): StoredSession | null { try { const value = sessionStorage.getItem("favour-of-olympus-session"); return value === null ? null : JSON.parse(value) as StoredSession } catch { return null } }
