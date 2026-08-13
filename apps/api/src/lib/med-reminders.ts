import { eq } from 'drizzle-orm'
import {
  medicationRRule,
  scheduleSchema,
  upcomingDoseSlots,
  ymdInZone,
  zonedDate,
  wallClock,
  type Schedule,
} from '@medbot/shared'
import { db, schema } from '../db/index.js'
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  getCalendarConnection,
  updateGoogleCalendarEvent,
} from './google.js'

const DOSE_MINUTES = 15
const GLUCOSE_FOLLOWUP_MS = 2 * 60 * 60 * 1000

export interface MedReminderRow {
  id: string
  name: string
  dose: string
  schedule: unknown
  isActive: boolean
  endedAt: string | Date | null
  googleEventIds: Record<string, string> | null
}

async function userTimezone(userId: string): Promise<string> {
  const [row] = await db
    .select({ timezone: schema.profiles.timezone })
    .from(schema.profiles)
    .where(eq(schema.profiles.userId, userId))
    .limit(1)
  return row?.timezone || 'America/New_York'
}

function parseSchedule(raw: unknown): Schedule | null {
  const parsed = scheduleSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function endedYmd(endedAt: string | Date | null): string | null {
  if (!endedAt) return null
  if (typeof endedAt === 'string') return endedAt.slice(0, 10)
  return endedAt.toISOString().slice(0, 10)
}

function nextOccurrence(time: string, timeZone: string, daysOfWeek: number[], from = new Date()): Date {
  const hh = Number(time.slice(0, 2))
  const mm = Number(time.slice(3, 5))
  const start = wallClock(from, timeZone)
  let cursor = { year: start.year, month: start.month, day: start.day }
  const allow = daysOfWeek.length > 0 ? new Set(daysOfWeek) : null
  for (let i = 0; i < 14; i++) {
    const noon = zonedDate(timeZone, cursor.year, cursor.month, cursor.day, 12, 0)
    const weekday = wallClock(noon, timeZone).weekday
    if (!allow || allow.has(weekday)) {
      const at = zonedDate(timeZone, cursor.year, cursor.month, cursor.day, hh, mm)
      if (at >= from) return at
    }
    const utc = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day + 1))
    cursor = { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
  }
  return zonedDate(timeZone, start.year, start.month, start.day, hh, mm)
}

function doseTitle(med: MedReminderRow): string {
  return `Take ${med.name} ${med.dose}`.trim()
}

function doseDescription(schedule: Schedule): string {
  const bits = ['MedicalBot dose reminder — log it in the app for adherence.']
  if (schedule.withFood) bits.push('Take with food.')
  if (schedule.instructions) bits.push(schedule.instructions)
  return bits.join(' ')
}

/**
 * Create or refresh recurring Google Calendar events with a phone popup at
 * each dose time. No-op when Calendar is not connected. Never throws to the
 * caller — Google failures are swallowed after a warn from the route.
 */
export async function syncMedicationReminders(userId: string, med: MedReminderRow): Promise<Record<string, string>> {
  const connection = await getCalendarConnection(userId)
  const existing = { ...(med.googleEventIds ?? {}) }
  const schedule = parseSchedule(med.schedule)
  const rrule = schedule && med.isActive ? medicationRRule(schedule, endedYmd(med.endedAt)) : null
  const desiredTimes = rrule && schedule ? schedule.times : []

  if (!connection.connected) {
    return existing
  }

  const timeZone = await userTimezone(userId)
  const nextIds: Record<string, string> = {}

  for (const [time, eventId] of Object.entries(existing)) {
    if (desiredTimes.includes(time)) continue
    try {
      await deleteGoogleCalendarEvent(userId, eventId)
    } catch {
      // Already gone is fine.
    }
  }

  for (const time of desiredTimes) {
    const start = nextOccurrence(time, timeZone, schedule?.daysOfWeek ?? [])
    const payload = {
      title: doseTitle(med),
      startsAt: start,
      endsAt: new Date(+start + DOSE_MINUTES * 60 * 1000),
      description: doseDescription(schedule!),
      timeZone,
      recurrence: [rrule!],
      reminderMinutes: [0],
      medbot: 'med',
    }
    const eventId = existing[time]
    try {
      if (eventId) {
        await updateGoogleCalendarEvent(userId, eventId, payload)
        nextIds[time] = eventId
      } else {
        const created = await createGoogleCalendarEvent(userId, payload)
        if (created) nextIds[time] = created
      }
    } catch {
      if (eventId) {
        try {
          const created = await createGoogleCalendarEvent(userId, payload)
          if (created) nextIds[time] = created
        } catch {
          // Leave this slot unsynced.
        }
      }
    }
  }

  await db
    .update(schema.medications)
    .set({ googleEventIds: nextIds })
    .where(eq(schema.medications.id, med.id))

  return nextIds
}

