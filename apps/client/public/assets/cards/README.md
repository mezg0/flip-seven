# Card assets

Card artwork uses a 5:7 aspect ratio. Create source artwork at a minimum of
`1500 × 2100` pixels and export production images as WebP or AVIF.

## Naming

- Number art: `numbers/00-character-name.webp`
- Power art: `powers/effect-god-name.webp`
- Icons: `icons/effect-name.svg`
- Card backs: `backs/default.webp`

Keep faces, weapons, and other important details clear of the top-left,
bottom-right, and bottom-label safe areas. The React card component owns the
numerals, labels, frames, and interaction states; do not bake them into artwork.

The placeholder SVGs define the expected aspect ratio and can be replaced once
the first character illustrations are ready.
