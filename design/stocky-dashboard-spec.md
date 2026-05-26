# Stocky Dashboard — Visual Spec

This is the source-of-truth visual brief reconstructed from the reference screenshot.
Build the React/Next.js UI to match this 1:1.

## Overall

- Single-page dashboard, dark theme, full-bleed (no left sidebar).
- Page background: very dark navy/black (~`#0A0D12`).
- Cards/panels: slightly lighter (~`#11151C`) with thin 1px subtle border (`#1E2530` / `rgba(255,255,255,0.04)`).
- Border radius on cards/buttons: ~12–14px.
- Primary accent (green): ~`#26E5A1` (used for positive deltas, line chart, active pill, brand mark).
- Secondary accent (orange/yellow): ~`#F4B740` (second chart line, warm highlights).
- Negative red: ~`#FF5A5F`.
- Text primary: `#FFFFFF`.
- Text muted: ~`#6B7383`.
- Font: a clean geometric sans (Inter, SF Pro Display, or DM Sans). Tabular numerals for numbers.

## Top Bar

- Far left: Stocky brand. Green rounded-square logo (~28px) + wordmark "Stocky" in white.
- Centered nav links (medium weight, white): `Us`, `Europe`, `Asia`, `Currencies`, `Crypto`, `Futures`. Decent spacing (~28–32px between).
- Right cluster (in this order):
  - Settings gear icon (outlined, muted).
  - Bell notification icon with a green dot.
  - Circular avatar (~36px) of "Mijan Rahaman".
  - Two-line label: bold white "Mijan Rahaman" / muted small "Project Holder".
  - A small up/down chevron stack (collapse/expand) on the far right.

## Row 1 — Index Cards (5 cards, equal width, gap ~16px)

Each card has:
- Title (uppercase, muted, letter-spaced): e.g. `DAX PERFORMAE`.
- Big value (white, ~32–36px, semibold): e.g. `6,243.28`.
- Below value: small `+7.43 0.56%` (green; the 4th card is RED — `S$P/TSX Composits`).
- Bottom row: small label `INX` on left, an arrow + delta + percent aligned right (`↗ +7.43 0.56%`), color-matched (4th = red).

The five cards (in order):
1. `DAX PERFORMAE` — `6,243.28` — green
2. `S$P 500` — `24,586.54` — green
3. `FTSE 100 INDEX` — `82.965.68` — green
4. `S$P/TSX Composits` — `32,053.74` — RED
5. `NIKKEI 200` — `46,053.78` — green

## Row 2 — Commodities Strip (5 items in one wide rounded panel)

Single rounded card, items separated by faint vertical dividers. Each item has:
- Square icon (left): green-tinted background with up arrow (the third item, `Copper`, is red-tinted).
- Name (white) on top, big value below.
- Small `+10.25  0.85%` change to the right of value (green; Copper is red).

Items in order: `Platinum 55,789.75`, `Silver 30,123.50`, `Copper 12,345.67` (red), `Palladium 78,910.11`, `Rhodium 99,999.99`.

## Main Layout Below

Two-column split:
- Left ~68% width: chart + watchlist table.
- Right ~32%: "Discover more" panel.
- Gap between: ~24px.

### Left column — Chart Card

- Top: breadcrumb `HOME > .DJI-INDEX` (muted with green chevron).
- Big number: `44,524.40` (very large, ~44–48px).
- Subtitle line: muted `Jun9.40:05 PM UTC.4 - INWEXJX DISCILAIMER`.
- Time-range pill row, right-aligned: `1D` (active — green text, subtle green-tint pill), `5D`, `1M`, `YTD`, `6M`, `1Y`, `5Y`, `MAX` (others are plain muted text).
- Chart:
  - Smooth two-line area chart. Green line (primary), orange/yellow second line.
  - Y-axis ticks at `10.000`, `20.000`, `30.000`, `40.000`, `50.000` (left side, muted).
  - X-axis time ticks: `10:00PM`, `12:00PM`, `8:00PM`, `10:00AM`, `10:00AM`.
  - Subtle horizontal grid lines.
  - A vertical "selection" band (diagonal-hatched stripe, ~24px wide) crossing the chart with a small dotted vertical guideline.
  - Floating tooltip pill above that guideline: `Jun 9.10:48PM UTC-4` (rounded, dark, white text).
  - Light area fill under green line fading to transparent.

### Left column — Watchlist Table (under chart)

Borderless rows, each with:
- Checkbox (rounded square, unchecked by default).
- Name (white).
- Value (white).
- Change (`+10.32` etc, white/muted).
- Numeric (e.g. `100.2`).
- Pill button on the right: rounded green-outlined pill `↑ 100.2`.
- Trailing `×` (close) icon, muted.

Rows:
1. `S&P 500` — `4.372.75` — `+10.32` — `100.2` — `↑ 100.2`
2. `FTSE 100` — `7.500.12` — `+20.47` — `75.8` — `↑ 75.8`
3. `Dow Jones Industrial` — `34.000.25` — `+75.05` — `150.6` — `↑ 150.6`
4. `Russell 2000` — `2.080.30` — `+5.12` — `80.1` — `↑ 80.1`

### Right column — "Discover more" Panel

- Header `Discover more` (white, semibold).
- Subhead muted `you may be interested in`.
- 2-column grid (4 rows = 8 cards). Each card is its own rounded dark tile with:
  - Name (top-left, white): e.g. `Bse sensex`.
  - Ticker chip (top-right, small dark pill with muted text): e.g. `DSSL`.
  - Price below: e.g. `$6.248.80` (large, white).
  - Tiny floating `0.48%` chip (rounded, dark, faint green).
  - Tiny mini line chart (sparkline) at the bottom — subtle gray-green wavy line with a tiny dot at the end.

The 8 entries (row-major):
1. `Bse sensex`  `DSSL`  `$6.248.80`
2. `Installed building`  `IBP`  `$1,078.20`
3. `Wondershare`  `ALIF`  `$68.80`
4. `Hims & heres`  `INDE`  `84,19.20`
5. `Robinhood market`  `SMW`  `$96.008`
6. `Similarweb Ltd`  `HUB`  `$20,490`
7. `Bse sensex`  `HIM`  `6.248.80`
8. `Hobspot Inc`  `HOD`  `4,2290`

## Important fidelity notes

- Reproduce the strings literally even where they read weird (`PERFORMAE`, `S$P`, `Composits`, `DISCILAIMER`, `Hims & heres`, `Hobspot`, `Dicover`)— these are how the screenshot reads. Treat them as fixed copy.
- Numbers should NOT be re-formatted from how shown (`82.965.68` stays as-is, etc.) — match exactly.
- Maintain the exact card order and the single RED card on row 1 (`S$P/TSX Composits`) and the single RED commodity (`Copper`).
- Active time-range pill is `1D`.
- All corner radii are generously rounded (cards ~12px, pills/buttons ~999px or ~10px depending on element).
