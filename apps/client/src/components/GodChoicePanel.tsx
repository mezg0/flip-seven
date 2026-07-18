import { useEffect, useState, type ReactNode } from "react"
import type { GameSnapshot } from "@favour-of-olympus/protocol"

type PendingChoice = Exclude<GameSnapshot["state"]["pendingChoice"], null>
type Player = GameSnapshot["state"]["players"][number]
type ChoiceCard = {
  readonly id: string
  readonly kind: "number" | "modifier" | "god"
  readonly value?: number
  readonly operation?: "add" | "multiply"
}
type SubmitChoice = (choiceId: string, selection: unknown) => void

export function GodChoicePanel({ choice, players, onSubmit }: { readonly choice: PendingChoice; readonly players: readonly Player[]; readonly onSubmit: SubmitChoice }) {
  switch (choice.kind) {
    case "choosePlayers":
      return <PlayerChoice choice={choice} players={players} onSubmit={onSubmit} />
    case "choosePlayerNumber":
      return <NumberChoice choice={choice} players={players} onSubmit={onSubmit} />
    case "chooseHermesExchange":
      return <HermesChoice choice={choice} players={players} onSubmit={onSubmit} />
    case "chooseDiscardNumber":
    case "chooseDiscardModifier":
      return <DiscardChoice choice={choice} players={players} onSubmit={onSubmit} />
    case "reorderDeckTop":
      return <DeckOrderChoice choice={choice} onSubmit={onSubmit} />
  }
}

function PlayerChoice({ choice, players, onSubmit }: { readonly choice: Extract<PendingChoice, { readonly kind: "choosePlayers" }>; readonly players: readonly Player[]; readonly onSubmit: SubmitChoice }) {
  const [selected, setSelected] = useState<readonly string[]>([])
  useEffect(() => setSelected([]), [choice.id])
  const eligible = players.filter((player) => choice.eligiblePlayerIds.includes(player.id))
  const toggle = (id: string) => setSelected((current) => current.includes(id)
    ? current.filter((candidate) => candidate !== id)
    : current.length < choice.max ? [...current, id] : current)
  const required = choice.min === choice.max
    ? `${choice.min} player${choice.min === 1 ? "" : "s"}`
    : `${choice.min}–${choice.max} players`

  return <div className="god-choice">
    <p>Select {required}. Each eligible player has a separate action area.</p>
    <PlayerGrid players={eligible}>{(player) => <button type="button" aria-pressed={selected.includes(player.id)} data-selected={selected.includes(player.id) || undefined} onClick={() => toggle(player.id)}>Select player</button>}</PlayerGrid>
    <button type="button" className="god-choice__confirm" disabled={selected.length < choice.min || selected.length > choice.max} onClick={() => onSubmit(choice.id, selected)}>Confirm {selected.length > 0 ? `(${selected.length})` : ""}</button>
  </div>
}

function NumberChoice({ choice, players, onSubmit }: { readonly choice: Extract<PendingChoice, { readonly kind: "choosePlayerNumber" }>; readonly players: readonly Player[]; readonly onSubmit: SubmitChoice }) {
  const eligible = eligiblePlayers(choice.eligible, players)
  return <div className="god-choice">
    <p>Choose one number card. Cards are grouped by their active player.</p>
    <PlayerGrid players={eligible}>{(player) => {
      const entry = choice.eligible.find((candidate) => candidate.playerId === player.id)
      return entry?.instanceIds.map((instanceId) => {
        const card = player.numberCards.find((candidate) => candidate.instanceId === instanceId)
        return card === undefined ? null : <button key={instanceId} type="button" onClick={() => onSubmit(choice.id, { playerId: player.id, instanceId })}>Number {card.value}</button>
      })
    }}</PlayerGrid>
  </div>
}

function HermesChoice({ choice, players, onSubmit }: { readonly choice: Extract<PendingChoice, { readonly kind: "chooseHermesExchange" }>; readonly players: readonly Player[]; readonly onSubmit: SubmitChoice }) {
  const [selected, setSelected] = useState<readonly { readonly playerId: string; readonly instanceId: string }[]>([])
  useEffect(() => setSelected([]), [choice.id])
  const eligible = eligiblePlayers(choice.eligible, players)
  const choose = (playerId: string, instanceId: string) => setSelected((current) => {
    if (current.some((card) => card.instanceId === instanceId)) {
      return current.filter((card) => card.instanceId !== instanceId)
    }
    const withoutSamePlayer = current.filter((card) => card.playerId !== playerId)
    return [...withoutSamePlayer.slice(-1), { playerId, instanceId }]
  })

  return <div className="god-choice">
    <p>Choose one number card from each of two different players.</p>
    <PlayerGrid players={eligible}>{(player) => {
      const entry = choice.eligible.find((candidate) => candidate.playerId === player.id)
      return entry?.instanceIds.map((instanceId) => {
        const card = player.numberCards.find((candidate) => candidate.instanceId === instanceId)
        const isSelected = selected.some((candidate) => candidate.instanceId === instanceId)
        return card === undefined ? null : <button key={instanceId} type="button" aria-pressed={isSelected} data-selected={isSelected || undefined} onClick={() => choose(player.id, instanceId)}>Number {card.value}</button>
      })
    }}</PlayerGrid>
    <button type="button" className="god-choice__confirm" disabled={selected.length !== 2} onClick={() => onSubmit(choice.id, { left: selected[0], right: selected[1] })}>Exchange cards</button>
  </div>
}

