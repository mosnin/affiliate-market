/**
 * Client-portal auth — fully separate from the seller Clerk auth.
 *
 * Email + password accounts for end users (applicants / demo-bookers). Sessions
 * are stateless signed JWTs in an httpOnly cookie scoped to the portal; never
 * touches Clerk, Clerk cookies, or the seller session. Passwords are scrypt
 * (node:crypto, no new dependency). Email verification + passwordless login use
 * 6-digit one-time codes (hashed at rest).
 */
import 'server-only';
import {
  scryptSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
  createHash,
} from 'crypto';
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';

export const CLIENT_SESSION_COOKIE = 'cola_client_session';
const SESSION_TTL = '30d';
const CODE_TTL_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 6;

function sessionSecret(): Uint8Array {
  const raw = process.env.CLIENT_AUTH_SECRET || process.env.CLERK_SECRET_KEY;
  if (!raw) {
    // Fail closed: never sign client-portal sessions with a hardcoded dev
    // string — that made forged sessions trivial if both env vars were absent.
    // CLIENT_AUTH_SECRET is preferred; CLERK_SECRET_KEY stays as a fallback
    // ONLY so sessions issued before CLIENT_AUTH_SECRET was provisioned remain
    // valid (otherwise every client is logged out on deploy).
    throw new Error('CLIENT_AUTH_SECRET (or CLERK_SECRET_KEY) must be set for the client portal');
  }
  // Domain-separate from any other HMAC use of the same raw secret.
  return new TextEncoder().encode(`client-portal:${raw}`);
}

// ── Passwords ───────────────────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  try {
    const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    return hash.length === expected.length && timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

// ── One-time codes ──────────────────────────────────────────────────────────

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export interface ClientUserRow {
  id: string;
  email: string;
  emailLower: string;
  name: string | null;
  phone: string | null;
  emailVerifiedAt: string | null;
}

export async function findClientByEmail(email: string): Promise<(ClientUserRow & { passwordHash: string }) | null> {
  return await convex().query(api.portal.clientUsers.findByEmail, {
    emailLower: email.trim().toLowerCase(),
  });
}

export async function findClientById(id: string): Promise<ClientUserRow | null> {
  return await convex().query(api.portal.clientUsers.findById, { id });
}

export async function createClientUser(params: {
  email: string;
  password: string;
  name?: string;
  phone?: string;
}): Promise<ClientUserRow | null> {
  // emailLower + passwordHash computed here (scrypt stays in lib); the Convex
  // mutation returns null on the UNIQUE(emailLower) conflict, exactly as the old
  // insert returned null on the unique-violation error.
  try {
    return await convex().mutation(api.portal.clientUsers.create, {
      email: params.email.trim(),
      emailLower: params.email.trim().toLowerCase(),
      passwordHash: hashPassword(params.password),
      name: params.name?.trim() || null,
      phone: params.phone?.trim() || null,
    });
  } catch (error) {
    logger.warn('[client-auth] createClientUser failed', {
      err: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function markEmailVerified(emailLower: string): Promise<void> {
  await convex().mutation(api.portal.clientUsers.markEmailVerified, { emailLower });
}

export async function setClientPassword(emailLower: string, password: string): Promise<void> {
  await convex().mutation(api.portal.clientUsers.setPassword, {
    emailLower,
    passwordHash: hashPassword(password),
  });
}

/** Issue a one-time code, store its hash, and return the plaintext to email. */
export async function issueCode(
  email: string,
  purpose: 'verify' | 'login' | 'reset',
): Promise<string | null> {
  const emailLower = email.trim().toLowerCase();
  const code = generateCode();
  // Invalidate any prior unconsumed codes for this (email, purpose) so only the
  // newest code is ever valid — closes the window where a resend/race leaves
  // multiple live codes that each satisfy the one-time guarantee.
  try {
    await convex().mutation(api.portal.clientAuthCodes.invalidatePrior, {
      emailLower,
      purpose,
    });
    await convex().mutation(api.portal.clientAuthCodes.issue, {
      emailLower,
      codeHash: hashCode(code),
      purpose,
      expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString(),
    });
  } catch (error) {
    logger.warn('[client-auth] issueCode failed', {
      purpose,
      err: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  return code;
}

/** Verify a code for (email, purpose). Consumes it on success. */
export async function consumeCode(
  email: string,
  code: string,
  purpose: 'verify' | 'login' | 'reset',
): Promise<boolean> {
  const emailLower = email.trim().toLowerCase();
  // The newest unconsumed, unexpired candidate. `now` is passed so the expiry
  // boundary uses this caller's clock (matching the old `.gt('expiresAt', now)`).
  const row = await convex().query(api.portal.clientAuthCodes.findCandidate, {
    emailLower,
    purpose,
    now: new Date().toISOString(),
  });

  if (!row) return false;
  if (row.attempts >= MAX_CODE_ATTEMPTS) return false;

  const ok =
    row.codeHash.length === hashCode(code).length &&
    timingSafeEqual(Buffer.from(row.codeHash, 'hex'), Buffer.from(hashCode(code), 'hex'));

  if (!ok) {
    await convex().mutation(api.portal.clientAuthCodes.incrementAttempts, { id: row.id });
    return false;
  }
  await convex().mutation(api.portal.clientAuthCodes.consume, { id: row.id });
  return true;
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function createSessionToken(user: ClientUserRow): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name ?? undefined })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(sessionSecret());
}

/** Set the session cookie. Call from a route handler / server action. */
export async function startSession(user: ClientUserRow): Promise<void> {
  const token = await createSessionToken(user);
  const jar = await cookies();
  jar.set(CLIENT_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(CLIENT_SESSION_COOKIE);
}

/** Current client from the session cookie, or null. Safe in server components. */
export async function getClientUser(): Promise<ClientUserRow | null> {
  const jar = await cookies();
  const token = jar.get(CLIENT_SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    if (!payload.sub) return null;
    return await findClientById(payload.sub);
  } catch {
    return null;
  }
}
