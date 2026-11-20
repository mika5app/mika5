# MIKA5 brand assets

This folder is the brand source for MIKA5 Community. It is written for development agents that will update the landing and other surfaces in a **follow-up pull request**.

**Do not edit `web/`, the desktop app, or any file outside `brand/` in the pull request that only adds these assets.**

Approved mark: **logo v2, concept B** (a continuous rounded stroke drawing the letter M, whose last leg curves out and ends in a cyan node, placed inside a simple laptop outline). Meaning: “AI on your machine.”

Preview of the full set: [`logo-v2/preview.png`](logo-v2/preview.png)

Related policy: [`TRADEMARK.md`](../TRADEMARK.md) at the repository root. The AGPL-3.0 license does not grant trademark rights to the name or logo.

---

## Palette

| Token    | Hex       | Use                                      |
|----------|-----------|------------------------------------------|
| Violet   | `#7C3AED` | Laptop outline, M stroke, filled base    |
| Cyan     | `#22D3EE` | Node dot only                            |
| Dark     | `#0B0F14` | App-icon background, dark lockup ground, wordmark on light |
| White    | `#FFFFFF` | Wordmark on dark, mono-white mark        |

Do not substitute other blues or purples. The cyan node is a distinctive part of the mark; do not recolor it independently or drop it.

---

## Typography

The official wordmark is **MIKA5** in all caps, set in **Space Grotesk Bold**.

The horizontal lockup SVGs already convert the letters to outlines. **Do not depend on a live font** when shipping the lockup. If you need to typeset “MIKA5” next to the symbol in a new layout, use Space Grotesk Bold (or the outlined lockup) and do not substitute another typeface.

---

## File inventory and intended use

All production files live in [`logo-v2/`](logo-v2/).

### Symbol (transparent)

| File | Use |
|------|-----|
| `mika5-symbol.svg` | Primary vector mark: laptop + M + node, transparent background. Prefer this for the site, docs, and any size above ~32 px. |
| `mika5-symbol-512.png` | Raster fallback of the symbol. |

### App icon (rounded square)

| File | Use |
|------|-----|
| `mika5-app-icon.svg` | Master app icon: symbol on `#0B0F14`, macOS-style ~22% corner radius. |
| `mika5-app-icon-1024.png` | Master PNG. Use this to replace the 1 MB `web/icon.png` used as the JSON-LD `logo`. |
| `mika5-app-icon-512.png` | General-purpose raster icon. |
| `mika5-app-icon-256.png` | High-density UI. |
| `mika5-app-icon-180.png` | **Apple Touch Icon.** Replaces `web/icon-180.png`. |
| `mika5-app-icon-128.png` | Mid-size UI. |
| `mika5-app-icon-64.png` | Header/footer UI icon and current 64 px favicon stand-in. Replaces `web/icon-64.png`. |

### Favicon (simplified mark, no laptop)

At 16 px the laptop outline disappears. These files use a thicker M + node only.

| File | Use |
|------|-----|
| `mika5-favicon.svg` | Preferred favicon for modern browsers (`rel="icon" type="image/svg+xml"`). |
| `favicon.ico` | Multi-size ICO containing 16, 32, and 48 px. Add as `web/favicon.ico`. |
| `favicon-16.png` | 16 px PNG favicon. |
| `favicon-32.png` | 32 px PNG favicon. |
| `favicon-48.png` | 48 px PNG (also packed into the ICO). |

### Monochrome

| File | Use |
|------|-----|
| `mika5-mono-white.svg` | Single-color white symbol for dark backgrounds. |
| `mika5-mono-dark.svg` | Single-color `#0B0F14` symbol for light backgrounds. |

### Horizontal lockups (symbol + “MIKA5” wordmark)

Wordmark text is outlined (no font dependency).

| File | Use |
|------|-----|
| `mika5-lockup-horizontal.svg` | Transparent background, dark wordmark. Default for light surfaces. |
| `mika5-lockup-horizontal-on-dark.svg` | Transparent background, white wordmark. For dark surfaces. |
| `mika5-lockup-horizontal-light.svg` | Same lockup on a white rectangle. |
| `mika5-lockup-horizontal-dark.svg` | Same lockup on `#0B0F14`. |
| `mika5-lockup-horizontal-*-256.png` / `*-512.png` | Raster lockups for light and dark, at 256 and 512 px tall. |

### Social / Open Graph

| File | Use |
|------|-----|
| `og-image-v2.png` | **1200×630** OG/Twitter image. Replaces `web/og-image.png`. Lossless PNG, ~94 KB (well under 120 KB). Keep `og:image:width` 1200 and `og:image:height` 630. |

### Preview

| File | Use |
|------|-----|
| `preview.png` | 1600×900 presentation board of the system (not for production pages). |

---

## Usage rules

