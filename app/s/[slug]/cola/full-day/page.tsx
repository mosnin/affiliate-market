/**
 * /cola/full-day — alias for /cola/today.
 *
 * The user audit flagged that "full day" is the natural verb the seller
 * (and Cola) reach for, while the actual page lives at /cola/today.
 * One permanent server redirect keeps both addresses pointing at one
 * surface — no duplicate code, no drift.
 */

import { redirect } from 'next/navigation';

export default async function ColaFullDayAlias({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/s/${slug}/cola/today`);
}
