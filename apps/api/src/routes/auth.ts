import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { TERMS_VERSION } from '@medbot/shared'
import { config, googleConfigured } from '../config.js'
import { db, schema } from '../db/index.js'
import { encrypt } from '../lib/crypto.js'
import { hashPassword, verifyPassword } from '../lib/password.js'
import { rateLimit } from '../lib/rate-limit.js'

/**
 * Google OAuth. Scopes are requested incrementally (SPEC.md §6) — login asks
 * only for identity. Calendar, Drive, and Gmail are granted later from settings,
 * so a new user is not confronted with a wall of permissions at signup.
 */

const LOGIN_SCOPES = ['openid', 'email', 'profile']

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
})

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
})

const LOGIN_RATE = { max: 10, windowMs: 15 * 60 * 1000 }

function clientIp(request: FastifyRequest): string {
  return request.ip
}

export const INCREMENTAL_SCOPES = {
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  drive: ['https://www.googleapis.com/auth/drive.file'],
  tasks: ['https://www.googleapis.com/auth/tasks'],
  gmail_read: ['https://www.googleapis.com/auth/gmail.readonly'],
} as const

declare module 'fastify' {
  interface Session {
    userId?: string
    oauthState?: string
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/google', async (request, reply) => {
    if (!googleConfigured) {
      return reply.redirect(`${config.APP_URL}/?signin=google-unconfigured`)
    }

    const state = randomBytes(16).toString('hex')
    request.session.oauthState = state

    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID!,
      redirect_uri: config.GOOGLE_REDIRECT_URI!,
      response_type: 'code',
      scope: LOGIN_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    })

    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  })

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/auth/google/callback',
    async (request, reply) => {
      const { code, state } = request.query

      if (!code || !state || state !== request.session.oauthState) {
        return reply.code(400).send({ error: 'Invalid OAuth callback' })
      }
      request.session.oauthState = undefined

      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.GOOGLE_CLIENT_ID!,
          client_secret: config.GOOGLE_CLIENT_SECRET!,
          redirect_uri: config.GOOGLE_REDIRECT_URI!,
          grant_type: 'authorization_code',
        }),
      })

      if (!tokenResponse.ok) {
        request.log.error({ status: tokenResponse.status }, 'Google token exchange failed')
        return reply.code(502).send({ error: 'Google token exchange failed' })
      }

      const tokens = (await tokenResponse.json()) as {
        access_token: string
        refresh_token?: string
        expires_in: number
        scope: string
      }

      const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })

      if (!profileResponse.ok) {
        return reply.code(502).send({ error: 'Could not read Google profile' })
      }

      const googleProfile = (await profileResponse.json()) as {
        sub: string
        email: string
        name?: string
      }

      const userId = await upsertUser(googleProfile, tokens)
      request.session.userId = userId

      return reply.redirect(config.APP_URL)
    },
  )

  app.post('/auth/logout', async (request, reply) => {
    await request.session.destroy()
    return reply.send({ ok: true })
  })

  app.post('/auth/admin/login', async (request, reply) => {
    const limit = rateLimit(`admin-login:${clientIp(request)}`, LOGIN_RATE)
    if (!limit.allowed) {
      return reply
        .code(429)
        .send({ error: 'Too many login attempts. Try again later.', retryAfterSec: limit.retryAfterSec })
    }

    const parsed = loginBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid email or password' })
    }

    const { email, password } = parsed.data

    const [user] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        role: schema.users.role,
        passwordHash: schema.users.passwordHash,
        mustChangePassword: schema.users.mustChangePassword,
      })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1)

    if (
      !user?.passwordHash ||
      (user.role !== 'admin' && user.role !== 'owner') ||
      !(await verifyPassword(password, user.passwordHash))
    ) {
      return reply.code(401).send({ error: 'Invalid email or password' })
    }

    request.session.userId = user.id
    return reply.send({
      ok: true,
      mustChangePassword: user.mustChangePassword,
      email: user.email,
      role: user.role,
    })
  })

  app.post('/auth/change-password', async (request, reply) => {
    const userId = request.session.userId
    if (!userId) return reply.code(401).send({ error: 'Not authenticated' })

    const limit = rateLimit(`change-password:${clientIp(request)}`, LOGIN_RATE)
    if (!limit.allowed) {
      return reply
        .code(429)
        .send({ error: 'Too many attempts. Try again later.', retryAfterSec: limit.retryAfterSec })
    }

    const parsed = changePasswordBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid password', issues: parsed.error.issues })
    }

    const [user] = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)

    if (!user?.passwordHash) {
      return reply.code(400).send({ error: 'Password login is not enabled for this account' })
    }

    if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
      return reply.code(401).send({ error: 'Current password is incorrect' })
    }

    const now = new Date()
    await db
      .update(schema.users)
      .set({
        passwordHash: await hashPassword(parsed.data.newPassword),
        mustChangePassword: false,
        updatedAt: now,
      })
      .where(eq(schema.users.id, userId))

    return reply.send({ ok: true })
  })

  app.get('/auth/me', async (request, reply) => {
    const userId = request.session.userId
    if (!userId) return reply.code(401).send({ error: 'Not authenticated' })

    const [user] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        role: schema.users.role,
        onboardedAt: schema.users.onboardedAt,
        termsAcceptedAt: schema.users.termsAcceptedAt,
        termsVersion: schema.users.termsVersion,
        mustChangePassword: schema.users.mustChangePassword,
        hasPassword: schema.users.passwordHash,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)

    if (!user) return reply.code(401).send({ error: 'Not authenticated' })
    return reply.send({
      id: user.id,
      email: user.email,
      role: user.role,
      onboardedAt: user.onboardedAt,
      termsAcceptedAt: user.termsAcceptedAt,
      termsVersion: user.termsVersion,
      isAdmin: user.role === 'admin' || user.role === 'owner',
      mustChangePassword: user.mustChangePassword,
      hasPassword: Boolean(user.hasPassword),
      needsTermsAcceptance: needsTermsAcceptance(user.termsAcceptedAt, user.termsVersion),
      currentTermsVersion: TERMS_VERSION,
    })
  })

  app.post('/auth/accept-terms', async (request, reply) => {
    const userId = request.session.userId
    if (!userId) return reply.code(401).send({ error: 'Not authenticated' })

    const now = new Date()
    await db
      .update(schema.users)
      .set({
        termsAcceptedAt: now,
        termsVersion: TERMS_VERSION,
        updatedAt: now,
      })
      .where(eq(schema.users.id, userId))

    return reply.send({
      ok: true,
      termsAcceptedAt: now.toISOString(),
      termsVersion: TERMS_VERSION,
    })
  })
}

