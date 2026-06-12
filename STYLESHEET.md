# STYLESHEET.md — the Cola design system

**The single source of truth for typography, color, shape, motion, components,
and copy voice.** If a screen disagrees with this document, the screen is wrong.

The aesthetic is modern fintech ("Sequence"): a calm, cool off-white canvas;
white cards with soft 16px corners; one deep-teal hero surface per page that
carries the headline number; mint money-green for primary actions and growth;
big semibold tabular numbers; quiet gray chrome. It should feel like a
well-run bank account: confident, legible, unhurried.

Everything below is implemented as tokens (`app/globals.css`) and composable
constants (`lib/typography.ts`, `lib/colors.ts`). **Compose from the
constants; never hardcode hex values or invent new radii.**

---

## 1. Color

Semantic tokens (light theme values; dark theme mirrors them automatically):

| Token | Value | Role |
|---|---|---|
| `background` | `#F5F6F8` | The canvas. Cool off-white, never pure white. |
| `card` | `#FFFFFF` | Every raised surface: cards, tables, popovers, sidebar items. |
| `foreground` | `#14181D` | Primary text. Near-black, slightly warm. |
| `muted-foreground` | `#6C737D` | Secondary text, labels, metadata. |
| `border` | `#E6E8EC` | Hairlines everywhere. The system's only "shadow". |
| `primary` | `#0E4E44` | **Deep teal.** Hero surfaces, active nav, focused chrome, the agent. |
| `brand` | `#34C77F` | **Mint.** The money color: primary CTAs, earnings, growth. Text on it is `brand-foreground` `#07332C`. |
| `brand-subtle` | `#E5F7EE` | Mint tint: icon squares, success chips, selected states. |
| `hero` / `hero-foreground` | `#0E4E44` / `#FFF` | The dark headline panel (see §6). |
| `positive` / `positive-subtle` | `#119A57` / `#E5F7EE` | Up-deltas, success chips. |
| `negative` / `negative-subtle` | `#DE4A56` / `#FDECEE` | Down-deltas, failures, destructive. |
| `chart-1` / `chart-2` | `#0E4E44` / `#56D69E` | Dual-bar charts: primary series deep teal, secondary mint. |

Rules:
- **Mint is earned.** It marks money, growth, and the page's one primary verb.
  If everything is mint, nothing is. Secondary actions are white-bordered.
- **Teal is authority.** Hero panels, active navigation, Cola-the-agent.
  Never use it for body text.
- Reds only for negative deltas and destructive actions. No decorative red.
- The old brand orange is dead. `lib/colors.ts` contexts now resolve to the
  mint/teal family; any literal `orange-*` class is a bug.

## 2. Typography

All-sans. No serif anywhere in the product (the legacy `--font-title` variable
now resolves to the display sans, so old call sites are already correct).

The ladder (1.2 modular ratio, whole px):

```
30 semibold  H1 / STAT_NUMBER     page title, the focal number
25 semibold  STAT_NUMBER_COMPACT  stats in rows of 4+
21 semibold  H2                   section heading
17 semibold  H3                   card heading
14 regular   BODY / BODY_MUTED    everything
12 regular   CAPTION              chrome, helper text
11 medium    SECTION_LABEL (uppercase, tracked) / META (tabular)
```

- Numbers are **always** `tabular-nums`, semibold when focal.
- Money: creators see net, sellers see gross (see CLAUDE.md); format cents →
  dollars with `formatCurrency(cents / 100)`.
- Import the constants from `lib/typography.ts` — never retype the classes.

## 3. Shape, depth, motion

- Radii: cards `rounded-2xl` (16px), hero panel `rounded-[20px]`, controls and
  inputs `rounded-xl` (12px), chips `rounded-lg`, avatar/logo squares
  `rounded-xl`. Nothing fully square; nothing fully circular except avatars.
- Depth comes from **borders, not shadows**: `border border-border` on white.
  A whisper of `shadow-xs` is allowed only on floating elements (popovers,
  command palette, the active sidebar item).
- Motion: 150ms color/transform transitions; `active:scale-[0.98]` on
  buttons; entrance staggers ≤ 220ms. No bounce, no confetti, no spinners
  longer than a second.

