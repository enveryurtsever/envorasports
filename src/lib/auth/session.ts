import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { getUserEntitlements } from '@/lib/entitlements/service';
import type { AccessDecision } from '@/lib/entitlements/features';

export const SESSION_COOKIE = 'envora_session';

/** Sessions are stored hashed, so a database leak does not hand out logins. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface Viewer {
  userId: string | null;
  email: string | null;
  role: 'USER' | 'ADMIN';
  /** Admins bypass entitlement checks entirely — they operate the product. */
  isAdmin: boolean;
  entitlements: AccessDecision;
}

export async function getCurrentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: { expiresAt: true, user: { select: { id: true, email: true, role: true } } },
  });

  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  return session.user;
}

/**
 * Who is asking, and what may they see.
 *
 * Every page and API route derives visibility from this — never from a client
 * flag. An anonymous viewer resolves to no entitlements, so locked content is
 * never fetched, let alone rendered (§23).
 */
export async function getViewer(): Promise<Viewer> {
  const user = await getCurrentUser();
  const entitlements = await getUserEntitlements(user?.id ?? null);

  const role = (user?.role ?? 'USER') as 'USER' | 'ADMIN';

  return {
    userId: user?.id ?? null,
    email: user?.email ?? null,
    role,
    isAdmin: role === 'ADMIN',
    entitlements,
  };
}
