import type { FastifyInstance } from 'fastify'
import { and, asc, eq, gte, isNotNull, lte, or } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import {
  deleteGoogleCalendarEvent,
  getCalendarConnection,
  listGoogleCalendarEvents,
  updateGoogleCalendarEvent,
} from '../lib/google.js'
import { expandMedicationDoses, syncAllMedicationReminders } from '../lib/med-reminders.js'
import { requireUser } from './auth.js'

export type CalendarItem = {
  id: string
  kind: 'appointment' | 'todo' | 'google' | 'reminder'
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

    const doses = await expandMedicationDoses(userId, pastFrom, futureTo)
    for (const d of doses) {
      items.push({
        id: d.id,
        kind: 'reminder',
        title: d.title,
        startsAt: d.startsAt.toISOString(),
        endsAt: d.endsAt.toISOString(),
        allDay: false,
        location: null,
        notes: d.notes,
        status: null,
        type: 'medication',
        googleEventId: d.googleEventId,
        htmlLink: null,
        synced: d.synced,
      })
    }

    let googleError: string | null = null
    if (connection.connected) {
      try {
        const googleEvents = await listGoogleCalendarEvents(userId, pastFrom, futureTo)
        const localGoogleIds = new Set(
          appointments.map((a) => a.googleEventId).filter((id): id is string => Boolean(id)),
        )
        const reminderSeriesIds = new Set(
          doses.map((d) => d.googleEventId).filter((id): id is string => Boolean(id)),
        )
        for (const g of googleEvents) {
          if (localGoogleIds.has(g.id)) continue
          if (g.medbot === 'med' || (g.recurringEventId && reminderSeriesIds.has(g.recurringEventId))) {
            continue
          }
          const isGlucose = g.medbot === 'glucose'
          items.push({
            id: g.id,
            kind: isGlucose ? 'reminder' : 'google',
            title: g.title,
            startsAt: g.startsAt,
            endsAt: g.endsAt,
            allDay: g.allDay,
            location: g.location,
            notes: null,
            status: null,
            type: isGlucose ? 'glucose' : null,
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

  app.post('/calendar/reminders/sync', async (request, reply) => {
    const userId = request.session.userId!
    try {
      const result = await syncAllMedicationReminders(userId)
      return reply.send({ ok: true, ...result })
    } catch (err) {
      request.log.warn({ err }, 'Medication reminder sync failed')
      return reply.code(502).send({
        error: err instanceof Error ? err.message : 'Could not sync dose reminders to Google Calendar',
      })
    }
  })

  const googleEventBody = z.object({
    title: z.string().min(1).max(200),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date().nullable().default(null),
    location: z.string().max(300).nullable().default(null),
    description: z.string().max(4000).nullable().default(null),
    allDay: z.boolean().optional().default(false),
  })

  app.patch('/calendar/google/:eventId', async (request, reply) => {
    const parsed = googleEventBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid event', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const { eventId } = request.params as { eventId: string }
    try {
      await updateGoogleCalendarEvent(userId, eventId, {
        title: parsed.data.title,
        startsAt: parsed.data.startsAt,
        endsAt: parsed.data.endsAt,
        location: parsed.data.location,
        description: parsed.data.description,
        allDay: parsed.data.allDay,
      })
      return reply.send({ ok: true })
    } catch (err) {
      request.log.warn({ err }, 'Google Calendar update failed')
      return reply.code(502).send({
        error: err instanceof Error ? err.message : 'Could not update Google Calendar event',
      })
    }
  })

  app.delete('/calendar/google/:eventId', async (request, reply) => {
    const userId = request.session.userId!
    const { eventId } = request.params as { eventId: string }
    try {
      await deleteGoogleCalendarEvent(userId, eventId)
      return reply.send({ ok: true })
    } catch (err) {
      request.log.warn({ err }, 'Google Calendar delete failed')
      return reply.code(502).send({
        error: err instanceof Error ? err.message : 'Could not delete Google Calendar event',
      })
    }
  })
}
