'use client'

import { useEffect, useState } from 'react'
import { AppGate } from '../components/AppGate'
import { apiGet, NotAuthenticated } from '@/lib/api'
import { formatDate, titleCase, ROLE_LABELS, MED_FORM_LABELS } from '@/lib/format'

interface Profile {
  displayName: string
  dateOfBirth: string | null
  sexAtBirth: string | null
  heightCm: number | string | null
  timezone: string
  allergies: string[]
  emergencyContactName: string | null
  emergencyContactPhone: string | null
  preferredPharmacy: string | null
}

interface CareTeamMember {
  id: string
  name: string
  role: string
  organization: string | null
  phone: string | null
  email: string | null
}

interface Condition {
  id: string
  key: string
  label: string
  status: string
  diagnosedAt: string | null
}

interface Schedule {
  kind: string
  times: string[]
  withFood: boolean
  instructions: string | null
}

interface Medication {
  id: string
  name: string
  dose: string
  form: string
  schedule: Schedule
  purpose: string | null
  isActive: boolean
}

interface Metric {
  id: string
  type: string
  value: number | null
  unit: string | null
  recordedAt: string
  context: string | null
}

interface Summary {
  profile: Profile | null
  careTeam: CareTeamMember[]
  conditions: Condition[]
  medications: Medication[]
  labs: Metric[]
}

function describeSchedule(s: Schedule): string {
  if (s.kind === 'as_needed') return 'As needed'
  if (s.kind === 'interval_hours') return 'On an interval'
  if (s.kind === 'cyclic') return 'Cyclic'
  if (!s.times?.length) return 'No times set'
  return `${s.times.length}× daily at ${s.times.join(', ')}${s.withFood ? ' · with food' : ''}`
}

function ageFromDob(dob: string): number | null {
  const d = new Date(dob)
  if (Number.isNaN(+d)) return null
  const now = new Date()
  let age = now.getFullYear() - d.getFullYear()
  const monthDelta = now.getMonth() - d.getMonth()
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < d.getDate())) age -= 1
  return age
}