async function upsertUser(
  profile: { sub: string; email: string; name?: string },
  tokens: { access_token: string; refresh_token?: string; expires_in: number; scope: string },
): Promise<string> {
  // Promote the configured operator to owner on sign-in. Never auto-downgrade an
  // existing role, so admins keep their access across logins.
  const isOwner = Boolean(
    config.OWNER_EMAIL && profile.email.toLowerCase() === config.OWNER_EMAIL.toLowerCase(),
  )

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({ googleId: profile.sub, email: profile.email, role: isOwner ? 'owner' : 'user' })
      .onConflictDoUpdate({
        target: schema.users.googleId,
        set: {
          email: profile.email,
          updatedAt: new Date(),
          ...(isOwner ? { role: 'owner' } : {}),
        },
      })
      .returning({ id: schema.users.id })

    const userId = user!.id

    await tx
      .insert(schema.profiles)
      .values({ userId, displayName: profile.name ?? profile.email })
      .onConflictDoNothing()

    await tx
      .insert(schema.googleAccounts)
      .values({
        userId,
        accessToken: tokens.access_token,
        // Google only returns a refresh token on first consent; keep the stored
        // one when this exchange did not include a new one.
        refreshTokenEncrypted: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        scopes: tokens.scope.split(' '),
      })
      .onConflictDoUpdate({
        target: schema.googleAccounts.userId,
        set: {
          accessToken: tokens.access_token,
          expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          scopes: tokens.scope.split(' '),
          updatedAt: new Date(),
        },
      })

    return userId
  })
}

/** preHandler that rejects unauthenticated requests. */
export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.session.userId) {
    await reply.code(401).send({ error: 'Not authenticated' })
  }
}

export function needsTermsAcceptance(
  termsAcceptedAt: Date | null,
  termsVersion: string | null,
): boolean {
  if (!termsAcceptedAt || !termsVersion) return true
  return termsVersion !== TERMS_VERSION
}

/** Reads the session user's role, or null when not signed in / not found. */
export async function roleOf(userId: string | undefined): Promise<string | null> {
  if (!userId) return null
  const [row] = await db
    .select({ role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)
  return row?.role ?? null
}

/** preHandler: rejects anyone who is not an admin or owner. */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const role = await roleOf(request.session.userId)
  if (role !== 'admin' && role !== 'owner') {
    await reply.code(403).send({ error: 'Admin access required' })
  }
}

/** preHandler: rejects anyone who is not the owner. */
export async function requireOwner(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const role = await roleOf(request.session.userId)
  if (role !== 'owner') {
    await reply.code(403).send({ error: 'Owner access required' })
  }
}
