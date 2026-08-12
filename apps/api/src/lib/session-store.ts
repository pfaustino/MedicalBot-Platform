import { eq } from 'drizzle-orm'
import type { Session } from 'fastify'
import { db, schema } from '../db/index.js'

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

type StoreCallback = (err?: unknown) => void
type StoreGetCallback = (err: unknown, session?: Session | null) => void

/**
 * Postgres-backed session store for `@fastify/session`.
 * Survives Railway redeploys (unlike the default in-memory store).
 */
export class PgSessionStore {
  set(sessionId: string, session: Session, callback: StoreCallback): void {
    void this.setAsync(sessionId, session).then(
      () => callback(),
      (err: unknown) => callback(err),
    )
  }

  get(sessionId: string, callback: StoreGetCallback): void {
    void this.getAsync(sessionId).then(
      (session) => callback(null, session),
      (err: unknown) => callback(err),
    )
  }

  destroy(sessionId: string, callback: StoreCallback): void {
    void this.destroyAsync(sessionId).then(
      () => callback(),
      (err: unknown) => callback(err),
    )
  }

  private async setAsync(sessionId: string, session: Session): Promise<void> {
    const maxAge =
      typeof session.cookie?.maxAge === 'number' && session.cookie.maxAge > 0
        ? session.cookie.maxAge
        : DEFAULT_MAX_AGE_MS
    const expire = new Date(Date.now() + maxAge)
    const sess = session as unknown as Record<string, unknown>

    await db
      .insert(schema.sessions)
      .values({ sid: sessionId, sess, expire })
      .onConflictDoUpdate({
        target: schema.sessions.sid,
        set: { sess, expire },
      })
  }

  private async getAsync(sessionId: string): Promise<Session | null> {
    const [row] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.sid, sessionId))
      .limit(1)

    if (!row) return null

    if (row.expire.getTime() <= Date.now()) {
      await db.delete(schema.sessions).where(eq(schema.sessions.sid, sessionId))
      return null
    }

    return row.sess as unknown as Session
  }

  private async destroyAsync(sessionId: string): Promise<void> {
    await db.delete(schema.sessions).where(eq(schema.sessions.sid, sessionId))
  }
}
