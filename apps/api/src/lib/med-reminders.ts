import { eq } from 'drizzle-orm'
import {
  medicationRRule,
  padClockTime,
  scheduleForReminders,
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

type SlotMember = { med: MedReminderRow; schedule: Schedule }

async function userTimezone(userId: string): Promise<string> {
  const [row] = await db
    .select({ timezone: schema.profiles.timezone })
    .from(schema.profiles)
    .where(eq(schema.profiles.userId, userId))
    .limit(1)
  return row?.timezone || 'America/New_York'
}

function parseSchedule(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = { ...(raw as Record<string, unknown>) }
  if (Array.isArray(rec.times)) {
    rec.times = rec.times.map((t) => (typeof t === 'string' ? (padClockTime(t) ?? t) : t))
  }
  const parsed = scheduleSchema.safeParse(rec)
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

function formatDoseClock(time: string): string {
  const hh = Number(time.slice(0, 2))
  const mm = time.slice(3, 5)
  const suffix = hh >= 12 ? 'PM' : 'AM'
  const h12 = hh % 12 || 12
  return `${h12}:${mm} ${suffix}`
}

function slotTitle(time: string): string {
  return `Meds · ${formatDoseClock(time)}`
}

function slotDescription(members: SlotMember[]): string {
  const lines = ['MedicalBot dose reminder — log each one in the app for adherence.', '']
  for (const { med, schedule } of members) {
    const extra: string[] = []
    if (schedule.withFood) extra.push('with food')
    if (schedule.instructions) extra.push(schedule.instructions)
    lines.push(`• ${med.name} ${med.dose}${extra.length ? ` (${extra.join(' · ')})` : ''}`)
  }
  return lines.join('\n')
}

function slotDaysOfWeek(schedules: Schedule[]): number[] {
  if (schedules.some((s) => s.daysOfWeek.length === 0)) return []
  return [...new Set(schedules.flatMap((s) => s.daysOfWeek))].sort((a, b) => a - b)
}

function slotUntil(meds: MedReminderRow[]): string | null {
  const untils = meds.map((m) => endedYmd(m.endedAt))
  if (untils.some((u) => !u)) return null
  return [...untils].sort().at(-1) ?? null
}

function slotRRule(time: string, members: SlotMember[]): string | null {
  return medicationRRule(
    {
      kind: 'fixed_times',
      times: [time],
      intervalHours: null,
      daysOfWeek: slotDaysOfWeek(members.map((m) => m.schedule)),
      cycleOnDays: null,
      cycleOffDays: null,
      withFood: false,
      instructions: null,
    },
    slotUntil(members.map((m) => m.med)),
  )
}

async function loadMeds(userId: string): Promise<MedReminderRow[]> {
  return db
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
}

/**
 * One recurring Google event per clock time, listing every med due then.
 * A single 8:00 AM popup beats five overlapping "Take …" series on the month view.
 */
export async function syncMedicationReminders(userId: string, _med: MedReminderRow): Promise<Record<string, string>> {
  await syncAllMedicationReminders(userId)
  return {}
}

export async function syncAllMedicationReminders(userId: string): Promise<{ synced: number }> {
  const connection = await getCalendarConnection(userId)
  const meds = await loadMeds(userId)
  if (!connection.connected) return { synced: 0 }

  const timeZone = await userTimezone(userId)
  const slots = new Map<string, SlotMember[]>()

  for (const med of meds) {
    if (!med.isActive) continue
    const parsed = parseSchedule(med.schedule)
    const usable = parsed ? scheduleForReminders(parsed) : null
    if (!usable || !medicationRRule(usable, endedYmd(med.endedAt))) continue
    for (const time of usable.times) {
      const list = slots.get(time) ?? []
      list.push({ med, schedule: usable })
      slots.set(time, list)
    }
  }

  const oldIds = new Set<string>()
  for (const med of meds) {
    for (const id of Object.values(med.googleEventIds ?? {})) {
      if (id) oldIds.add(id)
    }
  }

  const slotIds: Record<string, string> = {}
  const claimed = new Set<string>()

  for (const [time, members] of slots) {
    const rrule = slotRRule(time, members)
    if (!rrule) continue

    const candidateIds = [
      ...new Set(
        members
          .map(({ med }) => med.googleEventIds?.[time])
          .filter((id): id is string => Boolean(id)),
      ),
    ]
    const keepId = candidateIds[0] ?? null
    for (const extra of candidateIds.slice(1)) {
      try {
        await deleteGoogleCalendarEvent(userId, extra)
      } catch {
        // Already gone is fine.
      }
    }

    const start = nextOccurrence(time, timeZone, slotDaysOfWeek(members.map((m) => m.schedule)))
    const payload = {
      title: slotTitle(time),
      startsAt: start,
      endsAt: new Date(+start + DOSE_MINUTES * 60 * 1000),
      description: slotDescription(members),
      timeZone,
      recurrence: [rrule],
      reminderMinutes: [0],
      medbot: 'med',
    }

    let eventId = keepId
    try {
      if (eventId) {
        await updateGoogleCalendarEvent(userId, eventId, payload)
      } else {
        eventId = (await createGoogleCalendarEvent(userId, payload)) ?? null
      }
    } catch {
      if (eventId) {
        try {
          eventId = (await createGoogleCalendarEvent(userId, payload)) ?? null
        } catch {
          eventId = null
        }
      }
    }

    if (eventId) {
      slotIds[time] = eventId
      claimed.add(eventId)
    }
  }

  for (const id of oldIds) {
    if (claimed.has(id)) continue
    try {
      await deleteGoogleCalendarEvent(userId, id)
    } catch {
      // Already gone is fine.
    }
  }

  for (const med of meds) {
    const nextIds: Record<string, string> = {}
    if (med.isActive) {
      const parsed = parseSchedule(med.schedule)
      const usable = parsed ? scheduleForReminders(parsed) : null
      for (const time of usable?.times ?? []) {
        if (slotIds[time]) nextIds[time] = slotIds[time]
      }
    }
    await db
      .update(schema.medications)
      .set({ googleEventIds: nextIds })
      .where(eq(schema.medications.id, med.id))
  }

  return { synced: Object.keys(slotIds).length }
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
  const meds = await loadMeds(userId)

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

  const groups = new Map<string, typeof out>()
  for (const item of out) {
    const key = item.startsAt.toISOString()
    const list = groups.get(key) ?? []
    list.push(item)
    groups.set(key, list)
  }

  return [...groups.values()].map((members) => {
    const first = members[0]!
    const clock = clockFromDate(first.startsAt, timeZone)
    return {
      id: `dose-slot:${clock}:${first.startsAt.toISOString()}`,
      medicationId: first.medicationId,
      title: slotTitle(clock),
      startsAt: first.startsAt,
      endsAt: first.endsAt,
      notes: [
        'MedicalBot dose reminder — log each one in the app for adherence.',
        '',
        ...members.map((m) => `• ${m.title.replace(/^Take /, '')}`),
      ].join('\n'),
      synced: members.some((m) => m.synced),
      googleEventId: members.find((m) => m.googleEventId)?.googleEventId ?? null,
    }
  })
}

function clockFromDate(at: Date, timeZone: string): string {
  const w = wallClock(at, timeZone)
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`
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
