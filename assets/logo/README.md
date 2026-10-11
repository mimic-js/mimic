# Mimic logo explorations

Six directions for the Mimic mark: a chameleon, because the runtime mimics Node.js inside the browser, drawn in a green palette that nods to Node. Open `contact-sheet.html` to compare them all on white and on `#0f1117`. `contact-sheet.png` is a rendered snapshot of that page.

Each variant has three files: `NN-name.svg` (the mark, 256×256, transparent, works on light and dark), `NN-name-wordmark.svg` (the mark plus "Mimic" in dark ink, for light backgrounds) and `NN-name-wordmark-dark.svg` (light ink, for dark backgrounds). The "Mimic" lettering is a custom monoline set drawn as paths, so it needs no font.

- **01-chameleon-hex**: a light chameleon silhouette on a branch, with a spiral tail, inside a rounded Node-style hexagon. Palette: `#66BB6A`→`#1B5E20` gradient, `#F1F8E9` body, amber `#FFB300` eye.
- **02-geometric-chameleon**: a low-poly chameleon head with a faceted casque, a long smile and a throat crest. Palette: seven greens from `#A5D6A7` to `#1B5E20`, amber `#FFB300` iris.
- **03-chameleon-curl**: a coiled chameleon whose body is one tapering spiral that ends in the curled tail. Palette: `#2E7D32`→`#66BB6A` gradient, teal `#26A69A` eye.
- **04-eye-mark**: the turret eye as a round badge, with off-centre rings that suggest the eye swivelling and a ring of skin granules. Palette: `#1B5E20`, `#2E7D32`, `#3E9B4F`, `#66BB6A`, amber `#FFB300` iris.
- **05-terminal-chameleon**: a terminal window whose `>` prompt is a chameleon head (casque nub and turret eye) and whose `_` cursor is amber. Palette: `#2E7D32`→`#1B5E20` tile, `#E8F5E9` glyph, amber `#FFB300`.
- **06-minimal-line**: a single-weight line chameleon on a branch, with a spiral tail. It uses one colour, so it can be printed in any one colour. Palette: `#43A047` mark, `#2E7D32` / `#66BB6A` in the light and dark wordmarks. `06-minimal-line-mono.svg` uses `currentColor` for inline SVG.

Suggested README usage, with a theme switch:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo/01-chameleon-hex-wordmark-dark.svg">
  <img alt="Mimic" src="assets/logo/01-chameleon-hex-wordmark.svg" height="80">
</picture>
```
