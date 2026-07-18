import type { CardDefinition } from "@flip-seven/content"
import "./GameCard.css"

export interface GameCardProps {
  readonly card: CardDefinition
  readonly face?: "front" | "back"
  readonly size?: "table" | "hand" | "preview"
  readonly selected?: boolean
  readonly disabled?: boolean
}

const assetUrl = (asset: string) => `/assets/${asset}`

function getAccessibleName(card: CardDefinition, face: "front" | "back") {
  if (face === "back") {
    return "Face-down card"
  }

  if (card.kind === "number") {
    return `${card.value}, ${card.figureName}, number card`
  }

  return `${card.deityName}, ${card.effectName}. ${card.description}`
}

function getRuleLines(description: string) {
  return description.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((line) => line.trim()) ?? [description]
}

function getConfiguredLines(configuredLines: readonly string[] | undefined, fallback: readonly string[]) {
  return configuredLines?.length ? configuredLines : fallback
}

export function GameCard({
  card,
  face = "front",
  size = "table",
  selected = false,
  disabled = false,
}: GameCardProps) {
  const theme = card.kind === "power" ? card.theme : "bronze"

  return (
    <div
      className="game-card"
      data-disabled={disabled || undefined}
      data-face={face}
      data-kind={card.kind}
      data-selected={selected || undefined}
      data-size={size}
      data-theme={theme}
      role="img"
      aria-label={getAccessibleName(card, face)}
    >
      {face === "back" ? (
        <>
          <img
            className="game-card__back"
            src={assetUrl("cards/backs/back-test.jpg")}
            alt=""
            draggable={false}
          />
        </>
      ) : (
        <>
          {card.kind === "number" ? (
            <div className="game-card__number-frame">
              <img
                className="game-card__artwork"
                src={assetUrl(card.artwork)}
                alt=""
                draggable={false}
              />
              <span className="game-card__series" aria-hidden="true">Number card</span>
              <span
                className="game-card__value"
                data-text-size={card.typography?.valueSize}
                aria-hidden="true"
              >
                {card.value}
              </span>
              <div className="game-card__identity">
                <span className="game-card__name" data-text-size={card.typography?.nameSize}>
                  {card.figureName}
                </span>
                <span className="game-card__kind">Demigod</span>
              </div>
            </div>
          ) : (
            <div className="game-card__power-frame">
              <div className="game-card__power-header">
                <span
                  className="game-card__deity"
                  data-text-size={card.typography?.deitySize}
                  data-text-weight={card.typography?.deityWeight}
                >
                  {card.deityName}
                </span>
              </div>
              <div className="game-card__art-window">
                <img
                  className="game-card__artwork"
                  src={assetUrl(card.artwork)}
                  alt=""
                  draggable={false}
                />
              </div>
              <div className="game-card__effect-bar">
                <span
                  className="game-card__effect"
                  data-text-size={card.typography?.effectSize}
                  data-text-weight={card.typography?.effectWeight}
                >
                  {getConfiguredLines(card.typography?.effectLines, [card.effectName]).map((line, index) => (
                    <span className="game-card__effect-line" key={`${index}-${line}`}>
                      {line}
                    </span>
                  ))}
                </span>
              </div>
              <div className="game-card__rules-panel">
                <span
                  className="game-card__description"
                  data-text-size={card.typography?.descriptionSize}
                  data-text-weight={card.typography?.descriptionWeight}
                >
                  {getConfiguredLines(card.typography?.descriptionLines, getRuleLines(card.description)).map((line, index) => (
                    <span className="game-card__description-line" key={`${index}-${line}`}>
                      {line}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
