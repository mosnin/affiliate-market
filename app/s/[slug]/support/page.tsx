import { notFound } from 'next/navigation';
import { getSpaceFromSlug } from '@/lib/space';
import { SupportView } from './support-view';

export const metadata = { title: 'Support — Cola' };

export default async function SupportPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  return <SupportView slug={slug} />;
}
