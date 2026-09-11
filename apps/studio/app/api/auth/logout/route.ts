import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/server/auth';

export async function POST() {
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ loggedOut: true });
}
