/**
 * Theme-aware Clerk appearance config.
 * Most visual overrides are in globals.css (.cl-* selectors) — that file is
 * the source of truth for the Sequence fintech auth chrome. This config sets
 * Clerk's color variables so internal state colors (focus rings, checked states)
 * align with the new teal/mint system.
 */
export function clerkAuthAppearance(isDark: boolean) {
  // Deep teal primary (#0E4E44) in light; a lightened teal in dark.
  const primary = isDark ? '#34C77F' : '#0E4E44';
  // Foreground for text on primary (mint-background buttons use deep teal text).
  const foreground = isDark ? '#07332C' : '#ffffff';

  return {
    variables: {
      colorPrimary: primary,
      colorNeutral: isDark ? '#f1f3f5' : '#14181D',
      borderRadius: '0.75rem', // rounded-xl — matches inputs + buttons
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
      fontSize: '0.875rem',
    },
    layout: {
      socialButtonsPlacement: 'top' as const,
      socialButtonsVariant: 'blockButton' as const,
    },
    elements: {
      rootBox: 'w-full overflow-visible',
      card: 'shadow-none border-0 p-0 w-full gap-4 bg-transparent overflow-visible',
      cardBox: 'shadow-none border-0 bg-transparent overflow-visible',
      header: 'hidden',
      headerTitle: 'hidden',
      headerSubtitle: 'hidden',
      footer: 'hidden',
      footerAction: 'hidden',
    },
  } as const;
}
