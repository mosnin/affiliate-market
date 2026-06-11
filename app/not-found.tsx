'use client';

import Link from 'next/link';
import { rootDomain, protocol } from '@/lib/utils';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          Page not found
        </h1>
        <p className="mt-3 text-lg text-muted-foreground">
          That page doesn&apos;t exist — or you don&apos;t have access to it.
        </p>
        <div className="mt-6">
          <Link
            href={`${protocol}://${rootDomain}`}
            className="rounded-full bg-primary text-primary-foreground px-6 py-2.5 text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Go to {rootDomain}
          </Link>
        </div>
      </div>
    </div>
  );
}
