import type { FastifyInstance } from 'fastify'
import { and, asc, eq, gte, isNotNull, lte, or } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  getCalendarConnection,
  listGoogleCalendarEvents,
} from '../lib/google.js'
import { requireUser } from './auth.js'

export type CalendarItem = {
  id: string
  kind: 'appointment' | 'todo' | 'google'
  title: string
  startsAt: string
  endsAt: string | null
  allDay: boolean
  location: string | null
  notes: string | null
  status: string | null
  type: string | null
  googleEventId: string | null
  htmlLink: string | null
  synced: boolean
}

/**
 * Unified calendar feed: local appointments, open to-dos with due dates, and
 * (when connected) Google Calendar primary events.
 */
export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  app.get('/calendar', async (request, reply) => {
    const userId = request.session.userId!
    const now = new Date()
    const pastFrom = new Date(now.getTime() - 30 * 86400000)
    const futureTo = new Date(now.getTime() + 90 * 86400000)

    const connection = await getCalendarConnection(userId)

    const [appointments, todos] = await Promise.all([
      db
        .select({
          id: schema.appointments.id,
          title: schema.appointments.title,
          type: schema.appointments.type,
          location: schema.appointments.location,
          startsAt: schema.appointments.startsAt,
          endsAt: schema.appointments.endsAt,
          prepNotes: schema.appointments.prepNotes,
          visitNotes: schema.appointments.visitNotes,
          googleEventId: schema.appointments.googleEventId,
        })
        .from(schema.appointments)
        .where(
          and(
            eq(schema.appointments.userId, userId),
            gte(schema.appointments.startsAt, pastFrom),
            lte(schema.appointments.startsAt, futureTo),
          ),
        )
        .orderBy(asc(schema.appointments.startsAt)),
      db
        .select({
          id: schema.todos.id,
          title: schema.todos.title,
          notes: schema.todos.notes,
          dueAt: schema.todos.dueAt,
          status: schema.todos.status,
        })
        .from(schema.todos)
        .where(
          and(
            eq(schema.todos.userId, userId),
            isNotNull(schema.todos.dueAt),
            or(
              eq(schema.todos.status, 'open'),
              and(gte(schema.todos.dueAt, pastFrom), lte(schema.todos.dueAt, futureTo)),
            )!,
          ),
        )
        .orderBy(asc(schema.todos.dueAt)),
    ])

    const items: CalendarItem[] = []

    for (const a of appointments) {
      const start = a.startsAt
      const end = a.endsAt
      const looksAllDay =
        start.getHours() === 0 &&
        start.getMinutes() === 0 &&
        (!end ||
          (end.getHours() === 0 &&
            end.getMinutes() === 0 &&
            end.getTime() - start.getTime() >= 20 * 60 * 60 * 1000))
      items.push({
        id: a.id,
        kind: 'appointment',
        title: a.title,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt ? a.endsAt.toISOString() : null,
        allDay: looksAllDay,
        location: a.location,
        notes: a.visitNotes ?? a.prepNotes,
        status: null,
        type: a.type,
        googleEventId: a.googleEventId,
        htmlLink: null,
        synced: Boolean(a.googleEventId),
      })
    }

    for (const t of todos) {
      if (!t.dueAt) continue
      items.push({
        id: t.id,
        kind: 'todo',
        title: t.title,
        startsAt: t.dueAt.toISOString(),
        endsAt: null,
        allDay: true,
        location: null,
        notes: t.notes,
        status: t.status,
        type: null,
        googleEventId: null,
        htmlLink: null,
        synced: false,
      })
    }

    let googleError: string | null = null
    if (connection.connected) {
      try {
        const googleEvents = await listGoogleCalendarEvents(userId, pastFrom, futureTo)
        const localGoogleIds = new Set(
          appointments.map((a) => a.googleEventId).filter((id): id is string => Boolean(id)),
        )
        for (const g of googleEvents) {
          // Skip events we already surface as synced appointments.
          if (localGoogleIds.has(g.id)) continue
          items.push({
            id: g.id,
            kind: 'google',
            title: g.title,
            startsAt: g.startsAt,
            endsAt: g.endsAt,
            allDay: g.allDay,
            location: g.location,
            notes: null,
            status: null,
            type: null,
            googleEventId: g.id,
            htmlLink: g.htmlLink,
            synced: true,
          })
        }
      } catch (err) {
        request.log.warn({ err }, 'Google Calendar fetch failed')
        googleError =
          err instanceof Error && err.message
            ? err.message
            : 'Could not load Google Calendar events. Try reconnecting.'
      }
    }

    items.sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))

    const upcoming = items.filter((i) => new Date(i.startsAt) >= now || (i.kind === 'todo' && i.status === 'open'))
    const past = items.filter((i) => new Date(i.startsAt) < now && !(i.kind === 'todo' && i.status === 'open'))

    return reply.send({
      google: {
        connected: connection.connected,
        error: googleError,
      },
      upcoming,
      past: past.reverse(),
      range: { from: pastFrom.toISOString(), to: futureTo.toISOString() },
    })
  })
}
