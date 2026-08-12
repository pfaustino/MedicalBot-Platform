'use client'

import { useEffect, useMemo, useState } from 'react'
import { AppGate } from '../components/AppGate'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { Loaded } from '../components/Loader'
import { apiPatch, apiPost } from '@/lib/api'
import { formatDate, formatDateTime, titleCase, APPT_TYPE_LABELS } from '@/lib/format'

type Kind = 'appointment' | 'todo' | 'google' | 'all'

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

function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayHeading(iso: string): string {
  return formatDate(iso)
}

function ItemCard({
  item,
  past,
  onChanged,
}: {
  item: CalendarItem
  past: boolean
  onChanged: () => void
}) {
  const toast = useToast()
  const [editingNotes, setEditingNotes] = useState(false)
  const [notes, setNotes] = useState(item.notes ?? '')
  const [busy, setBusy] = useState(false)

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
    } catch {
      toast.show('Could not update To Do.', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="chip-row" style={{ marginBottom: '0.35rem' }}>
            <span className={`pill kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
            {item.synced && <span className="pill">Synced</span>}
            {item.type && <span className="pill">{APPT_TYPE_LABELS[item.type] ?? titleCase(item.type)}</span>}
            {item.status && item.status !== 'open' && (
              <span className="pill">{titleCase(item.status)}</span>
            )}
          </div>
          <h3 style={{ margin: 0 }}>{item.title}</h3>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            {item.allDay ? dayHeading(item.startsAt) : formatDateTime(item.startsAt)}
            {item.location ? ` · ${item.location}` : ''}
          </p>
        </div>
      </div>

      {item.notes && item.kind !== 'appointment' && <p className="hint">{item.notes}</p>}

      {item.kind === 'google' && item.htmlLink && (
        <p>
          <a href={item.htmlLink} target="_blank" rel="noreferrer">
            Open in Google Calendar
          </a>
        </p>
      )}

      {item.kind === 'todo' && item.status === 'open' && (
        <div className="btn-row">
          <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => void markTodoDone()}>
            Mark done
          </button>
          <a className="btn-ghost btn-sm" href="/todos">
            Open To Dos
          </a>
        </div>
      )}

      {item.kind === 'appointment' && past && (
        <div style={{ marginTop: '0.75rem' }}>
          {editingNotes ? (
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
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => {
                    setNotes(item.notes ?? '')
                    setEditingNotes(false)
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : item.notes ? (
            <div className="callout">
              <div className="row-between">
                <strong>Visit notes</strong>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setEditingNotes(true)}>
                  Edit
                </button>
              </div>
              <p>{item.notes}</p>
            </div>
          ) : (
            <button type="button" className="btn-ghost btn-sm" onClick={() => setEditingNotes(true)}>
              Add visit notes
            </button>
          )}
        </div>
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
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Endocrinology follow-up"
            autoFocus
          />
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

function Agenda({
  items,
  past,
  filter,
  onChanged,
}: {
  items: CalendarItem[]
  past: boolean
  filter: Kind
  onChanged: () => void
}) {
  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.kind === filter)),
    [items, filter],
  )

  const groups = useMemo(() => {
    const map = new Map<string, CalendarItem[]>()
    for (const item of filtered) {
      const key = dayKey(item.startsAt)
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [filtered])

  if (filtered.length === 0) {
    return <p className="hint">{past ? 'Nothing in the recent past.' : 'Nothing upcoming in this view.'}</p>
  }

  return (
    <div className="stack">
      {groups.map(([key, dayItems]) => (
        <section key={key}>
          <h3 className="calendar-day">{dayHeading(dayItems[0]!.startsAt)}</h3>
          <div className="stack">
            {dayItems.map((item) => (
              <ItemCard key={`${item.kind}-${item.id}`} item={item} past={past} onChanged={onChanged} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export default function CalendarPage() {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [filter, setFilter] = useState<Kind>('all')
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
      <main>
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
          {(d) => (
            <>
              <div className="card calendar-google-card">
                <div className="row-between">
                  <div>
                    <strong>Google Calendar</strong>
                    <p className="hint" style={{ margin: '0.25rem 0 0' }}>
                      {d.google.connected
                        ? 'Connected — events from your primary calendar appear below. New appointments sync out automatically.'
                        : 'Connect to see Google events here and sync new appointments to your phone calendar.'}
                    </p>
                    {d.google.error && <p className="field-error">{d.google.error}</p>}
                  </div>
                  {d.google.connected ? (
                    <span className="pill">Connected</span>
                  ) : (
                    <a className="btn-secondary" href="/auth/google/connect/calendar">
                      Connect Google Calendar
                    </a>
                  )}
                </div>
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

              <section>
                <h2>Upcoming</h2>
                <Agenda items={d.upcoming} past={false} filter={filter} onChanged={refetch} />
              </section>

              <section>
                <h2>Recent</h2>
                <Agenda items={d.past} past filter={filter} onChanged={refetch} />
              </section>
            </>
          )}
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