## 4. Buttons (locked vocabulary, from `lib/typography.ts`)

| Constant | Looks like | Use for |
|---|---|---|
| `PRIMARY_PILL` | Mint, deep-teal text, `rounded-xl` | The page's main verb: Add, Save, Buy, Get my link |
| `GHOST_PILL` | White, hairline border | Secondary: Export, Cancel, Manage |
| `HERO_GHOST_PILL` | Translucent white on teal | Actions sitting on the hero panel |
| `COLA_PILL` | Deep teal → mint hover | Only buttons that invoke Cola directly |
| `QUIET_LINK` | Gray → dark text | Inline tertiary actions |

## 5. The page anatomy

Every dashboard-class page reads top to bottom as:

1. **Top bar** — search field (white, `rounded-xl`, ⌘K kbd hint) left;
   date-range / filters / Export (`GHOST_PILL`) right.
2. **Hero panel** (optional, one max) — the headline number.
3. **Stat card row** — 2–4 white cards.
4. **Content** — tables, lists, charts in white cards.

`PAGE_RHYTHM` (32px) between those bands; `SECTION_RHYTHM` (20px) inside.

## 6. Signature components

**Hero panel** (`HERO_PANEL`): deep-teal `rounded-[20px]` band. Left: a
label in `text-white/70`, then the focal number in 30px semibold white with
its delta chip. Right: 1–3 actions — one `PRIMARY_PILL` (mint reads
beautifully on teal) + `HERO_GHOST_PILL`s. One hero per page, always first.

**Stat card** (`STAT_CARD`): white card; `ICON_SQUARE` (36px, `rounded-xl`,
`brand-subtle` tint, teal icon at 16px); muted 14px label;
`STAT_NUMBER_COMPACT` value; delta line: `DELTA_UP`/`DELTA_DOWN`
("15.8% ↗" — `TrendingUp`/`ArrowUpRight`/`ArrowDownRight` lucide at 12px)
plus `CAPTION` "vs. last period".

**Status chips**: `CHIP_POSITIVE` (Success / approved / paid),
`CHIP_NEUTRAL` (Pending / draft), `CHIP_NEGATIVE` (Failed / rejected).
Soft tinted backgrounds, never solid.

**Tables**: inside a `CARD`; header row `SECTION_LABEL` on `bg-muted/40`;
rows divided by `divide-border/60`, `py-3`, hover `bg-muted/30`; amounts
right-aligned tabular; statuses as chips; entity cells lead with a 36px
rounded avatar/logo square.

**Sidebar**: `bg-sidebar` near-white, 1px right border. Small uppercase
group labels (`SECTION_LABEL`) — General / Support-style grouping. Items:
14px, lucide 16px icons, `rounded-xl`; active = white card pill with border
+ `shadow-xs` and a teal icon; inactive = muted text, hover
`bg-sidebar-accent`. Bottom: user card (avatar, name, email).

**Charts** (recharts): dual-series bars — primary `var(--chart-1)` (deep
teal), secondary `var(--chart-2)` (mint); `radius={[4,4,0,0]}`; hairline
grid only; no legends when two series are obvious from context.

**Empty states**: dashed `border-border` on `bg-muted/20`, `rounded-2xl`,
one muted sentence + one `PRIMARY_PILL` if there's an obvious next verb.

## 7. Copy voice

Quiet, lowercase-calm, factual. Verbs first ("Add product", "Run payout").
Periods on sentences, none on labels. No exclamation marks in chrome.
Numbers do the talking — the words around them get out of the way.

## 8. Marketing vs product

The logged-out marketing site may push the palette harder (full-bleed teal
sections, mint gradient text via `.text-gradient-brand`, display flourishes).
None of that enters product chrome. Auth pages use the product system with
the mint CTA.

## 9. Don't

- Don't hardcode hex — tokens only.
- Don't use serif or the `.font-brand` display face inside the product.
- Don't stack two hero panels, or put a hero mid-page.
- Don't use solid-color status badges, drop shadows on cards, or orange
  anything.
- Don't invent a 13px text size or a new radius.