function HealthSummary() {
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState<'auth' | 'other' | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      apiGet<{ profile: Profile | null; careTeam: CareTeamMember[] }>('/api/profile'),
      apiGet<{ conditions: Condition[] }>('/api/conditions'),
      apiGet<{ medications: Medication[] }>('/api/medications'),
      apiGet<{ metrics: Metric[] }>('/api/metrics?type=lab_value&days=365'),
    ])
      .then(([profile, conditions, medications, metrics]) => {
        if (cancelled) return
        setData({
          profile: profile.profile,
          careTeam: profile.careTeam,
          conditions: conditions.conditions.filter((c) => c.status === 'active'),
          medications: medications.medications.filter((m) => m.isActive),
          labs: metrics.metrics,
        })
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof NotAuthenticated ? 'auth' : 'other')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error === 'auth') {
    return (
      <div className="card">
        <p>
          <strong>Not signed in.</strong>
        </p>
        <p className="hint">
          Head back to the <a href="/">home page</a> and sign in to view this.
        </p>
      </div>
    )
  }

  if (error === 'other') {
    return (
      <div className="card">
        <p>
          <strong>Could not load your summary.</strong>
        </p>
        <p className="hint">The API did not respond as expected. Is it running?</p>
      </div>
    )
  }

  if (!data) return <p className="hint">Loading…</p>

  const { profile, careTeam, conditions, medications, labs } = data
  const age = profile?.dateOfBirth ? ageFromDob(profile.dateOfBirth) : null

  return (
    <div className="stack">
      <div className="card">
        <h2>Patient</h2>
        {!profile ? (
          <p className="hint">No profile recorded yet.</p>
        ) : (
          <dl className="detail-grid">
            <div>
              <dt>Name</dt>
              <dd>{profile.displayName}</dd>
            </div>
            <div>
              <dt>Date of birth</dt>
              <dd>
                {profile.dateOfBirth ? formatDate(profile.dateOfBirth) : '—'}
                {age !== null && <span className="hint"> age {age}</span>}
              </dd>
            </div>
            <div>
              <dt>Sex at birth</dt>
              <dd>{profile.sexAtBirth ? titleCase(profile.sexAtBirth) : '—'}</dd>
            </div>
            <div>
              <dt>Height</dt>
              <dd>{profile.heightCm ? `${profile.heightCm} cm` : '—'}</dd>
            </div>
            <div>
              <dt>Pharmacy</dt>
              <dd>{profile.preferredPharmacy ?? '—'}</dd>
            </div>
            <div>
              <dt>Emergency contact</dt>
              <dd>
                {profile.emergencyContactName ?? '—'}
                {profile.emergencyContactPhone && (
                  <span className="hint"> {profile.emergencyContactPhone}</span>
                )}
              </dd>
            </div>
          </dl>
        )}
        {profile && profile.allergies.length > 0 && (
          <>
            <h3>Allergies</h3>
            <div className="chip-row">
              {profile.allergies.map((a) => (
                <span key={a} className="badge badge-warn">
                  {a}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>Active conditions</h2>
        {conditions.length === 0 ? (
          <p className="hint">No active conditions recorded.</p>
        ) : (
          <ul className="plain-list">
            {conditions.map((c) => (
              <li key={c.id}>
                <strong>{c.label}</strong>
                <span className="hint">
                  {c.diagnosedAt ? `Diagnosed ${formatDate(c.diagnosedAt)}` : 'Diagnosis date not recorded'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Current medications</h2>
        {medications.length === 0 ? (
          <p className="hint">No active medications recorded.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Dose</th>
                  <th>Form</th>
                  <th>Schedule</th>
                  <th>Purpose</th>
                </tr>
              </thead>
              <tbody>
                {medications.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>{m.dose}</td>
                    <td>{MED_FORM_LABELS[m.form] ?? m.form}</td>
                    <td>{describeSchedule(m.schedule)}</td>
                    <td>{m.purpose ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Recent labs</h2>
        {labs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🧪</div>
            <h3>No lab results recorded</h3>
            <p>Lab values you log in the past year will appear here for your visit.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lab</th>
                  <th>Value</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {labs.map((l) => (
                  <tr key={l.id}>
                    <td>{l.context ?? 'Lab value'}</td>
                    <td>
                      {l.value ?? '—'}
                      {l.unit ? ` ${l.unit}` : ''}
                    </td>
                    <td>{formatDate(l.recordedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Care team</h2>
        {careTeam.length === 0 ? (
          <p className="hint">No providers recorded.</p>
        ) : (
          <ul className="plain-list">
            {careTeam.map((m) => (
              <li key={m.id}>
                <strong>
                  {m.name} <span className="muted">{ROLE_LABELS[m.role] ?? titleCase(m.role)}</span>
                </strong>
                <span className="hint">
                  {[m.organization, m.phone, m.email].filter(Boolean).join(' · ') || 'No contact on file'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="hint">
        This is a personal summary you generated from what you have logged — not an official
        medical record. MedicalBot tracks and surfaces patterns; it does not diagnose, prescribe,
        or change treatment. Confirm anything important with your care team.
      </p>
    </div>
  )
}

export default function RecordsPage() {
  return (
    <AppGate>
      <main>
        <div className="page-header">
          <h1>Health summary</h1>
          <div className="page-actions">
            <button type="button" className="btn-secondary" onClick={() => window.print()}>
              Print / Save as PDF
            </button>
          </div>
        </div>

        <p className="muted">
          A read-only snapshot of your profile, active conditions, current medications, recent
          labs, and care team. For a 90-day trend packet to bring to a visit, use{' '}
          <a href="/visit-prep">Visit prep</a>.
        </p>

        <HealthSummary />
      </main>
    </AppGate>
  )
}
