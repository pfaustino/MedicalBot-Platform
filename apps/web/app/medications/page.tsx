'use client'

import { useMemo, useState } from 'react'
import { AppGate } from '../components/AppGate'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { Loaded } from '../components/Loader'
import { apiPost, apiPatch } from '@/lib/api'
import { formatDate, MED_FORM_LABELS } from '@/lib/format'

interface Schedule {
  kind: string
  times: string[]
  intervalHours?: number | null
  withFood: boolean
  instructions: string | null
}

interface AdherenceEventBrief {
  scheduledFor: string
  status: string
}

interface Medication {
  id: string
  name: string
  dose: string
  form: string
  schedule: Schedule
  purpose: string | null
  prescriber: string | null
  pharmacy: string | null
  startedAt: string | null
  refillsRemaining: number | null
  isActive: boolean
  adherence30d: number
  doseCount30d: number
  missed30d: number
  events30d: AdherenceEventBrief[]
}

function localDateInput(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Canonical noon-local slot so one log per med per calendar day upserts cleanly. */
function scheduledForDay(yyyyMmDd: string): string {
  return new Date(`${yyyyMmDd}T12:00:00`).toISOString()
}

function eventLocalDay(iso: string): string {
  return localDateInput(new Date(iso))
}

function describeSchedule(s: Schedule): string {
  if (s.kind === 'as_needed') return 'As needed'
  if (s.kind === 'interval_hours') return 'On an interval'
  if (s.kind === 'cyclic') return 'Cyclic'
  if (!s.times?.length) return 'No times set'
  const times = s.times.join(', ')
  return `at ${times}${s.withFood ? ' · with food' : ''}`
}

function scheduleTag(s: Schedule): string {
  if (s.kind === 'as_needed') return 'As needed'
  if (s.kind === 'interval_hours') return 'Interval'
  if (s.kind === 'cyclic') return 'Cyclic'
  return 'Daily'
}

function parseTimesRaw(raw: string): string[] | null {
  const parts = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  if (parts.length === 0) return []
  const out: string[] = []
  for (const part of parts) {
    const m = part.match(/^(\d{1,2}):([0-5]\d)$/)
    if (!m) return null
    const hh = Number(m[1])
    if (hh > 23) return null
    out.push(`${String(hh).padStart(2, '0')}:${m[2]}`)
  }
  return out
}

function buildSchedule(input: {
  kind: string
  timesRaw: string
  intervalHours: string
  withFood: boolean
  instructions: string
}): { schedule: Record<string, unknown> } | { error?: string; timesError?: string } {
  const schedule: Record<string, unknown> = { kind: input.kind }
  if (input.kind === 'fixed_times') {
    const times = parseTimesRaw(input.timesRaw)
    if (times === null) {
      return { timesError: 'Use 24-hour HH:MM times separated by commas, e.g. "08:00, 20:00".' }
    }
    if (times.length === 0) {
      return { timesError: 'Enter at least one time, e.g. "08:00, 20:00".' }
    }
    schedule.times = times
  }
  if (input.kind === 'interval_hours') {
    const hours = Number(input.intervalHours)
    if (!input.intervalHours || Number.isNaN(hours) || hours <= 0) {
      return { error: 'Enter a positive number of hours for the interval.' }
    }
    schedule.intervalHours = hours
  }
  schedule.withFood = input.withFood
  schedule.instructions = input.instructions.trim() || null
  return { schedule }
}

const DAY_RANK: Record<string, number> = {
  taken: 4,
  late: 3,
  skipped: 2,
  missed: 1,
}

function dayStatusMap(events: AdherenceEventBrief[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const e of events) {
    const day = eventLocalDay(e.scheduledFor)
    const prev = map.get(day)
    if (!prev || (DAY_RANK[e.status] ?? 0) > (DAY_RANK[prev] ?? 0)) {
      map.set(day, e.status)
    }
  }
  return map
}

function last30Days(endingOn: string): string[] {
  const end = new Date(`${endingOn}T12:00:00`)
  const days: string[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(end)
    d.setDate(end.getDate() - i)
    days.push(localDateInput(d))
  }
  return days
}

function AdherenceChart({ events, endingOn }: { events: AdherenceEventBrief[]; endingOn: string }) {
  const byDay = useMemo(() => dayStatusMap(events), [events])
  const days = useMemo(() => last30Days(endingOn), [endingOn])

  return (
    <div className="adherence-chart" role="img" aria-label="Last 30 days of dose logging">
      <div className="adherence-chart-bars">
        {days.map((day) => {
          const status = byDay.get(day)
          const cls = status ? `day-${status}` : 'day-empty'
          const label = status
            ? `${day}: ${status}`
            : `${day}: no log`
          return <span key={day} className={`adherence-day ${cls}`} title={label} />
        })}
      </div>
      <div className="adherence-chart-legend hint">
        <span>
          <i className="adherence-swatch day-taken" /> Taken / late
        </span>
        <span>
          <i className="adherence-swatch day-skipped" /> Skipped / missed
        </span>
        <span>
          <i className="adherence-swatch day-empty" /> No log
        </span>
        <span>Oldest → newest</span>
      </div>
    </div>
  )
}

function MedCard({
  m,
  logDate,
  selected,
  onSelect,
  onChanged,
}: {
  m: Medication
  logDate: string
  selected: boolean
  onSelect: (id: string, next: boolean) => void
  onChanged: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [editingTimes, setEditingTimes] = useState(false)
  const pct = Math.round(m.adherence30d * 100)
  const tone = pct >= 90 ? 'ok' : pct >= 75 ? 'warn' : 'low'

  async function logDose(status: 'taken' | 'late' | 'skipped') {
    if (busy) return
    setBusy(true)
    try {
      await apiPost(`/api/medications/${m.id}/adherence`, {
        status,
        scheduledFor: scheduledForDay(logDate),
      })
      toast.show(`Logged ${status} for ${logDate}.`, 'ok')
      onChanged()
    } catch {
      toast.show('Could not log that dose.', 'err')
    } finally {
      setBusy(false)
    }
  }

  async function markInactive() {
    if (busy) return
    if (!window.confirm(`Mark ${m.name} inactive? It stays in your history but stops being tracked.`)) return
    setBusy(true)
    try {
      await apiPatch(`/api/medications/${m.id}`, { isActive: false })
      toast.show(`${m.name} marked inactive.`, 'ok')
      onChanged()
    } catch {
      toast.show('Could not update that medication.', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`card med-card${m.isActive ? '' : ' muted'}`}>
      <div className="card-head">
        <div className="med-card-title">
          {m.isActive && (
            <label className="med-select">
              <input
                type="checkbox"
                checked={selected}
                onChange={(e) => onSelect(m.id, e.target.checked)}
                aria-label={`Select ${m.name}`}
              />
            </label>
          )}
          <div>
            <h2 className="med-heading">
              <span className="med-heading-name">
                {m.name} <span className="muted">{m.dose}</span>
              </span>
              <span className="badge med-schedule-tag">{scheduleTag(m.schedule)}</span>
              {!m.isActive && <span className="badge">Inactive</span>}
            </h2>
            <p className="hint">
              {describeSchedule(m.schedule)}
              {m.purpose ? ` · ${m.purpose}` : ''}
              {m.schedule.instructions ? ` · ${m.schedule.instructions}` : ''}
            </p>
          </div>
        </div>
        <div className="stat-right">
          <span className={`big-stat ${tone}`}>{pct}%</span>
          <span className="hint">30-day adherence</span>
        </div>
      </div>

      <div className="meter" aria-hidden>
        <div className={`meter-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>

      <AdherenceChart events={m.events30d ?? []} endingOn={logDate} />

      <dl className="med-meta-row">
        <div>
          <dt>Doses</dt>
          <dd>{m.doseCount30d}</dd>
        </div>
        <div>
          <dt>Missed</dt>
          <dd>{m.missed30d}</dd>
        </div>
        <div>
          <dt>Prescriber</dt>
          <dd>{m.prescriber ?? '—'}</dd>
        </div>
        <div>
          <dt>Refills</dt>
          <dd>
            {m.refillsRemaining ?? '—'}
            {m.refillsRemaining === 0 && <span className="badge badge-warn">Needs refill</span>}
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{m.startedAt ? formatDate(m.startedAt) : '—'}</dd>
        </div>
        <div>
          <dt>Pharmacy</dt>
          <dd>{m.pharmacy ?? '—'}</dd>
        </div>
      </dl>

      {m.isActive && (
        <>
          <div className="btn-row">
            <span className="hint">Log for {logDate}:</span>
            <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void logDose('taken')}>
              Taken
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void logDose('late')}>
              Late
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void logDose('skipped')}>
              Skipped
            </button>
          </div>
          <div className="btn-row">
            <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => setEditingTimes(true)}>
              Edit times
            </button>
            <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => void markInactive()}>
              Mark inactive
            </button>
          </div>
        </>
      )}

      <Modal open={editingTimes} title={`Times for ${m.name}`} onClose={() => setEditingTimes(false)}>
        <ScheduleEditForm
          med={m}
          onDone={() => {
            setEditingTimes(false)
            toast.show(`Updated times for ${m.name}.`, 'ok')
            onChanged()
          }}
        />
      </Modal>
    </div>
  )
}

function ScheduleEditForm({ med, onDone }: { med: Medication; onDone: () => void }) {
  const s = med.schedule
  const [kind, setKind] = useState(
    s.kind === 'as_needed' && !(s.times && s.times.length) ? 'fixed_times' : s.kind,
  )
  const [timesRaw, setTimesRaw] = useState(s.times?.length ? s.times.join(', ') : '08:00, 20:00')
  const [intervalHours, setIntervalHours] = useState(
    s.intervalHours != null ? String(s.intervalHours) : '',
  )
  const [withFood, setWithFood] = useState(Boolean(s.withFood))
  const [instructions, setInstructions] = useState(s.instructions ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [timesError, setTimesError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setTimesError(null)
    const built = buildSchedule({ kind, timesRaw, intervalHours, withFood, instructions })
    if (!('schedule' in built)) {
      if (built.timesError) setTimesError(built.timesError)
      if (built.error) setError(built.error)
      return
    }
    setBusy(true)
    try {
      await apiPatch(`/api/medications/${med.id}`, { schedule: built.schedule })
      onDone()
    } catch {
      setError('Could not save those times. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="hint">
        Fixed times (24-hour, e.g. 08:00, 20:00) are what Calendar uses for phone alarms.
      </p>
      <label className="field">
        <span>Schedule</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="fixed_times">Fixed times</option>
          <option value="interval_hours">Every N hours</option>
          <option value="as_needed">As needed</option>
          <option value="cyclic">Cyclic</option>
        </select>
      </label>
      {kind === 'fixed_times' && (
        <label className="field">
          <span>Times</span>
          <input
            type="text"
            value={timesRaw}
            onChange={(e) => setTimesRaw(e.target.value)}
            placeholder="08:00, 20:00"
            autoFocus
          />
          <span className="help-text">24-hour HH:MM, comma-separated.</span>
        </label>
      )}
      {kind === 'interval_hours' && (
        <label className="field">
          <span>Every (hours)</span>
          <input
            type="number"
            min="1"
            step="1"
            value={intervalHours}
            onChange={(e) => setIntervalHours(e.target.value)}
            placeholder="8"
          />
        </label>
      )}
      <label className="field">
        <span>
          <input type="checkbox" checked={withFood} onChange={(e) => setWithFood(e.target.checked)} /> Take with
          food
        </span>
      </label>
      <label className="field">
        <span>Instructions (optional)</span>
        <input type="text" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </label>
      {timesError && <p className="field-error">{timesError}</p>}
      {error && <p className="field-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save times'}
        </button>
      </div>
    </form>
  )
}

function MedicationList({
  medications,
  onChanged,
}: {
  medications: Medication[]
  onChanged: () => void
}) {
  const toast = useToast()
  const [logDate, setLogDate] = useState(localDateInput)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  const active = medications.filter((m) => m.isActive)
  const allSelected = active.length > 0 && active.every((m) => selected.has(m.id))
  const selectedCount = active.filter((m) => selected.has(m.id)).length

  function toggleSelect(id: string, next: boolean) {
    setSelected((prev) => {
      const copy = new Set(prev)
      if (next) copy.add(id)
      else copy.delete(id)
      return copy
    })
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(active.map((m) => m.id)))
  }

  async function takenAllSelected() {
    const ids = active.filter((m) => selected.has(m.id)).map((m) => m.id)
    if (!ids.length || bulkBusy) return
    setBulkBusy(true)
    const slot = scheduledForDay(logDate)
    let ok = 0
    try {
      for (const id of ids) {
        await apiPost(`/api/medications/${id}/adherence`, { status: 'taken', scheduledFor: slot })
        ok += 1
      }
      toast.show(`Logged taken for ${ok} medication${ok === 1 ? '' : 's'} on ${logDate}.`, 'ok')
      onChanged()
    } catch {
      toast.show(
        ok > 0
          ? `Logged ${ok} of ${ids.length}, then failed. Refresh and retry the rest.`
          : 'Could not log selected medications.',
        'err',
      )
      if (ok > 0) onChanged()
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="card med-bulk-bar">
        <div className="med-bulk-controls">
          <label className="field med-bulk-date">
            <span>Log date</span>
            <input
              type="date"
              value={logDate}
              max={localDateInput()}
              onChange={(e) => setLogDate(e.target.value || localDateInput())}
            />
          </label>
          <div className="btn-row med-bulk-actions">
            <button type="button" className="btn-ghost btn-sm" onClick={toggleAll} disabled={active.length === 0}>
              {allSelected ? 'Uncheck all' : 'Check all'}
            </button>
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={selectedCount === 0 || bulkBusy}
              onClick={() => void takenAllSelected()}
            >
              {bulkBusy ? 'Logging…' : `Taken all selected (${selectedCount})`}
            </button>
          </div>
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          Check medications, set the date, then mark them taken for that day. Per-card buttons use the same date.
        </p>
      </div>

      {medications.map((m) => (
        <MedCard
          key={m.id}
          m={m}
          logDate={logDate}
          selected={selected.has(m.id)}
          onSelect={toggleSelect}
          onChanged={onChanged}
        />
      ))}
    </div>
  )
}

function MedicationForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [dose, setDose] = useState('')
  const [form, setForm] = useState('tablet')
  const [purpose, setPurpose] = useState('')
  const [prescriber, setPrescriber] = useState('')
  const [pharmacy, setPharmacy] = useState('')
  const [startedAt, setStartedAt] = useState('')
  const [refillsRemaining, setRefillsRemaining] = useState('')
  const [kind, setKind] = useState('fixed_times')
  const [timesRaw, setTimesRaw] = useState('08:00, 20:00')
  const [intervalHours, setIntervalHours] = useState('')
  const [withFood, setWithFood] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [timesError, setTimesError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setTimesError(null)

    if (!name.trim()) {
      setError('A medication name is required.')
      return
    }
    if (!dose.trim()) {
      setError('A dose is required, e.g. "500mg".')
      return
    }

    const built = buildSchedule({ kind, timesRaw, intervalHours, withFood, instructions })
    if (!('schedule' in built)) {
      if (built.timesError) setTimesError(built.timesError)
      if (built.error) setError(built.error)
      return
    }
    const schedule = built.schedule

    const body: Record<string, unknown> = {
      name: name.trim(),
      dose: dose.trim(),
      form,
      schedule,
    }
    if (purpose.trim()) body.purpose = purpose.trim()
    if (prescriber.trim()) body.prescriber = prescriber.trim()
    if (pharmacy.trim()) body.pharmacy = pharmacy.trim()
    if (startedAt) body.startedAt = startedAt
    if (refillsRemaining !== '' && !Number.isNaN(Number(refillsRemaining))) {
      body.refillsRemaining = Number(refillsRemaining)
    }

    setBusy(true)
    try {
      await apiPost('/api/medications', body)
      onDone()
    } catch {
      setError('Could not save that medication. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Metformin" autoFocus />
        </label>
        <label className="field">
          <span>Dose</span>
          <input type="text" value={dose} onChange={(e) => setDose(e.target.value)} placeholder="500mg" />
        </label>
        <label className="field">
          <span>Form</span>
          <select value={form} onChange={(e) => setForm(e.target.value)}>
            {Object.entries(MED_FORM_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Purpose (optional)</span>
          <input type="text" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Blood sugar control" />
        </label>
        <label className="field">
          <span>Prescriber (optional)</span>
          <input type="text" value={prescriber} onChange={(e) => setPrescriber(e.target.value)} />
        </label>
        <label className="field">
          <span>Pharmacy (optional)</span>
          <input type="text" value={pharmacy} onChange={(e) => setPharmacy(e.target.value)} />
        </label>
        <label className="field">
          <span>Started (optional)</span>
          <input type="date" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
        </label>
        <label className="field">
          <span>Refills remaining (optional)</span>
          <input
            type="number"
            min="0"
            value={refillsRemaining}
            onChange={(e) => setRefillsRemaining(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Schedule</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="fixed_times">Fixed times</option>
            <option value="interval_hours">Every N hours</option>
            <option value="as_needed">As needed</option>
            <option value="cyclic">Cyclic</option>
          </select>
        </label>

        {kind === 'fixed_times' && (
          <label className="field">
            <span>Times</span>
            <input
              type="text"
              value={timesRaw}
              onChange={(e) => setTimesRaw(e.target.value)}
              placeholder="08:00, 20:00"
            />
            <span className="help-text">24-hour HH:MM, comma-separated.</span>
          </label>
        )}

        {kind === 'interval_hours' && (
          <label className="field">
            <span>Every (hours)</span>
            <input
              type="number"
              min="1"
              step="1"
              value={intervalHours}
              onChange={(e) => setIntervalHours(e.target.value)}
              placeholder="8"
            />
          </label>
        )}
      </div>

      {timesError && <p className="field-error">{timesError}</p>}

      <label className="field">
        <span>
          <input type="checkbox" checked={withFood} onChange={(e) => setWithFood(e.target.checked)} /> Take with food
        </span>
      </label>

      <label className="field">
        <span>Instructions (optional)</span>
        <input
          type="text"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Anything the label or your prescriber noted"
        />
      </label>

      {error && <p className="field-error">{error}</p>}

      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Add medication'}
        </button>
      </div>
    </form>
  )
}

export default function MedicationsPage() {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const refetch = () => setReloadKey((k) => k + 1)

  return (
    <AppGate>
      <main>
        <div className="page-header">
          <h1>Medications</h1>
          <div className="page-actions">
            <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
              + Add medication
            </button>
          </div>
        </div>

        <p className="muted">
          Log doses by day, see the last 30 days on each card, and mark several meds taken at once. Late
          counts as taken for adherence. Fixed times also show on Calendar; connect Google Calendar to
          get a phone alarm at each dose.
        </p>

        <Loaded<{ medications: Medication[] }> key={reloadKey} path="/api/medications">
          {(d) =>
            d.medications.length === 0 ? (
              <div className="card">No medications recorded.</div>
            ) : (
              <MedicationList medications={d.medications} onChanged={refetch} />
            )
          }
        </Loaded>

        <Modal open={open} title="Add medication" onClose={() => setOpen(false)} wide>
          <MedicationForm
            onDone={() => {
              setOpen(false)
              refetch()
              toast.show('Medication added.', 'ok')
            }}
          />
        </Modal>
      </main>
    </AppGate>
  )
}