export async function syncAllMedicationReminders(userId: string): Promise<{ synced: number }> {
  const connection = await getCalendarConnection(userId)
  if (!connection.connected) return { synced: 0 }

  const meds = await db
    .select({
      id: schema.medications.id,
      name: schema.medications.name,
      dose: schema.medications.dose,
      schedule: schema.medications.schedule,
      isActive: schema.medications.isActive,
      endedAt: schema.medications.endedAt,
      googleEventIds: schema.medications.googleEventIds,
    })
    .from(schema.medications)
    .where(eq(schema.medications.userId, userId))

  let synced = 0
  for (const med of meds) {
    const ids = await syncMedicationReminders(userId, med)
    if (Object.keys(ids).length > 0) synced += 1
  }
  return { synced }
}

export async function expandMedicationDoses(
  userId: string,
  from: Date,
  to: Date,
): Promise<
  Array<{
    id: string
    medicationId: string
    title: string
    startsAt: Date
    endsAt: Date
    notes: string | null
    synced: boolean
    googleEventId: string | null
  }>
> {
  const timeZone = await userTimezone(userId)
  const meds = await db
    .select({
      id: schema.medications.id,
      name: schema.medications.name,
      dose: schema.medications.dose,
      schedule: schema.medications.schedule,
      isActive: schema.medications.isActive,
      endedAt: schema.medications.endedAt,
      googleEventIds: schema.medications.googleEventIds,
    })
    .from(schema.medications)
    .where(eq(schema.medications.userId, userId))

  const out: Array<{
    id: string
    medicationId: string
    title: string
    startsAt: Date
    endsAt: Date
    notes: string | null
    synced: boolean
    googleEventId: string | null
  }> = []

  for (const med of meds) {
    if (!med.isActive) continue
    const schedule = parseSchedule(med.schedule)
    if (!schedule) continue
    const until = endedYmd(med.endedAt)
    const ids = med.googleEventIds ?? {}
    for (const slot of upcomingDoseSlots(schedule, { timeZone, from, to })) {
      if (until && ymdInZone(slot.at, timeZone) > until) continue
      const googleEventId = ids[slot.time] ?? null
      out.push({
        id: `dose:${med.id}:${slot.time}:${slot.at.toISOString()}`,
        medicationId: med.id,
        title: doseTitle(med),
        startsAt: slot.at,
        endsAt: new Date(+slot.at + DOSE_MINUTES * 60 * 1000),
        notes: doseDescription(schedule),
        synced: Boolean(googleEventId),
        googleEventId,
      })
    }
  }
  return out
}

/** 2-hour post-meal glucose re-check as a timed Calendar event with a phone popup. */
export async function createGlucoseFollowUp(userId: string, recordedAt: Date): Promise<string | null> {
  const when = new Date(+recordedAt + GLUCOSE_FOLLOWUP_MS)
  if (when.getTime() < Date.now() + 5 * 60 * 1000) return null

  const timeZone = await userTimezone(userId)
  return createGoogleCalendarEvent(userId, {
    title: 'Recheck glucose',
    startsAt: when,
    endsAt: new Date(+when + DOSE_MINUTES * 60 * 1000),
    description: 'Follow-up 2 hours after your last reading. Log it in MedicalBot.',
    timeZone,
    reminderMinutes: [0],
    medbot: 'glucose',
  })
}
