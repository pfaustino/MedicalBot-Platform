import { z } from 'zod'
import { addCalendarDays, wallClock, zonedDate } from './zoned-time.js'

/**
 * Schedules are structured, never freetext. Reminder jobs and adherence scoring
 * both read this, so "twice daily with food" has to be machine-readable.
 */
export const scheduleSchema = z.object({
  kind: z.enum(['fixed_times', 'interval_hours', 'as_needed', 'cyclic']),
  /** 24h local times, e.g. ["08:00", "20:00"]. Used by fixed_times. */
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).default([]),
  /** Used by interval_hours. */
  intervalHours: z.number().int().positive().nullable().default(null),
  /** 0=Sunday..6=Saturday. Empty means every day. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
  /** Used by cyclic, e.g. 21 days on / 7 off. */
  cycleOnDays: z.number().int().positive().nullable().default(null),
  cycleOffDays: z.number().int().positive().nullable().default(null),
  withFood: z.boolean().default(false),
  instructions: z.string().max(500).nullable().default(null),
})
export type Schedule = z.infer<typeof scheduleSchema>

export const medicationSchema = z.object({
  name: z.string().min(1).max(200),
  /** RxNorm concept id once resolved. Null until normalized. */
  rxcui: z.string().max(20).nullable().default(null),
  dose: z.string().min(1).max(100),
  form: z
    .enum([
      'tablet',
      'capsule',
      'liquid',
      'injection',
      'inhaler',
      'patch',
      'topical',
      'other',
    ])
    .default('tablet'),
  schedule: scheduleSchema,
  purpose: z.string().max(300).nullable().default(null),
  prescriber: z.string().max(200).nullable().default(null),
  pharmacy: z.string().max(200).nullable().default(null),
  startedAt: z.coerce.date().nullable().default(null),
  endedAt: z.coerce.date().nullable().default(null),
  refillsRemaining: z.number().int().min(0).nullable().default(null),
  isActive: z.boolean().default(true),
})
export type Medication = z.infer<typeof medicationSchema>

export const ADHERENCE_STATUSES = ['taken', 'skipped', 'late', 'missed'] as const
export type AdherenceStatus = (typeof ADHERENCE_STATUSES)[number]

export const adherenceEventSchema = z.object({
  medicationId: z.string().uuid(),
  status: z.enum(ADHERENCE_STATUSES),
  /** The dose slot this event answers for. */
  scheduledFor: z.coerce.date(),
  recordedAt: z.coerce.date(),
  /** "made me drowsy", "ran out", "forgot" — the why matters clinically. */
  reason: z.string().max(500).nullable().default(null),
})
export type AdherenceEvent = z.infer<typeof adherenceEventSchema>

/** Fraction of scheduled doses marked taken (late still counts as taken). */
export function adherenceRate(events: readonly AdherenceEvent[]): number {
  if (events.length === 0) return 1
  const took = events.filter((e) => e.status === 'taken' || e.status === 'late').length
  return took / events.length
}

const RRULE_BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

/** Pad `8:00` → `08:00`. Returns null when the string is not an HH:MM time. */
export function padClockTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2}):([0-5]\d)$/)
  if (!m) return null
  const hh = Number(m[1])
  if (hh > 23) return null
  return `${String(hh).padStart(2, '0')}:${m[2]}`
}

/**
 * Clock times implied by pharmacy-style frequency text. Used for imported meds
 * that were stored as as-needed with the cadence in `instructions`.
 */
