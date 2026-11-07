# Style Guide

**The single source of truth for colors, typography, and tokens.** Every diagram draws from this — not from hex values inlined in other reference files. If you want to change the visual skin of Schematic, change this file.

**This install is skinned to VaultOS.** Every diagram it draws is read inside VaultOS's
Knowledge Base or task drawer, so the app's own colour tokens are
the default below, not the shipped editorial palette. Paper stays white-smoke: VaultOS mats a figure
on a dark ground and a light card on that mat is the legible arrangement. What VaultOS supplies is
the rest — gold accent, cool ink, Space Grotesk title.

The original shipped default (atomic-tangerine accent, blue-slate muted) is kept in the table as
`Shipped` for reference. Don't reach for it: a diagram in this vault should look like it belongs to
the app that displays it.

To reskin from another source — a website URL, another skill, a design-system folder — see
[`onboarding.md`](onboarding.md).

---

## Tokens

### Semantic roles

Every token is referred to by **semantic role**, not by its hex value. Type references (`type-*.md`) and SKILL.md say `accent`, not `#f7591f`.

| Role | Purpose | **Default — VaultOS** | Shipped (don't use) |
|---|---|---|---|
| `paper` | Page background, default node fill | `#f5f5f5` (white-smoke) | `#f5f5f5` |
| `paper-2` | Secondary fill, service/backend nodes | `#ffffff` | `#ececec` |
| `ink` | Primary text, primary stroke | `#1d222b` | `#2d3142` (jet-black) |
| `muted` | Secondary text, default arrow stroke | `#5b6575` | `#4f5d75` (blue-slate) |
| `soft` | Sublabels, boundary labels | `#6e7788` | `#7a8399` |
| `rule` | Hairline borders | `rgba(29,34,43,0.12)` | `rgba(45,49,66,0.12)` |
| `rule-solid` | Stronger borders, baselines | `#c7ccd4` | `#bfc0c0` (silver) |
| `accent` | Focal / 1–2 max per diagram | `#8a5a12` (VaultOS gold) | `#eb6c36` (atomic-tangerine) |
| `accent-tint` | Fill for accent-bordered boxes | `rgba(138,90,18,0.08)` | `rgba(235,108,54,0.08)` |
| `link` | HTTP/API calls, external arrows | `#35608f` | `#2e5aa8` |

**Title and eyebrow are Space Grotesk 600** — VaultOS's brand face, loaded from Google Fonts
alongside Geist. Node names stay Geist sans, technical sublabels Geist Mono. Instrument Serif keeps
one job only: the italic editorial callout (see [primitive-annotation.md](primitive-annotation.md)).
Every inline `font-family` carries a full fallback chain
(`'Geist', ui-sans-serif, system-ui, sans-serif`) because VaultOS lifts the `<svg>` out of the file
and leaves the page's `<link>` behind — inside the app the chain resolves to VaultOS's `--ui-font`.

> **The gold changes form with the paper.** VaultOS's dark-theme `--accent #e8c67e` scores
> **1.5:1 on white-smoke** — on a light figure it is not a focal colour, it is a smudge. `#8a5a12`
> above is the same gold in the form VaultOS's own light theme uses, at 5.4:1. Take the accent from
> the variant that matches the **paper**, never the one that matches the app's current theme. The
> same trap waits for any consumer that paints on its own light ground: charts, exports, print.

> **Contrast, measured on `paper`:** `ink` 14.6:1, `muted` 5.3:1, `accent` 5.4:1, `link` 6.0:1,
> `soft` 4.1:1.

> **`accent` is not `brand`.** VaultOS keeps half a step of luminance between `--accent` ("act on
> me") and `--brand` ("this is VaultOS", `#6b4b12` light / `#d7b46a` dark). In a diagram only
> `accent` appears; `brand` belongs to the app's chrome, not the figure.

> **Note:** The pre-baked example HTML files in `assets/` predate this skin and still show the
> shipped palette. Treat them as layout references, not colour references.

> **Note:** The pre-baked example HTML files in `assets/` were built under an earlier skin. Regenerating them against the current `style-guide.md` is a v5.1 task. New diagrams the skill produces will use the tokens above.

### Inversion rule (light → dark)

Any `rgba(28,25,23, X)` in light becomes `rgba(250,247,242, X)` in dark. Same opacities, RGB flipped. The accent gets a slight hue-shift brighter to read on dark paper.

### Series palette (multi-series chart types only)

A small set of desaturated, editorial-tone colors for chart types that genuinely need to distinguish multiple overlapping entities (currently: **radar**). The "1-focal" rule still holds — `accent` is reserved for the focal series; the palette below covers the rest.

| Token | Light | Dark | Notes |
|---|---|---|---|
| `series-1` | `#7c8f6f` (sage) | `#9caf8f` | Non-focal series |
| `series-2` | `#5e7a9b` (dusty-blue) | `#82a0c0` | Non-focal series |
| `series-3` | `#b8915a` (mustard) | `#d3ad7a` | Non-focal series |
| `series-4` | `#9c6b50` (rust-brown) | `#b88670` | Non-focal series |
| `series-5` | `#6e6479` (slate) | `#8d8298` | Non-focal series |

Fills sit at `0.18` opacity light, `0.22` dark; strokes use the full color. **Don't backfill these tokens to non-chart types** — architecture, swimlane, etc. continue to use muted-ink variants. The series palette is opt-in for diagrams where overlapping shapes demand distinguishable color, not a license to add color elsewhere.

### Terminal skin (opt-in alternate)

A self-contained palette for the terminal-window primitive (see [primitive-terminal.md](primitive-terminal.md)) — a CLI-chrome register for dev-tool posts and technical social cards. It does not replace the default skin above and isn't affected by onboarding; it's a second, fixed skin you opt into per-diagram.

| Token | Hex | Purpose |
|---|---|---|
| `terminal-page` | `#0a0a0a` | Page background behind the window |
| `terminal-paper` | `#141414` | Window body, node fill |
| `terminal-bar` | `#1b1b1b` | Titlebar strip |
| `terminal-border` | `#2b2b2b` | Window border, hairlines |
| `terminal-ink` | `#f5f5f5` | Primary text, primary stroke (same white-smoke as default `ink`) |
| `terminal-muted` | `#9a9a9a` | Secondary text, sublabels, ring stroke |
| `terminal-soft` | `#5c5c5c` | Tertiary — inactive dots, spokes |
| `terminal-accent` | `#ff5a36` | The one accent — focal station, prompt sign, active dot |
| `terminal-accent-tint` | `rgba(255,90,54,0.12)` | Fill for accent-bordered boxes |

**1-accent rule still holds.** Everything that isn't `terminal-ink` or `terminal-muted`/`terminal-soft` should be `terminal-accent` — never introduce a second hue.

---

### VaultOS skin — dark and sepia variants

The default tokens above are the light variant of the VaultOS skin, and light is what a diagram in
this vault should be: VaultOS mats every figure on `--diagram-mat`, so a white-smoke card reads
cleanly there and under both of the app's themes. These two variants exist for the narrow case where
a figure has to *match* a surface rather than sit on one — a dark hero image, a slide, a screenshot
of the app with a figure inside it.

| Role | Light (default, above) | Dark | Sepia | VaultOS token |
|---|---|---|---|---|
| `mat` | `#0b0d11` | `#0b0d11` | `#e0d2b0` | `--diagram-mat` — the app's ground, never painted by the SVG |
| `paper` | `#f5f5f5` | `#161b23` | `#ece0c6` | `--panel` (light is white-smoke, not a VaultOS token) |
| `paper-2` | `#ffffff` | `#212734` | `#e4d7b7` | `--panel-2` |
| `ink` | `#1d222b` | `#e6e9ef` | `#463a29` | `--text` |
| `muted` | `#5b6575` | `#8b95a7` | `#6b5c44` | `--muted` |
| `soft` | `#6e7788` | `#7b8494` | `#857450` | `--muted-2` |
| `rule` | `rgba(29,34,43,0.12)` | `rgba(230,233,239,0.14)` | `rgba(70,58,41,0.14)` | ink at opacity |
| `rule-solid` | `#c7ccd4` | `#2c3340` | `#d8c8a4` | `--line` |
| `accent` | `#8a5a12` | `#e8c67e` | `#8a5a12` | `--accent` |
| `accent-tint` | `rgba(138,90,18,0.08)` | `rgba(232,198,126,0.12)` | `rgba(138,90,18,0.10)` | |
| `link` | `#35608f` | `#3b82f6` | `#35608f` | `--in-progress` |
| `brand` | `#6b4b12` | `#d7b46a` | `#6b4b12` | `--brand` — app chrome only, not the figure |

**Values adjusted from the raw tokens, for contrast at the 8–9px a diagram uses:**

| Token | Raw | Used | Why |
|---|---|---|---|
| `soft` dark | `#6a7382` | `#7b8494` | 3.6:1 → 4.6:1 on `paper` |
| `muted` sepia | `#7d6c51` | `#6b5c44` | 3.9:1 → 5.0:1 — below AA as shipped, in the app too |
| `link` sepia/light | `#3f6fb0` | `#35608f` | 4.3:1 → 5.0:1 |

**In the dark variant, fill opacities are bumped ~2 points over the inversion rule.** The `ink @
0.02` external/optional fill disappears entirely against a panel that is already dark; dark uses
0.04 / 0.05 / 0.07 where light uses 0.02 / 0.03 / 0.05.

**The page chrome stays on paper in every variant.** The `<h1>` and eyebrow sit above the SVG on
`--color-paper`, not on the mat — VaultOS drops that header anyway (the article's own `<h1>` is the
headline), so it only shows when the file is opened on its own, and a file that opens light is
easier to read and to print.

**Status colours** (`--done #22c55e`, `--blocked #ef4444`, `--review #f59e0b`, `--in-progress
#3b82f6`, `--needs-decision #c2649b`, `--backlog #6b7280`, with light forms in
`:root[data-theme="light"]`) are available when a diagram genuinely encodes VaultOS task state.
They are **not** a palette for ordinary nodes — the 1–2 accent rule still holds. Pick by paper, as
with the accent.

**A skin is fixed at author time.** A dark-skinned figure stays dark when the app is toggled to
sepia, because `server.js` requires the SVG to be self-contained — literal hex, no `var(--…)`,
since it lifts the markup out of the file and into its own DOM. One more reason light is the
default: white-smoke is correct under both themes and needs no decision.

---

## Typography

| Role | Family | Size | Weight | Usage |
|---|---|---|---|---|
| `title` | Space Grotesk | 1.4–1.8rem | 600 | Page H1 — VaultOS's brand face |
| `node-name` | Geist (sans) | 12px | 600 | Human-readable labels |
| `sublabel` | Geist Mono | 9px | 400 | Port, protocol, URL, field type |
| `eyebrow` | Geist Mono | 7–8px | 500, tracked 0.18em, uppercase | Type tags, axis labels |
| `arrow-label` | Geist Mono | 8px | 400, tracked 0.06em | Arrow annotations |
| `callout` | Instrument Serif *italic* | 14px | 400 | Editorial asides only |

### Font stack

```html
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600&family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

**Load-bearing rule:** Mono is for *technical* content (ports, commands, URLs, field types). Names go in Geist sans. Page title is **Space Grotesk 600** — Instrument Serif is still loaded, but only for the italic callout. Italic Instrument Serif is reserved for annotation callouts (see [primitive-annotation.md](primitive-annotation.md)). **Never JetBrains Mono** as a blanket "dev" font.

---

## Stroke, radius, spacing

| Token | Value | Use |
|---|---|---|
| `stroke-thin` | `0.8` | Tag-box outlines, leaf nodes |
| `stroke-default` | `1` | Most strokes |
| `stroke-strong` | `1.2` | Emphasis strokes |
| `radius-sm` | `4` | Small tags |
| `radius-md` | `6` | Node boxes |
| `radius-lg` | `8` | Containers, rings |
| `grid` | `4` | Every coord, size, and gap is divisible by 4 (hard rule) |

---

## Node type → treatment

Semantic role combinations — reference these by name in type specs.

| Type | Fill | Stroke |
|---|---|---|
| `focal` (1–2 max) | `accent-tint` | `accent` |
| `backend` | `#ffffff` (white) | `ink` |
| `store` | `ink @ 0.05` | `muted` |
| `external` | `ink @ 0.03` | `ink @ 0.30` |
| `input` | `muted @ 0.10` | `soft` |
| `optional` | `ink @ 0.02` | `ink @ 0.20` dashed `4,3` |
| `security` | `accent @ 0.05` | `accent @ 0.50` dashed `4,4` |

---

## Customizing the skin

Three options:

1. **Run onboarding** — see [`onboarding.md`](onboarding.md). Drop a URL; the skill extracts the palette + fonts and rewrites this file.
2. **Edit by hand** — change the hex values in the tables above. Run the pre-output taste gate afterward to verify the accent still reads as "focal" against the new paper color.
3. **Brand handoff** — paste your existing design-token JSON into a new section here and map its tokens to the semantic roles above.

### Constraints (don't break these)

- **Contrast**: `ink` must hit WCAG AA on `paper`. `muted` must hit AA on `paper` for 11px+ text.
- **One accent**: pick one color for `accent`. Two accents erases the focal signal.
- **No rainbow palette**: if your brand ships 8 colors, pick 3 (paper, ink, accent). The rest become `muted` variants.
- **Serif + sans + mono**: three families, not more. If brand typography is all sans, keep Instrument Serif for `title` and `callout` anyway — the contrast is load-bearing.
- **Paper is warm-neutral, not pure white**: pure white turns the design sterile. Pick a cream, bone, or light grey with a hint of warmth.
- **Dot pattern is optional, not default**: the 22×22 dot pattern is an opt-in "dotted paper" variant (good for long-form editorial hero diagrams). The default background is a clean `paper` fill, no pattern. When the pattern is enabled, it should sit at ~10% opacity of `ink` on `paper` — visible but quiet.
- **Container is clean by default**: the diagram sits directly on the page paper, no secondary container background or border. A framed variant (`paper-2` bg + `rule` border + 8px radius + padding) is available as an opt-in for card-heavy layouts, but don't reach for it by default — the extra chrome fights the figure.
