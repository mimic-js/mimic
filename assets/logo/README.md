# Mimic logo

The mark is a set of rings drawn off centre: a chameleon's turret eye, and a
runtime that mimics another from the inside. It uses two colours, lime
`#C8F169` and ink `#14211C`, and the lettering is a monoline set drawn as
paths, so no font is needed.

| File | Use |
| --- | --- |
| `mimic-mark.svg` | The mark in ink, on light backgrounds |
| `mimic-mark-lime.svg` | The mark in lime, on dark backgrounds |
| `mimic-wordmark.svg` | Mark and "Mimic", for light backgrounds |
| `mimic-wordmark-dark.svg` | Mark and "Mimic", for dark backgrounds |
| `mimic-icon.svg` | The mark on a lime tile: app icons, social avatars |
| `favicon.svg` | The tile with three heavier rings, which stay legible at 16 to 32 px |

The site's copies live in `apps/site/public`. README usage, with a theme
switch:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo/mimic-wordmark-dark.svg">
  <img alt="Mimic" src="assets/logo/mimic-wordmark.svg" height="80">
</picture>
```
