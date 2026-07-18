import { redirect } from 'next/navigation';

/**
 * /clients → /buyer redirect. The buyer portal has moved to /buyer.
 * Any bookmarked or emailed /clients links will land here and bounce correctly.
 */
export default function Page() {
  redirect('/buyer');
}
