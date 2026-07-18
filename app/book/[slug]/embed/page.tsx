import { notFound } from 'next/navigation';
import { getSpaceFromSlug } from '@/lib/space';
import { convex, api } from '@/lib/convex-server';
import { BookingForm } from '../booking-form';
import { FormUnavailable } from '@/components/form-unavailable';

/**
 * Embeddable booking page — designed to be loaded in an iframe.
 * Minimal chrome, no header/footer, transparent background.
 */
export default async function EmbedBookingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  const settingsData = await convex().query(api.workspace.settings.getBySpace, {
    spaceId: space.id,
  });

  const businessName = (settingsData as any)?.businessName || space.name;
  const duration = (settingsData as any)?.demoDuration || 30;
  const timezone = (settingsData as any)?.timezone || 'America/New_York';

  // Gate on subscription status — only pause forms for explicitly failed billing
  const subStatus = space.stripeSubscriptionStatus;
  const formPaused = subStatus === 'past_due' || subStatus === 'canceled' || subStatus === 'unpaid';
  if (formPaused) {
    return (
      <html>
        <body style={{ margin: 0, padding: 16, fontFamily: 'system-ui, sans-serif', background: 'transparent' }}>
          <FormUnavailable agentName={businessName} />
        </body>
      </html>
    );
  }

  return (
    <html>
      <body style={{ margin: 0, padding: 16, fontFamily: 'system-ui, sans-serif', background: 'transparent' }}>
        <BookingForm slug={slug} duration={duration} businessName={businessName} timezone={timezone} />
      </body>
    </html>
  );
}