export function inferTimesFromText(text: string | null | undefined): string[] {
  if (!text) return []
  const t = text.toLowerCase()
  if (/\b(as needed|as directed|prn|p\.?\s*r\.?\s*n\.?)\b/.test(t) && !/\b(once|twice|daily|bid|tid|qid)\b/.test(t)) {
    return []
  }
  const clock = [...text.matchAll(/\b(\d{1,2}):([0-5]\d)\b/g)]
    .map((m) => padClockTime(m[0]))
    .filter((x): x is string => Boolean(x))
  if (clock.length > 0) return [...new Set(clock)]

  if (/\b(four times|qid|q\.i\.d|q6h|every 6)\b/.test(t)) return ['08:00', '12:00', '18:00', '22:00']
  if (/\b(three times|tid|t\.i\.d|q8h|every 8)\b/.test(t)) return ['08:00', '14:00', '20:00']
  if (/\b(twice|bid|b\.i\.d|q12h|every 12|2x|two times)\b/.test(t)) return ['08:00', '20:00']
  if (/\b(bedtime|qhs|q\.h\.s|at night|nightly)\b/.test(t)) return ['21:00']
  if (/\b(once daily|once a day|daily|every day|qday|q\.?d\.?\b|every morning|qam|each morning)\b/.test(t)) {
    return ['08:00']
  }
  return []
}

/**
 * Schedule the calendar can actually expand. Pads stored times and, when a med
 * was imported as as-needed, infers clock times from frequency instructions.
 */
export function scheduleForReminders(schedule: Schedule): Schedule | null {
  const times = schedule.times.map((t) => padClockTime(t)).filter((t): t is string => Boolean(t))
  if (schedule.kind === 'fixed_times' && times.length > 0) {
    return { ...schedule, times }
  }
  const inferred = inferTimesFromText(schedule.instructions)
  if (inferred.length === 0) return null
  return { ...schedule, kind: 'fixed_times', times: inferred }
}

/**
 * Recurrence for a fixed-time medication schedule. Null when the schedule
 * cannot become a calendar series (as-needed, interval, cyclic, or no times).
 */
export function medicationRRule(schedule: Schedule, untilYmd?: string | null): string | null {
  const usable = scheduleForReminders(schedule)
  if (!usable) return null
  const until =
    untilYmd && /^\d{4}-\d{2}-\d{2}$/.test(untilYmd)
      ? `;UNTIL=${untilYmd.replace(/-/g, '')}`
      : ''
  if (usable.daysOfWeek.length === 0) return `RRULE:FREQ=DAILY${until}`
  const days = [...usable.daysOfWeek]
    .sort((a, b) => a - b)
    .map((d) => RRULE_BYDAY[d])
    .join(',')
  return `RRULE:FREQ=WEEKLY;BYDAY=${days}${until}`
}

export interface DoseSlot {
  time: string
  at: Date
}

/**
 * Expand fixed-time dose slots between `from` and `to` in `timeZone`.
 * Empty daysOfWeek means every day.
 */
export function upcomingDoseSlots(
  schedule: Schedule,
  opts: { timeZone: string; from: Date; to: Date },
): DoseSlot[] {
  const usable = scheduleForReminders(schedule)
  if (!usable) return []
  const days = usable.daysOfWeek.length > 0 ? new Set(usable.daysOfWeek) : null
  const start = wallClock(opts.from, opts.timeZone)
  const end = wallClock(opts.to, opts.timeZone)
  const out: DoseSlot[] = []
  let cursor = { year: start.year, month: start.month, day: start.day }
  const endKey = end.year * 10000 + end.month * 100 + end.day
  for (let i = 0; i < 400; i++) {
    const key = cursor.year * 10000 + cursor.month * 100 + cursor.day
    if (key > endKey) break
    const noon = zonedDate(opts.timeZone, cursor.year, cursor.month, cursor.day, 12, 0)
    const weekday = wallClock(noon, opts.timeZone).weekday
    if (!days || days.has(weekday)) {
      for (const time of usable.times) {
        const hh = Number(time.slice(0, 2))
        const mm = Number(time.slice(3, 5))
        const at = zonedDate(opts.timeZone, cursor.year, cursor.month, cursor.day, hh, mm)
        if (at >= opts.from && at <= opts.to) out.push({ time, at })
      }
    }
    cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, 1)
  }
  return out
}
