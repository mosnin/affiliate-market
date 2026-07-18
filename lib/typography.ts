/**
 * Cola typography + spacing scale — the Sequence fintech system.
 *
 * Single source of truth for every page's visual hierarchy. Agents and
 * components import from here so the eye lands on the same thing on every
 * screen. The values are Tailwind utility class strings; consumers compose
 * them via `cn(...)`.
 *
 * The look: cool off-white canvas, white 16px-radius cards, deep-teal hero
 * surfaces, mint money-green CTAs, ALL-SANS type with semibold tabular
 * numbers. No serif. No shadows beyond a whisper on raised cards.
 *
 * ── The type ladder ─────────────────────────────────────────────────────────
 * Snapped to a 1.2 modular ratio, rounded to whole px:
 *
 *   30 → 25 → 21 → 17 → 14 → 12 → 11
 *   H1   STAT  H2   H3   BODY  CAP   META
 *
 * 11 sits one step below the ratio by deliberate exception — the legibility
 * floor for chrome metadata. Do not add tiers between the steps.
 */

/* ─── Display: focal numbers + page titles ─────────────────────────────── */

/** Page-level h1 — bold sans, the screen's headline. */
export const H1 = 'text-3xl font-semibold tracking-tight text-foreground';

/**
 * Legacy display-font hook. The system is all-sans now; this resolves to
 * the display sans so existing `style={TITLE_FONT}` call sites simply
 * render the new headline face. Safe everywhere, required nowhere.
 */
export const TITLE_FONT = { fontFamily: 'var(--font-title)' } as const;

/** Focal stat number — big, bold, tabular. The € 320.845,20 moment. */
export const STAT_NUMBER = 'text-3xl font-semibold tracking-tight text-foreground tabular-nums';
/** Compact stat (when 4+ are in a row). 25px = H1 × 1/1.2. */
export const STAT_NUMBER_COMPACT =
  'text-[25px] leading-tight font-semibold tracking-tight text-foreground tabular-nums';

/* ─── Section headings ─────────────────────────────────────────────────── */

/** Section h2 — sub-page heading. 21px. */
export const H2 = 'text-[21px] leading-snug tracking-tight font-semibold text-foreground';

/** Card / panel heading. 17px. */
export const H3 = 'text-[17px] leading-snug font-semibold text-foreground';

/** Quiet small-caps section label (sidebar groups, card eyebrows). */
export const SECTION_LABEL =
  'text-[11px] font-medium uppercase tracking-wider text-muted-foreground';

/* ─── Body ─────────────────────────────────────────────────────────────── */

/** Default body — 14px, the trunk of the ladder. */
export const BODY = 'text-sm text-foreground';

/** Muted body — subtitles, helper text, secondary info. */
export const BODY_MUTED = 'text-sm text-muted-foreground';

/** Compact body for dense surfaces — aliases BODY (the ladder has no 13px). */
export const BODY_COMPACT = BODY;

/** Caption / chrome / metadata. 12px. */
export const CAPTION = 'text-xs text-muted-foreground';

/** Smallest tabular metadata (timestamps, ids). */
export const META = 'text-[11px] tabular-nums text-muted-foreground';

/* ─── Spacing rhythm ───────────────────────────────────────────────────── */

/** Between MAJOR page sections (hero → stat row → activity). */
export const PAGE_RHYTHM = 'space-y-8';

/** Between sub-sections within a section. */
export const SECTION_RHYTHM = 'space-y-5';

/** Between form fields or list rows. */
export const FIELD_RHYTHM = 'space-y-4';

/** Tight inline cluster (label + chip, icon + text). */
export const INLINE_TIGHT = 'gap-1.5';

/** Standard inline cluster (toolbar buttons, action row). */
export const INLINE = 'gap-2';

/** Between hairline-divided rows: padding only, no margin. */
export const ROW_PAD = 'py-3';
export const ROW_PAD_TIGHT = 'py-2.5';

/* ─── Layout containers ────────────────────────────────────────────────── */

/** Standard page container max width — re-exported from the geometry
 *  module so the macro frame stays in one place. */
