'use client';

import { useEffect, useState } from 'react';
import { appendRefToUrl } from '@/lib/affiliates/ref-url';

/**
 * Outbound link that carries the visitor's referral attribution across
 * domains: when a cola_ref cookie is present, ?via=CODE is appended so the
 * seller's site (and their Stripe checkout metadata) can keep crediting
 * the creator. Client-side so statically-cached pages stay cacheable.
 */
export function OutboundLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [resolved, setResolved] = useState(href);

  useEffect(() => {
    const code = document.cookie
      .split('; ')
      .find((c) => c.startsWith('cola_ref='))
      ?.split('=')[1];
    if (code) setResolved(appendRefToUrl(href, decodeURIComponent(code)));
  }, [href]);

  return (
    <a href={resolved} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}
