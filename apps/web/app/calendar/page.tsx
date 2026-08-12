'use client'

import { useEffect, useMemo, useState } from 'react'
import { AppGate } from '../components/AppGate'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { Loaded } from '../components/Loader'
import { apiPatch, apiPost } from '@/lib/api'
import { formatDate, formatDateTime, titleCase, APPT_TYPE_LABELS } from '@/lib/format'

type KindFilter = 'appointment' | 'todo' | 'google' | 'all'
type ViewMode = 'day' | 'week' | 'month'

interface CalendarItem {
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

interface CalendarPayload {
  google: { connected: boolean; error: string | null }
  upcoming: CalendarItem[]
  past: CalendarItem[]
}

const KIND_LABEL: Record<CalendarItem['kind'], string> = {
  appointment: 'Appointment',
  todo: 'To Do',
  google: 'Google',
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

function EventDetail({ item, onChanged, onClose }: { item: CalendarItem; onChanged: () => void; onClose: () => void }) {
  const toast = useToast()
  const [editingNotes, setEditingNotes] = useState(false)
  const [notes, setNotes] = useState(item.notes ?? '')
  const [busy, setBusy] = useState(false)
  const past = new Date(item.startsAt) < new Date()

  async function saveVisitNotes() {
    if (item.kind !== 'appointment') return
    setBusy(true)
    try {
      await apiPatch(`/api/appointments/${item.id}`, { visitNotes: notes })
      toast.show('Visit notes saved.', 'ok')
      setEditingNotes(false)
      onChanged()
    } catch {
      toast.show('Could not save visit notes.', 'err')
    } finally {
      setBusy(false)
    }
  }

  async function markTodoDone() {
    if (item.kind !== 'todo') return
    setBusy(true)
    try {
      await apiPatch(`/api/todos/${item.id}`, { status: 'done' })
      toast.show('To Do marked done.', 'ok')
      onChanged()
      onClose()
    } catch {
      toast.show('Could not update To Do.', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="chip-row">
        <span className={`pill kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
        {item.synced && <span className="pill">Synced</span>}
        {item.type && <span className="pill">{APPT_TYPE_LABELS[item.type] ?? titleCase(item.type)}</span>}
        {item.status && item.status !== 'open' && <span className="pill">{titleCase(item.status)}</span>}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {item.allDay ? formatDate(item.startsAt) : formatDateTime(item.startsAt)}
        {item.location ? ` · ${item.location}` : ''}
      </p>
      {item.notes && <p>{item.notes}</p>}
      {item.kind === 'google' && item.htmlLink && (
        <p>
          <a href={item.htmlLink} target="_blank" rel="noreferrer">
            Open in Google Calendar
          </a>
        </p>
      )}
      {item.kind === 'todo' && item.status === 'open' && (
        <div className="btn-row">
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void markTodoDone()}>
            Mark done
          </button>
          <a className="btn-ghost btn-sm" href="/todos">
            Open To Dos
          </a>
        </div>
      )}
      {item.kind === 'appointment' && past && (
        editingNotes ? (
          <div className="stack">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What came out of this visit — findings, changes, follow-ups."
              rows={4}
              autoFocus
            />
            <div className="btn-row">
              <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void saveVisitNotes()}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => setEditingNotes(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setEditingNotes(true)}>
            {item.notes ? 'Edit visit notes' : 'Add visit notes'}
          </button>
        )
      )}
    </div>
  )
}

function AppointmentForm({ onDone }: { onDone: (synced: boolean) => void }) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState('office_visit')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [location, setLocation] = useState('')
  const [prepNotes, setPrepNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!title.trim()) {
      setError('A title is required.')
      return
    }
    if (!startsAt) {
      setError('A start date and time is required.')
      return
    }
    if (endsAt && new Date(endsAt) < new Date(startsAt)) {
      setError('The end time cannot be before the start time.')
      return
    }

    const body: Record<string, unknown> = {
      title: title.trim(),
      type,
      startsAt: new Date(startsAt).toISOString(),
    }
    if (endsAt) body.endsAt = new Date(endsAt).toISOString()
    if (location.trim()) body.location = location.trim()
    if (prepNotes.trim()) body.prepNotes = prepNotes.trim()

    setBusy(true)
    try {
      const res = await apiPost<{ id: string; synced?: boolean }>('/api/appointments', body)
      onDone(Boolean(res.synced))
    } catch {
      setError('Could not save that appointment. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className="form-grid">
        <label className="field">
          <span>Title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Endocrinology follow-up" autoFocus />
        </label>
        <label className="field">
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(APPT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Starts</span>
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </label>
        <label className="field">
          <span>Ends (optional)</span>
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
        <label className="field">
          <span>Location (optional)</span>
          <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Prep notes (optional)</span>
        <textarea
          value={prepNotes}
          onChange={(e) => setPrepNotes(e.target.value)}
          placeholder="Questions to ask, things to bring, what to fast for."
          rows={3}
        />
      </label>
      {error && <p className="field-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Add appointment'}
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
      onClick={() => onSelect(item)}
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
}: {
  cursor: Date
  byDay: Map<string, CalendarItem[]>
  onSelectDay: (d: Date) => void
  onSelectItem: (item: CalendarItem) => void
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
              className={`cal-month-cell ${inMonth ? '' : 'outside'} ${isToday ? 'today' : ''}`}
            >
              <button type="button" className="cal-month-date" onClick={() => onSelectDay(day)}>
                {day.getDate()}
              </button>
              <div className="cal-month-events">
                {items.slice(0, 3).map((item) => (
                  <EventChip key={`${item.kind}-${item.id}`} item={item} onSelect={onSelectItem} />
                ))}
                {items.length > 3 && (
                  <button type="button" className="cal-more" onClick={() => onSelectDay(day)}>
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
}: {
  cursor: Date
  byDay: Map<string, CalendarItem[]>
  onSelectItem: (item: CalendarItem) => void
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
            <div key={dayKey(day)} className="cal-week-allday-cell">
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
              const items = (byDay.get(dayKey(day)) ?? []).filter((i) => !i.allDay && itemHour(i) === hour)
              return (
                <div key={dayKey(day)} className="cal-week-cell">
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
}: {
  cursor: Date
  byDay: Map<string, CalendarItem[]>
  onSelectItem: (item: CalendarItem) => void
}) {
  const items = byDay.get(dayKey(cursor)) ?? []
  const allDay = items.filter((i) => i.allDay)
  const timed = items.filter((i) => !i.allDay)

  return (
    <div className="cal-day">
      {allDay.length > 0 && (
        <div className="cal-day-allday">
          <div className="cal-gutter muted">All day</div>
          <div className="cal-day-allday-list">
            {allDay.map((item) => (
              <EventChip key={`${item.kind}-${item.id}`} item={item} onSelect={onSelectItem} />
            ))}
          </div>
        </div>
      )}
      <div className="cal-day-body">
        {HOURS.map((hour) => {
          const hourItems = timed.filter((i) => itemHour(i) === hour)
          return (
            <div key={hour} className="cal-day-row">
              <div className="cal-gutter muted">{formatHour(hour)}</div>
              <div className="cal-day-cell">
                {hourItems.map((item) => (
                  <EventChip key={`${item.kind}-${item.id}`} item={item} onSelect={onSelectItem} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {items.length === 0 && <p className="hint cal-empty">Nothing scheduled for this day.</p>}
    </div>
  )
}

function CalendarBoard({
  items,
  filter,
  onChanged,
}: {
  items: CalendarItem[]
  filter: KindFilter
  onChanged: () => void
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
        />
      )}
      {view === 'week' && <WeekView cursor={cursor} byDay={byDay} onSelectItem={setSelected} />}
      {view === 'day' && <DayView cursor={cursor} byDay={byDay} onSelectItem={setSelected} />}

      <Modal
        open={Boolean(selected)}
        title={selected?.title ?? 'Event'}
        onClose={() => setSelected(null)}
      >
        {selected && (
          <EventDetail
            item={selected}
            onChanged={onChanged}
            onClose={() => setSelected(null)}
          />
        )}
      </Modal>
    </div>
  )
}

export default function CalendarPage() {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [filter, setFilter] = useState<KindFilter>('all')
  const refetch = () => setReloadKey((k) => k + 1)

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
            <p className="muted">Appointments, dated To Dos, and Google Calendar in one place.</p>
          </div>
          <div className="page-actions">
            <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
              + Add appointment
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
                        ? ' — connected; new appointments sync automatically.'
                        : ' — connect to show Google events and sync new appointments.'}
                    </span>
                    {d.google.error && <span className="field-error"> {d.google.error}</span>}
                  </div>
                  {d.google.connected ? (
                    <span className="pill">Connected</span>
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

                <CalendarBoard items={allItems} filter={filter} onChanged={refetch} />
              </>
            )
          }}
        </Loaded>

        <Modal open={open} title="Add appointment" onClose={() => setOpen(false)} wide>
          <AppointmentForm
            onDone={(synced) => {
              setOpen(false)
              refetch()
              toast.show(synced ? 'Appointment added and synced to Google.' : 'Appointment added.', 'ok')
            }}
          />
        </Modal>
      </main>
    </AppGate>
  )
}