1. **Do not distort.** Never stretch, squash, skew, or rotate the mark except in 90° increments if a layout truly requires it.
2. **Do not redraw or decorate.** No extra glows, drop shadows, outlines, gradients, or bevels on the mark. No circuit traces or the retired faceted “M” from the previous icon.
3. **Keep the construction intact.** Do not move, recolor, or omit the cyan node. Do not fill the laptop screen or change stroke weight.
4. **Clear space.** Leave at least **12.5% of the mark’s height** (about the diameter of the cyan node on the symbol) as empty margin on all sides. Do not crowd it with typography or other UI.
5. **Minimum sizes**
   - Favicon / simplified M + node: **16 px**
   - Full symbol with laptop: **32 px** (prefer **64 px** or larger)
   - App icon: **64 px**
   - Horizontal lockup: **120 px** wide, or a cap height of at least **24 px**
6. **Backgrounds.** Use the color symbol on light or dark solids. Use `mika5-mono-white.svg` on dark or photographic grounds, and `mika5-mono-dark.svg` on light grounds. If contrast is weak, place the app icon (padded rounded square) instead.
7. **Wordmark.** Always write **MIKA5** in uppercase. Do not set “Mika5” or “mika5” in the lockup.
8. **Which mark to pick.** Laptop symbol for general branding; app icon for product/OS/home-screen contexts; simplified favicon only at very small browser-tab sizes; lockup when the name must appear beside the mark.

---

## How to apply on the landing

Do this in a **separate** pull request after these assets are on `main` (or from a branch that already contains `brand/`). **Do not change the landing or the app in the assets-only PR.**

### 1. Replace or add files under `web/`

The landing is served from `web/`. Today it has no `favicon.ico` or `favicon.svg`. Current raster assets and their replacements:

| Current file on the site | Replace with | Notes |
|--------------------------|--------------|--------|
| `web/icon.png` (~1 MB, used as JSON-LD `logo`) | `brand/logo-v2/mika5-app-icon-1024.png` | Keep the public URL `https://mika5.xyz/icon.png`. This is the oversized logo called out in the SEO audit. |
| `web/icon-180.png` | `brand/logo-v2/mika5-app-icon-180.png` | Apple Touch Icon. |
| `web/icon-64.png` | `brand/logo-v2/mika5-app-icon-64.png` | Current favicon *and* the 28 px / 20 px header and footer `<img>` in every landing page. Replacing the file updates those UI icons automatically. |
| `web/og-image.png` | `brand/logo-v2/og-image-v2.png` | Keep the public URL `https://mika5.xyz/og-image.png` (1200×630). |

Add these new files (not present on the site today):

| New file | Source |
|----------|--------|
| `web/favicon.ico` | `brand/logo-v2/favicon.ico` |
| `web/favicon.svg` | `brand/logo-v2/mika5-favicon.svg` |
| `web/favicon-16.png` | `brand/logo-v2/favicon-16.png` |
| `web/favicon-32.png` | `brand/logo-v2/favicon-32.png` |

`web/logo.png` is not referenced by the current landing HTML. Leave it alone unless a later pass needs a lockup there.

### 2. Update document heads

The same head tags appear in all six pages. English pages use root-relative names; Spanish pages under `web/es/` prefix assets with `../`.

Pages:

- `web/landing.html`
- `web/models.html`
- `web/whitepaper.html`
- `web/es/index.html`
- `web/es/models.html`
- `web/es/whitepaper.html`

Today each English page has:

```html
<link rel="icon" type="image/png" sizes="64x64" href="icon-64.png">
<link rel="apple-touch-icon" href="icon-180.png">
<meta property="og:image" content="https://mika5.xyz/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:image" content="https://mika5.xyz/og-image.png">
```

Replace the favicon links with (adjust `../` on `web/es/*`):

```html
<link rel="icon" href="favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="favicon-16.png">
<link rel="apple-touch-icon" href="icon-180.png">
```

Leave the `og:image` / `twitter:image` URLs unchanged after replacing `web/og-image.png`. Keep width 1200 and height 630.

### 3. JSON-LD logo

`web/landing.html` and `web/es/index.html` currently include:

```json
"logo": "https://mika5.xyz/icon.png"
```

Keep that URL. Replacing `web/icon.png` with `mika5-app-icon-1024.png` fixes the ~1 MB logo without a schema change. The other four HTML pages do not define a JSON-LD `logo`.

### 4. Desktop app icons (not part of the landing pass)

Do not touch these when updating the landing:

- `build/icon.ico`
- `src/renderer/assets/icon.png`
- `src/renderer/assets/logo.png`
- `src/renderer/assets/favicon Mika5.png`
- `src/renderer/assets/logo mika5.png`
- `scripts/ci/check-icon.sh`

Those belong to a later desktop-branding change.

---

## Source of truth

Until a later revision is approved, **`brand/logo-v2/` is the source of truth** for the MIKA5 Community mark. Do not regenerate the mark from the old faceted circuit icon in `web/icon.png`.
