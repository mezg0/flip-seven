/** Stable keys that allow game content to refer to client-owned artwork. */
export type AssetKey = `cards/${string}` | `sounds/${string}` | `branding/${string}`

export type NumberValue = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12

export type CardTheme = "bronze" | "storm" | "ember" | "frost"
export type CardTextSize = "small" | "medium" | "large"
export type CardTextWeight = "regular" | "medium" | "bold"

export interface PowerCardTypography {
  readonly deitySize?: CardTextSize
  readonly deityWeight?: CardTextWeight
  readonly effectSize?: CardTextSize
  readonly effectWeight?: CardTextWeight
  readonly descriptionSize?: CardTextSize
  readonly descriptionWeight?: CardTextWeight
  readonly effectLines?: readonly string[]
  readonly descriptionLines?: readonly string[]
}

export interface NumberCardDefinition {
  readonly kind: "number"
  readonly value: NumberValue
  readonly figureName: string
  readonly typography?: NumberCardTypography
  readonly artwork: AssetKey
}

export interface NumberCardTypography {
  readonly valueSize?: CardTextSize
  readonly nameSize?: CardTextSize
}

export const numberCardDefinitions = {
  0: { kind: "number", value: 0, figureName: "Sisyphus", artwork: "cards/numbers/00-sisyphus.webp" },
  1: { kind: "number", value: 1, figureName: "Achilles", artwork: "cards/numbers/01-achilles.webp" },
  2: { kind: "number", value: 2, figureName: "Atalanta", artwork: "cards/numbers/02-atalanta.webp" },
  3: { kind: "number", value: 3, figureName: "Heracles", artwork: "cards/numbers/03-heracles.webp" },
  4: { kind: "number", value: 4, figureName: "Perseus", artwork: "cards/numbers/04-perseus.webp" },
  5: { kind: "number", value: 5, figureName: "Theseus", artwork: "cards/numbers/05-theseus.webp" },
  6: { kind: "number", value: 6, figureName: "Odysseus", artwork: "cards/numbers/06-odysseus.webp" },
  7: { kind: "number", value: 7, figureName: "Bellerophon", artwork: "cards/numbers/07-bellerophon.webp" },
  8: { kind: "number", value: 8, figureName: "Jason", artwork: "cards/numbers/08-jason.webp" },
  9: { kind: "number", value: 9, figureName: "Medea", artwork: "cards/numbers/09-medea.webp" },
  10: { kind: "number", value: 10, figureName: "Orpheus", artwork: "cards/numbers/10-orpheus.webp" },
  11: { kind: "number", value: 11, figureName: "Ariadne", artwork: "cards/numbers/11-ariadne.webp" },
  12: { kind: "number", value: 12, figureName: "Penthesilea", artwork: "cards/numbers/12-penthesilea.webp" },
} as const satisfies Record<NumberValue, NumberCardDefinition>

export function numberCardDefinition(value: number): NumberCardDefinition {
  const definition = numberCardDefinitions[value as NumberValue]

  if (definition === undefined) {
    throw new RangeError(`Number card value must be between 0 and 12; received ${value}.`)
  }

  return definition
}

export interface PowerCardDefinition {
  readonly kind: "power"
  readonly effectName: string
  readonly deityName: string
  readonly description: string
  readonly typography?: PowerCardTypography
  readonly artwork: AssetKey
  readonly icon: AssetKey
  readonly theme: Exclude<CardTheme, "bronze">
}

export type CardDefinition = NumberCardDefinition | PowerCardDefinition