function DiscardChoice({ choice, players, onSubmit }: { readonly choice: Extract<PendingChoice, { readonly kind: "chooseDiscardNumber" | "chooseDiscardModifier" }>; readonly players: readonly Player[]; readonly onSubmit: SubmitChoice }) {
  const [cardId, setCardId] = useState<string | null>(null)
  const [targetId, setTargetId] = useState<string | null>(null)
  useEffect(() => { setCardId(null); setTargetId(null) }, [choice.id])
  const cards = (choice.cards ?? []) as readonly ChoiceCard[]
  const targets = players.filter((player) => choice.eligiblePlayerIds.includes(player.id))
  const label = choice.kind === "chooseDiscardNumber" ? "number" : "modifier"

  return <div className="god-choice">
    <p>Choose a discarded {label}, then choose the active player who receives it.</p>
    <section className="god-choice__card-pool" aria-labelledby="discarded-card-heading">
      <h3 id="discarded-card-heading">Discarded {label} cards</h3>
      <div className="god-choice__options">{cards.map((card) => <button key={card.id} type="button" aria-pressed={card.id === cardId} data-selected={card.id === cardId || undefined} onClick={() => setCardId(card.id)}>{choiceCardLabel(card)}</button>)}</div>
    </section>
    <h3 className="god-choice__section-title">Choose recipient</h3>
    <PlayerGrid players={targets}>{(player) => <button type="button" aria-pressed={player.id === targetId} data-selected={player.id === targetId || undefined} onClick={() => setTargetId(player.id)}>Give to {player.name}</button>}</PlayerGrid>
    <button type="button" className="god-choice__confirm" disabled={cardId === null || targetId === null} onClick={() => onSubmit(choice.id, { physicalCardId: cardId, targetId })}>Confirm</button>
  </div>
}

function DeckOrderChoice({ choice, onSubmit }: { readonly choice: Extract<PendingChoice, { readonly kind: "reorderDeckTop" }>; readonly onSubmit: SubmitChoice }) {
  const [order, setOrder] = useState<readonly string[]>(choice.physicalCardIds ?? [])
  useEffect(() => setOrder(choice.physicalCardIds ?? []), [choice.id, choice.physicalCardIds])
  const cardsById = new Map(((choice.cards ?? []) as readonly ChoiceCard[]).map((card) => [card.id, card]))
  const move = (index: number, direction: -1 | 1) => setOrder((current) => {
    const destination = index + direction
    if (destination < 0 || destination >= current.length) return current
    const next = [...current]
    const currentCard = next[index]
    const destinationCard = next[destination]
    if (currentCard === undefined || destinationCard === undefined) return current
    next[index] = destinationCard
    next[destination] = currentCard
    return next
  })

  return <div className="god-choice">
    <p>Arrange the next cards in draw order.</p>
    <div className="god-choice__order">{order.map((id, index) => <div key={id}><span>{index + 1}. {choiceCardLabel(cardsById.get(id))}</span><button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${choiceCardLabel(cardsById.get(id))} earlier`}>↑</button><button type="button" onClick={() => move(index, 1)} disabled={index === order.length - 1} aria-label={`Move ${choiceCardLabel(cardsById.get(id))} later`}>↓</button></div>)}</div>
    <button type="button" className="god-choice__confirm" onClick={() => onSubmit(choice.id, order)}>Set order</button>
  </div>
}

function PlayerGrid({ players, children }: { readonly players: readonly Player[]; readonly children: (player: Player) => ReactNode }) {
  return <div className="god-choice__players">{players.map((player) => <section className="god-choice__player" key={player.id} aria-labelledby={`choice-player-${player.id}`}>
    <header><span aria-hidden="true">{player.seat + 1}</span><h3 id={`choice-player-${player.id}`}>{player.name}</h3></header>
    <div className="god-choice__options">{children(player)}</div>
  </section>)}</div>
}

function eligiblePlayers(eligible: ReadonlyArray<{ readonly playerId: string }>, players: readonly Player[]): Player[] {
  const eligibleIds = new Set(eligible.map((entry) => entry.playerId))
  return players.filter((player) => eligibleIds.has(player.id))
}

function choiceCardLabel(card: ChoiceCard | undefined): string {
  if (card === undefined) return "Unknown card"
  if (card.kind === "number") return `Number ${card.value ?? ""}`
  if (card.kind === "modifier") return card.operation === "multiply" ? "Double modifier" : `+${card.value ?? ""} modifier`
  return "God card"
}
