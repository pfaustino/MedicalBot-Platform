/**
 * Wall-clock helpers for IANA time zones without a datetime library.
 * Two-pass UTC correction so DST transitions land on the intended local time.
 */

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

export interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function partsInZone(date: Date, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
}

export function wallClock(date: Date, timeZone: string): WallClock {
  const p = partsInZone(date, timeZone)
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAY_INDEX[p.weekday ?? ''] ?? 0,
  }
}

/** Instant that shows as this wall-clock time in `timeZone`. */
export function zonedDate(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0)
  for (let i = 0; i < 2; i++) {
    const wall = wallClock(new Date(utc), timeZone)
    const got = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0)
    const want = Date.UTC(year, month - 1, day, hour, minute, 0)
    utc += want - got
  }
  return new Date(utc)
}

export function addCalendarDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + delta))
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
}

/** `YYYY-MM-DDTHH:mm:ss` in `timeZone` — Google Calendar wall-clock form (no Z). */
export function formatWallClock(date: Date, timeZone: string): string {
  const w = wallClock(date, timeZone)
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}T${pad2(w.hour)}:${pad2(w.minute)}:00`
}

export function ymdInZone(date: Date, timeZone: string): string {
  const w = wallClock(date, timeZone)
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`
}