export { PAGE_MAX } from '@/lib/geometry';

/** Reading column — single-form pages, settings, intake customize. */
export const READING_MAX = 'max-w-3xl mx-auto';

/* ─── Buttons ──────────────────────────────────────────────────────────── */

/**
 * The locked primary action — mint money-green, soft 12px corners, deep-teal
 * text. Use on Save / Add / Confirm / the page's one main verb.
 */
export const PRIMARY_PILL =
  'inline-flex items-center justify-center gap-1.5 rounded-xl px-4 h-9 text-sm font-semibold ' +
  'bg-brand text-brand-foreground hover:bg-brand/85 active:scale-[0.98] ' +
  'transition-all duration-150 focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-background';

/**
 * `COLA_PILL` — for buttons that DIRECTLY invoke Cola ("Ask Cola").
 * Deep teal, shifting toward mint on hover — the agent wears the hero color.
 * Generic Save / Send / Add buttons stay PRIMARY_PILL.
 */
export const COLA_PILL =
  'inline-flex items-center justify-center gap-1.5 rounded-xl px-4 h-9 text-sm font-semibold ' +
  'bg-primary text-primary-foreground ' +
  'hover:bg-gradient-to-r hover:from-primary hover:via-primary hover:to-brand/90 ' +
  'active:scale-[0.98] transition-all duration-150 focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-background';

/** Secondary — white bordered (the screenshot's "Export" button). */
export const GHOST_PILL =
  'inline-flex items-center justify-center gap-1.5 rounded-xl px-4 h-9 text-sm font-medium ' +
  'bg-card text-foreground border border-border hover:bg-muted/60 ' +
  'transition-colors duration-150';

/** Action button sitting ON the dark hero panel ("Send" / "Request"). */
export const HERO_GHOST_PILL =
  'inline-flex items-center justify-center gap-1.5 rounded-xl px-4 h-9 text-sm font-medium ' +
  'bg-white/10 text-hero-foreground border border-white/20 hover:bg-white/20 ' +
  'transition-colors duration-150';

/** Quiet text link — "Edit", "Cancel" inline within a row. */
export const QUIET_LINK =
  'text-sm text-muted-foreground hover:text-foreground transition-colors duration-150';

/* ─── Signature components (the Sequence look) ─────────────────────────── */

/**
 * The dark hero panel — Total Balance, page-level headline metric.
 * One per page, always at the top, never two.
 */
export const HERO_PANEL =
  'rounded-[20px] bg-hero text-hero-foreground px-6 py-6 sm:px-8 sm:py-7 relative overflow-hidden';

/** White stat/content card. The default surface for everything. */
export const CARD =
  'rounded-2xl border border-border bg-card';

/** Stat card padding rhythm (icon square + label + number + delta). */
export const STAT_CARD = CARD + ' px-5 py-5 space-y-3';

/** Tinted icon square that leads a stat card or list row. */
export const ICON_SQUARE =
  'w-9 h-9 rounded-xl bg-brand-subtle text-primary flex items-center justify-center shrink-0';

/** Icon square on the dark hero panel. */
export const ICON_SQUARE_HERO =
  'w-9 h-9 rounded-xl bg-white/10 text-hero-foreground flex items-center justify-center shrink-0';

/** Positive delta chip — "15.8% ↗". Pair with an arrow icon. */
export const DELTA_UP =
  'inline-flex items-center gap-0.5 text-xs font-semibold text-positive';

/** Negative delta chip — "12.5% ↘". */
export const DELTA_DOWN =
  'inline-flex items-center gap-0.5 text-xs font-semibold text-negative';

/** Soft status chip — success. ("Success" on the activity table.) */
export const CHIP_POSITIVE =
  'inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-medium bg-positive-subtle text-positive';

/** Soft status chip — pending / neutral. */
export const CHIP_NEUTRAL =
  'inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-medium bg-muted text-muted-foreground';

/** Soft status chip — failed / negative. */
export const CHIP_NEGATIVE =
  'inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-medium bg-negative-subtle text-negative';
