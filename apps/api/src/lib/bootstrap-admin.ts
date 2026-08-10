import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { config } from '../config.js'
import { db, schema } from '../db/index.js'
import { hashPassword } from './password.js'

/**
 * Creates the initial admin account from BOOTSTRAP_ADMIN_* env vars when no
 * admin/owner with a password exists yet. The bootstrap password is only used
 * for this one-time setup — the user must change it on first login.
 */
export async function bootstrapAdmin(log: FastifyBaseLogger): Promise<void> {
  const email = config.BOOTSTRAP_ADMIN_EMAIL
  const password = config.BOOTSTRAP_ADMIN_PASSWORD

  if (!email || !password) {
    if (config.NODE_ENV === 'production') {
      log.info('No BOOTSTRAP_ADMIN_* vars set — skipping admin bootstrap.')
    }
    return
  }

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        inArray(schema.users.role, ['admin', 'owner']),
        isNotNull(schema.users.passwordHash),
      ),
    )
    .limit(1)

  if (existing) {
    log.info('Admin password auth already configured — bootstrap skipped.')
    return
  }

  const passwordHash = await hashPassword(password)
  const now = new Date()
  const isOwner =
    Boolean(config.OWNER_EMAIL) &&
    email.toLowerCase() === config.OWNER_EMAIL.toLowerCase()

  const [byEmail] = await db
    .select({ id: schema.users.id, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1)

  if (byEmail) {
    await db
      .update(schema.users)
      .set({
        passwordHash,
        mustChangePassword: true,
        role: isOwner ? 'owner' : byEmail.role === 'owner' ? 'owner' : 'admin',
        updatedAt: now,
        onboardedAt: now,
      })
      .where(eq(schema.users.id, byEmail.id))
    log.warn(
      { email },
      'Bootstrap admin password set on existing account — change it on first login.',
    )
    return
  }

  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({
        email,
        passwordHash,
        mustChangePassword: true,
        role: isOwner ? 'owner' : 'admin',
        onboardedAt: now,
        termsAcceptedAt: now,
        termsVersion: '1.0.0',
      })
      .returning({ id: schema.users.id })

    await tx.insert(schema.profiles).values({
      userId: user!.id,
      displayName: email.split('@')[0] ?? 'Admin',
    })
  })

  log.warn(
    { email },
    'Bootstrap admin account created — sign in at /admin/login and change the password immediately.',
  )
}
