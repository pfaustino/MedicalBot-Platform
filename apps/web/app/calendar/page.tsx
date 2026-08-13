'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AppGate } from '../components/AppGate'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { Loaded } from '../components/Loader'
import { apiDelete, apiPatch, apiPost } from '@/lib/api'
import { titleCase, APPT_TYPE_LABELS } from '@/lib/format'

type KindFilter = 'appointment' | 'todo' | 'google' | 'reminder' | 'all'
type ViewMode = 'day' | 'week' | 'month'

interface CalendarItem {
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

interface CalendarPayload {
  google: { connected: boolean; error: string | null }
  upcoming: CalendarItem[]
  past: CalendarItem[]
}

const KIND_LABEL: Record<CalendarItem['kind'], string> = {
  appointment: 'Appointment',
  todo: 'To Do',
  google: 'Google',
  reminder: 'Reminder',
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = Array.from({ length: 24 }, (_, i) => i)

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

function startOfWeek(d: Date): Date {
  const s = startOfDay(d)
  return addDays(s, -s.getDay())
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function itemDayKey(item: CalendarItem): string {
  const d = new Date(item.startsAt)
  return dayKey(d)
}

function itemHour(item: CalendarItem): number {
  if (item.allDay) return 0
  return new Date(item.startsAt).getHours()
}

function formatHour(h: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hr = h % 12 || 12
  return `${hr} ${ampm}`
}

function monthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function rangeLabel(view: ViewMode, cursor: Date): string {
  if (view === 'month') return monthLabel(cursor)
  if (view === 'day') {
    return cursor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  }
  const start = startOfWeek(cursor)
  const end = addDays(start, 6)
  const sameMonth = start.getMonth() === end.getMonth()
  if (sameMonth) {
    return `${start.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} – ${end.getDate()}, ${end.getFullYear()}`
  }
  return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
}

function ReminderDetail({
  item,
  onChanged,
  onClose,
}: {
  item: CalendarItem
  onChanged: () => void
  onClose: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const when = new Date(item.startsAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  const isGlucose = item.type === 'glucose'

  async function cancelFollowUp() {
    if (!item.googleEventId) return
    if (!window.confirm('Cancel this glucose re-check on Google Calendar?')) return
    setBusy(true)
    try {
      await apiDelete(`/api/calendar/google/${encodeURIComponent(item.googleEventId)}`)
      toast.show('Follow-up cancelled.', 'ok')
      onChanged()
      onClose()
    } catch {
      toast.show('Could not cancel that reminder.', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="chip-row" style={{ marginBottom: '0.75rem' }}>
        <span className={`pill kind-${item.kind}`}>{isGlucose ? 'Glucose' : 'Dose'}</span>
        {item.synced && <span className="pill">Phone alarm</span>}
      </div>
      <p>
        <strong>{item.title}</strong>
      </p>
      <p className="hint">{when}</p>
      {item.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{item.notes}</p>}
      {isGlucose ? (
        <>
          <p className="hint">
            This lands on your Google Calendar two hours after a post-meal reading so your phone
            can nudge you to re-check.
          </p>
          {item.googleEventId && (
            <div className="form-actions">
              <button type="button" className="btn-danger" disabled={busy} onClick={() => void cancelFollowUp()}>
                {busy ? 'Cancelling…' : 'Cancel follow-up'}
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="hint">
          Log this dose on{' '}
          <Link href="/medications">Medications</Link>
          {item.synced
            ? '. A popup at this time is on your Google Calendar so your phone can alarm.'
            : '. Connect Google Calendar to put a phone alarm on this time.'}
        </p>
      )}
      {item.htmlLink && (
        <p className="hint" style={{ marginTop: '0.75rem' }}>
          <a href={item.htmlLink} target="_blank" rel="noreferrer">
            Open in Google Calendar
          </a>
        </p>
      )}
    </div>
  )
}

function EventEditor({
  item,
  onChanged,
  onClose,
}: {
  item: CalendarItem
  onChanged: () => void
  onClose: () => void
}) {
  const toast = useToast()
  const start = new Date(item.startsAt)
  const endRaw = item.endsAt ? new Date(item.endsAt) : new Date(start.getTime() + 60 * 60 * 1000)
  // Google/all-day exclusive end → inclusive date for the form
  const endForForm = item.allDay ? addDays(endRaw, -1) : endRaw

  const [title, setTitle] = useState(item.title)
  const [allDay, setAllDay] = useState(item.allDay)
  const [startDate, setStartDate] = useState(toDateLocal(start))
  const [endDate, setEndDate] = useState(toDateLocal(endForForm))
  const [startDateTime, setStartDateTime] = useState(toDatetimeLocal(start))
  const [endDateTime, setEndDateTime] = useState(toDatetimeLocal(endRaw))
  const [location, setLocation] = useState(item.location ?? '')
  const [description, setDescription] = useState(item.notes ?? '')
  const [type, setType] = useState(item.type ?? 'office_visit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (item.kind === 'reminder') {
    return <ReminderDetail item={item} onChanged={onChanged} onClose={onClose} />
  }

  function resolveTimes(): { startsAt: Date; endsAt: Date } | null {
    if (allDay) {
      if (!startDate || !endDate) {
        setError('Start and end dates are required.')
        return null
      }
      const startsAt = parseDateLocal(startDate)
      const endsAt = addDays(parseDateLocal(endDate), 1)
      if (+endsAt <= +startsAt) {
        setError('End date cannot be before the start date.')
        return null
      }
      return { startsAt, endsAt }
    }
    if (!startDateTime) {
      setError('A start date and time is required.')
      return null
    }
    const startsAt = new Date(startDateTime)
    const endsAt = endDateTime ? new Date(endDateTime) : new Date(startsAt.getTime() + 60 * 60 * 1000)
    if (+endsAt < +startsAt) {
      setError('End time cannot be before the start time.')
      return null
    }
    return { startsAt, endsAt }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!title.trim()) {
      setError('A title is required.')
      return
    }
    const times = resolveTimes()
    if (!times) return

    setBusy(true)
    try {
      if (item.kind === 'appointment') {
        await apiPatch(`/api/appointments/${item.id}`, {
          title: title.trim(),
          type,
          startsAt: times.startsAt.toISOString(),
          endsAt: times.endsAt.toISOString(),
          location: location.trim() || null,
          prepNotes: description.trim() || null,
          allDay,
        })
      } else if (item.kind === 'todo') {
        await apiPatch(`/api/todos/${item.id}`, {
          title: title.trim(),
          notes: description.trim() || null,
          dueAt: times.startsAt.toISOString(),
        })
      } else {
        await apiPatch(`/api/calendar/google/${encodeURIComponent(item.id)}`, {
          title: title.trim(),
          startsAt: times.startsAt.toISOString(),
          endsAt: times.endsAt.toISOString(),
          location: location.trim() || null,
          description: description.trim() || null,
          allDay,
        })
      }
      toast.show('Event updated.', 'ok')
      onChanged()
      onClose()
    } catch {
      setError('Could not save changes.')
    } finally {
      setBusy(false)
    }
  }

  async function markDone() {
    if (item.kind !== 'todo') return
    setBusy(true)
    try {
      await apiPatch(`/api/todos/${item.id}`, { status: 'done' })
      toast.show('Marked done.', 'ok')
      onChanged()
      onClose()
    } catch {
      toast.show('Could not mark done.', 'err')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm('Delete this event? This cannot be undone.')) return
    setBusy(true)
    try {
      if (item.kind === 'appointment') {
        await apiDelete(`/api/appointments/${item.id}`)
      } else if (item.kind === 'todo') {
        await apiDelete(`/api/todos/${item.id}`)
      } else {
        await apiDelete(`/api/calendar/google/${encodeURIComponent(item.id)}`)
      }
      toast.show('Event deleted.', 'ok')
      onChanged()
      onClose()
    } catch {
      toast.show('Could not delete event.', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} className="gcal-form">
      <div className="chip-row" style={{ marginBottom: '0.75rem' }}>
        <span className={`pill kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
        {item.synced && <span className="pill">Synced</span>}
        {item.status && item.status !== 'open' && <span className="pill">{titleCase(item.status)}</span>}
      </div>

      <label className="field">
        <span>Title</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>

      {item.kind !== 'todo' && (
        <label className="field field-inline">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          <span>All day</span>
        </label>
      )}

      {item.kind === 'todo' ? (
        <label className="field">
          <span>Due date</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
      ) : allDay ? (
        <div className="form-grid">
          <label className="field">
            <span>Start date</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className="field">
            <span>End date</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
        </div>
      ) : (
        <div className="form-grid">
          <label className="field">
            <span>Start</span>
            <input type="datetime-local" value={startDateTime} onChange={(e) => setStartDateTime(e.target.value)} />
          </label>
          <label className="field">
            <span>End</span>
            <input type="datetime-local" value={endDateTime} onChange={(e) => setEndDateTime(e.target.value)} />
          </label>
        </div>
      )}

      {item.kind !== 'todo' && (
        <label className="field">
          <span>Location</span>
          <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Add location" />
        </label>
      )}

      <label className="field">
        <span>Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add description"
          rows={3}
        />
      </label>

      {item.kind === 'appointment' && (
        <label className="field">
          <span>Event type (MedicalBot)</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(APPT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && <p className="field-error">{error}</p>}

      <div className="form-actions" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {item.kind === 'todo' && item.status === 'open' && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void markDone()}>
            Mark done
          </button>
        )}
        <button type="button" className="btn-danger" disabled={busy} onClick={() => void remove()}>
          Delete
        </button>
      </div>

      {item.kind === 'google' && item.htmlLink && (
        <p className="hint" style={{ marginTop: '0.75rem' }}>
          <a href={item.htmlLink} target="_blank" rel="noreferrer">
            Open in Google Calendar
          </a>
        </p>
      )}
    </form>
  )
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Value for <input type="datetime-local"> in local time. */
function toDatetimeLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Value for <input type="date"> in local time. */
function toDateLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function parseDateLocal(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1)
}

export type EventDraft = {
  allDay: boolean
  start: Date
  end: Date
}

function defaultTimedDraft(at: Date = new Date()): EventDraft {
  const start = new Date(at)
  start.setMinutes(0, 0, 0)
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  return { allDay: false, start, end }
}

function defaultAllDayDraft(day: Date): EventDraft {
  const start = startOfDay(day)
  const end = addDays(start, 1)
  return { allDay: true, start, end }
}

function AppointmentForm({
  draft,
  onDone,
}: {
  draft: EventDraft
  onDone: (synced: boolean) => void
}) {
  const [title, setTitle] = useState('')
  const [allDay, setAllDay] = useState(draft.allDay)
  const [startDate, setStartDate] = useState(toDateLocal(draft.start))
  const [endDate, setEndDate] = useState(toDateLocal(addDays(draft.end, draft.allDay ? -1 : 0)))
  const [startDateTime, setStartDateTime] = useState(toDatetimeLocal(draft.start))
  const [endDateTime, setEndDateTime] = useState(toDatetimeLocal(draft.end))
  const [location, setLocation] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState('office_visit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setAllDay(draft.allDay)
    setStartDate(toDateLocal(draft.start))
    setEndDate(toDateLocal(draft.allDay ? addDays(draft.end, -1) : draft.end))
    setStartDateTime(toDatetimeLocal(draft.start))
    setEndDateTime(toDatetimeLocal(draft.end))
  }, [draft])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!title.trim()) {
      setError('A title is required.')
      return
    }

    let startsAt: Date
    let endsAt: Date
    if (allDay) {
      if (!startDate || !endDate) {
        setError('Start and end dates are required.')
        return
      }
      startsAt = parseDateLocal(startDate)
      // Store exclusive end (next calendar day after inclusive UI end), matching Google.
      endsAt = addDays(parseDateLocal(endDate), 1)
      if (+endsAt <= +startsAt) {
        setError('End date cannot be before the start date.')
        return
      }
    } else {
      if (!startDateTime) {
        setError('A start date and time is required.')
        return
      }
      startsAt = new Date(startDateTime)
      endsAt = endDateTime ? new Date(endDateTime) : new Date(startsAt.getTime() + 60 * 60 * 1000)
      if (+endsAt < +startsAt) {
        setError('End time cannot be before the start time.')
        return
      }
    }

    const body: Record<string, unknown> = {
      title: title.trim(),
      type,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      allDay,
    }
    if (location.trim()) body.location = location.trim()
    if (description.trim()) body.prepNotes = description.trim()

    setBusy(true)
    try {
      const res = await apiPost<{ id: string; synced?: boolean }>('/api/appointments', body)
      onDone(Boolean(res.synced))
    } catch {
      setError('Could not save that event. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="gcal-form">
      <label className="field">
        <span>Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add title"
          autoFocus
        />
      </label>

      <label className="field field-inline">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        <span>All day</span>
      </label>

      {allDay ? (
        <div className="form-grid">
          <label className="field">
            <span>Start date</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className="field">
            <span>End date</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
        </div>
      ) : (
        <div className="form-grid">
          <label className="field">
            <span>Start</span>
            <input
              type="datetime-local"
              value={startDateTime}
              onChange={(e) => setStartDateTime(e.target.value)}
            />
          </label>
          <label className="field">
            <span>End</span>
            <input
              type="datetime-local"
              value={endDateTime}
              onChange={(e) => setEndDateTime(e.target.value)}
            />
          </label>
        </div>
      )}

      <label className="field">
        <span>Location</span>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Add location"
        />
      </label>

      <label className="field">
        <span>Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add description"
          rows={3}
        />
      </label>

      <label className="field">
        <span>Event type (MedicalBot)</span>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(APPT_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="field-error">{error}</p>}

      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function EventChip({ item, onSelect }: { item: CalendarItem; onSelect: (item: CalendarItem) => void }) {
  const time = item.allDay
    ? 'All day'
    : new Date(item.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return (
    <button
      type="button"
      className={`cal-event kind-${item.kind}`}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(item)
      }}
      title={`${item.title} · ${time}`}
    >
      <span className="cal-event-time">{time}</span>
      <span className="cal-event-title">{item.title}</span>
    </button>
  )
}

function MonthView({
  cursor,
  byDay,
  onSelectDay,
  onSelectItem,
  onCreate,
}: {
  cursor: Date
  byDay: Map<string, CalendarItem[]>
  onSelectDay: (d: Date) => void
  onSelectItem: (item: CalendarItem) => void
  onCreate: (draft: EventDraft) => void
}) {
  const today = startOfDay(new Date())
  const first = startOfMonth(cursor)
  const gridStart = startOfWeek(first)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))

  return (
    <div className="cal-month">
      <div className="cal-month-head">
        {WEEKDAYS.map((d) => (
          <div key={d} className="cal-month-dow">
            {d}
          </div>
        ))}
      </div>
      <div className="cal-month-grid">
        {cells.map((day) => {
          const key = dayKey(day)
          const items = byDay.get(key) ?? []
          const inMonth = day.getMonth() === cursor.getMonth()
          const isToday = sameDay(day, today)
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              className={`cal-month-cell ${inMonth ? '' : 'outside'} ${isToday ? 'today' : ''}`}
              onClick={() => onCreate(defaultAllDayDraft(day))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onCreate(defaultAllDayDraft(day))
                }
              }}
            >
              <button
                type="button"
                className="cal-month-date"
                onClick={(e) => {
                  e.stopPropagation()
                  onSelectDay(day)
                }}
              >
                {day.getDate()}
              </button>
              <div className="cal-month-events">
                {items.slice(0, 3).map((item) => (
                  <EventChip key={`${item.kind}-${item.id}`} item={item} onSelect={onSelectItem} />
                ))}
                {items.length > 3 && (
                  <button
                    type="button"
                    className="cal-more"
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectDay(day)
                    }}
                  >
                    +{items.length - 3} more
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WeekView({
  cursor,
  byDay,
  onSelectItem,
  onCreate,
}: {
  cursor: Date
  byDay: Map<string, CalendarItem[]>
  onSelectItem: (item: CalendarItem) => void
  onCreate: (draft: EventDraft) => void
}) {
  const today = startOfDay(new Date())
  const weekStart = startOfWeek(cursor)
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  return (
    <div className="cal-week">
      <div className="cal-week-head">
        <div className="cal-gutter" />
        {days.map((day) => (
          <div key={dayKey(day)} className={`cal-week-dayhead ${sameDay(day, today) ? 'today' : ''}`}>
            <div className="cal-week-dow">{WEEKDAYS[day.getDay()]}</div>
            <div className="cal-week-dom">{day.getDate()}</div>
          </div>
        ))}
      </div>
      <div className="cal-week-allday">
        <div className="cal-gutter muted">All day</div>
        {days.map((day) => {
          const items = (byDay.get(dayKey(day)) ?? []).filter((i) => i.allDay)
          return (
            <div
              key={dayKey(day)}
              className="cal-week-allday-cell cal-slot"
              onClick={() => onCreate(defaultAllDayDraft(day))}
            >
              {items.map((item) => (
                <EventChip key={`${item.kind}-${item.id}`} item={item} onSelect={onSelectItem} />
              ))}
            </div>
          )
        })}
      </div>
      <div className="cal-week-body">
        {HOURS.map((hour) => (
          <div key={hour} className="cal-week-row">
            <div className="cal-gutter muted">{formatHour(hour)}</div>
            {days.map((day) => {
              const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour)
              const items = (byDay.get(dayKey(day)) ?? []).filter((i) => !i.allDay && itemHour(i) === hour)
              return (
                <div
                  key={dayKey(day)}
                  className="cal-week-cell cal-slot"
                  onClick={() => onCreate(defaultTimedDraft(slot))}
                >
                  {items.map((item) => (
                    <EventChip key={`${item.kind}-${item.id}`} item={item} onSelect={onSelectItem} />
                  ))}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function DayView({
  cursor,
  byDay,
  onSelectItem,
  onCreate,
}: {
  cursor: Date
  byDay: Map<string, CalendarItem[]>
  onSelectItem: (item: CalendarItem) => void
  onCreate: (draft: EventDraft) => void
}) {
  const items = byDay.get(dayKey(cursor)) ?? []
  const allDay = items.filter((i) => i.allDay)
  const timed = items.filter((i) => !i.allDay)

  return (
    <div className="cal-day">
      <div
        className="cal-day-allday cal-slot"
        onClick={() => onCreate(defaultAllDayDraft(cursor))}
      >
        <div className="cal-gutter muted">All day</div>
        <div className="cal-day-allday-list">
          {allDay.map((item) => (
            <EventChip key={`${item.kind}-${item.id}`} item={item} onSelect={onSelectItem} />
          ))}
        </div>
      </div>
      <div className="cal-day-body">
        {HOURS.map((hour) => {
          const hourItems = timed.filter((i) => itemHour(i) === hour)
          const slot = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), hour)
          return (
            <div key={hour} className="cal-day-row">
              <div className="cal-gutter muted">{formatHour(hour)}</div>
              <div className="cal-day-cell cal-slot" onClick={() => onCreate(defaultTimedDraft(slot))}>
                {hourItems.map((item) => (
                  <EventChip key={`${item.kind}-${item.id}`} item={item} onSelect={onSelectItem} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {items.length === 0 && <p className="hint cal-empty">Nothing scheduled — click a time slot to add.</p>}
    </div>
  )
}

function CalendarBoard({
  items,
  filter,
  onChanged,
  onCreate,
}: {
  items: CalendarItem[]
  filter: KindFilter
  onChanged: () => void
  onCreate: (draft: EventDraft) => void
}) {
  const [view, setView] = useState<ViewMode>('month')
  const [cursor, setCursor] = useState(() => startOfDay(new Date()))
  const [selected, setSelected] = useState<CalendarItem | null>(null)

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.kind === filter)),
    [items, filter],
  )

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>()
    for (const item of filtered) {
      const key = itemDayKey(item)
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))
    }
    return map
  }, [filtered])

  function shift(delta: number) {
    setCursor((c) => {
      if (view === 'month') return new Date(c.getFullYear(), c.getMonth() + delta, 1)
      if (view === 'week') return addDays(c, delta * 7)
      return addDays(c, delta)
    })
  }

  return (
    <div className="cal-board">
      <div className="cal-toolbar">
        <div className="btn-row">
          <button type="button" className="btn-ghost btn-sm" onClick={() => shift(-1)} aria-label="Previous">
            ‹
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setCursor(startOfDay(new Date()))}>
            Today
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => shift(1)} aria-label="Next">
            ›
          </button>
        </div>
        <h2 className="cal-range-label">{rangeLabel(view, cursor)}</h2>
        <div className="btn-row calendar-filters">
          {(
            [
              ['day', 'Day'],
              ['week', 'Week'],
              ['month', 'Month'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={view === value ? 'chip active' : 'chip'}
              onClick={() => setView(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'month' && (
        <MonthView
          cursor={cursor}
          byDay={byDay}
          onSelectDay={(d) => {
            setCursor(d)
            setView('day')
          }}
          onSelectItem={setSelected}
          onCreate={onCreate}
        />
      )}
      {view === 'week' && (
        <WeekView cursor={cursor} byDay={byDay} onSelectItem={setSelected} onCreate={onCreate} />
      )}
      {view === 'day' && (
        <DayView cursor={cursor} byDay={byDay} onSelectItem={setSelected} onCreate={onCreate} />
      )}

      {filtered.length === 0 && (
        <p className="hint" style={{ marginTop: '1rem' }}>
          {filter === 'reminder' ? (
            <>
              No dose times in this range. Imported meds often have no clock time — add times like
              08:00, 20:00 on <Link href="/medications">Medications</Link>, or put a frequency such as
              “twice daily” in the instructions, then use Sync dose reminders.
            </>
          ) : (
            'Nothing in this view for the dates on screen.'
          )}
        </p>
      )}

      <Modal open={Boolean(selected)} title={selected?.title ?? 'Event'} onClose={() => setSelected(null)}>
        {selected && (
          <EventEditor item={selected} onChanged={onChanged} onClose={() => setSelected(null)} />
        )}
      </Modal>
    </div>
  )
}

export default function CalendarPage() {
  const toast = useToast()
  const [draft, setDraft] = useState<EventDraft | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [filter, setFilter] = useState<KindFilter>('all')
  const [syncing, setSyncing] = useState(false)
  const refetch = () => setReloadKey((k) => k + 1)

  async function syncReminders() {
    setSyncing(true)
    try {
      const r = await apiPost<{ synced: number }>('/api/calendar/reminders/sync')
      toast.show(
        r.synced
          ? `Phone alarms set for ${r.synced} medication${r.synced === 1 ? '' : 's'}.`
          : 'No fixed dose times to sync.',
        'ok',
      )
      refetch()
    } catch {
      toast.show('Could not sync dose reminders to Google Calendar.', 'err')
    } finally {
      setSyncing(false)
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const google = params.get('google')
    if (!google) return
    if (google === 'connected') toast.show('Google Calendar connected.', 'ok')
    if (google === 'denied') toast.show('Google Calendar access was not granted.', 'err')
    if (google === 'unconfigured') toast.show('Google OAuth is not configured on this server.', 'err')
    window.history.replaceState({}, '', '/calendar')
  }, [toast])

  return (
    <AppGate>
      <main className="calendar-page">
        <div className="page-header">
          <div>
            <h1>Calendar</h1>
            <p className="muted">Appointments, dose times, and Google Calendar in one place.</p>
          </div>
          <div className="page-actions">
            <button type="button" className="btn-primary" onClick={() => setDraft(defaultTimedDraft())}>
              + Add event
            </button>
          </div>
        </div>

        <Loaded<CalendarPayload> key={reloadKey} path="/api/calendar">
          {(d) => {
            const allItems = [...d.upcoming, ...d.past]
            return (
              <>
                <div className="calendar-google-bar">
                  <div>
                    <strong>Google Calendar</strong>
                    <span className="muted">
                      {d.google.connected
                        ? ' — connected. Appointments and dose times sync; your phone alarms from Calendar popups.'
                        : ' — connect so dose times and appointments can alarm on your phone.'}
                    </span>
                    {d.google.error && (
                      <p className="field-error" style={{ margin: '0.35rem 0 0' }}>
                        {d.google.error}{' '}
                        <a href="/auth/google/connect/calendar">Reconnect</a>
                      </p>
                    )}
                  </div>
                  {d.google.connected ? (
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        disabled={syncing}
                        onClick={() => void syncReminders()}
                      >
                        {syncing ? 'Syncing…' : 'Sync dose reminders'}
                      </button>
                      <a className="btn-ghost btn-sm" href="/auth/google/connect/calendar">
                        Reconnect
                      </a>
                    </div>
                  ) : (
                    <a className="btn-secondary btn-sm" href="/auth/google/connect/calendar">
                      Connect
                    </a>
                  )}
                </div>

                <div className="btn-row calendar-filters">
                  {(
                    [
                      ['all', 'All'],
                      ['appointment', 'Appointments'],
                      ['reminder', 'Reminders'],
                      ['todo', 'To Dos'],
                      ['google', 'Google'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={filter === value ? 'chip active' : 'chip'}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <CalendarBoard
                  items={allItems}
                  filter={filter}
                  onChanged={refetch}
                  onCreate={setDraft}
                />
              </>
            )
          }}
        </Loaded>

        <Modal open={Boolean(draft)} title="Add event" onClose={() => setDraft(null)} wide>
          {draft && (
            <AppointmentForm
              key={`${draft.allDay}-${draft.start.toISOString()}-${draft.end.toISOString()}`}
              draft={draft}
              onDone={(synced) => {
                setDraft(null)
                refetch()
                toast.show(synced ? 'Event saved and synced to Google.' : 'Event saved.', 'ok')
              }}
            />
          )}
        </Modal>
      </main>
    </AppGate>
  )
}
