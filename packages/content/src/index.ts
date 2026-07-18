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
