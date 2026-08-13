'use client'

import { useEffect, useState } from 'react'
import { AppGate } from '../components/AppGate'
import { apiGet, NotAuthenticated } from '@/lib/api'
import { METRIC_LABELS, formatDate, formatMetric, titleCase } from '@/lib/format'

interface VisitPrep {
  generatedAt: string
  windowDays: number
  windowStart: string
  windowEnd: string
  profile: {
    displayName: string
    dateOfBirth: string | null
    sexAtBirth: string | null
    allergies: string[]
    preferredPharmacy: string | null
  } | null
  conditions: Array<{
    key: string
    label: string
    icdCode: string | null
    diagnosedAt: string | null
    status: string
  }>
  careTeam: Array<{ name: string; role: string; organization: string | null }>
  readings: Array<{
    type: string
    label: string
    limitLabel: string | null
    count: number
    latestValue: number | null
    latestSecondary: number | null
    latestAt: string | null
    unit: string | null
    average: number | null
    min: number | null
    max: number | null
    inRangePct: number | null
  }>
  thresholdCrossings: Array<{
    id: string
    severity: string
    message: string
    count: number
    latestAt: string | null
  }>
  activePatterns: Array<{
    id: string
    description: string
    detail: string | null
    condition: string
  }>
  medications: Array<{
    name: string
    dose: string
    form: string
    purpose: string | null
    adherencePct: number
    doseCount: number
    missed: number
  }>
  assessments: Array<{
    key: string
    title: string
    score: number | null
    band: string | null
    completedAt: string
    criticalTriggered: string[]
  }>
  pastVisits: Array<{
    title: string
    type: string
    startsAt: string
    location: string | null
    visitNotes: string | null
  }>
  upcomingVisits: Array<{
    title: string
    type: string
    startsAt: string
    location: string | null
  }>
  questions: Array<{ title: string; notes: string | null; dueAt: string | null }>
  notableLabs: Array<{
    testName: string
    value: string
    unit: string | null
    flag: string
    collectedAt: string | null
  }>
  imaging: Array<{ title: string; modality: string; examAt: string | null }>
}

function readingName(r: VisitPrep['readings'][number]): string {
  return r.label === r.type ? (METRIC_LABELS[r.type] ?? r.type) : r.label
}

export default function VisitPrepPage() {
  const [data, setData] = useState<VisitPrep | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    apiGet<VisitPrep>('/api/visit-prep')
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof NotAuthenticated ? 'Not signed in.' : 'Could not load the visit packet.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <AppGate>
      <main className="visit-prep">
        <div className="page-header">
          <div>
            <h1>90-day visit prep</h1>
            <p className="muted">
              A packet to bring to a visit — trends, meds, and questions from the last{' '}
              {data?.windowDays ?? 90} days. Print or save as PDF.
            </p>
          </div>
          <div className="page-actions">
            <button type="button" className="btn-primary" onClick={() => window.print()}>
              Print / Save as PDF
            </button>
          </div>
        </div>

        {error && <div className="card">{error}</div>}
        {!data && !error && <p className="hint">Loading…</p>}

        {data && (
          <>
            <p className="hint visit-prep-meta">
              Prepared {formatDate(data.generatedAt)} for {data.profile?.displayName ?? 'you'} ·{' '}
              {formatDate(data.windowStart)} – {formatDate(data.windowEnd)}
            </p>
            <p className="hint">
              Personal summary from what you have logged — not an official medical record. MedicalBot
              does not diagnose, prescribe, or change treatment. Confirm anything important with your
              care team.
            </p>

            <section className="card">
              <h2>Conditions</h2>
              {data.conditions.length === 0 ? (
                <p className="hint">No active conditions on file.</p>
              ) : (
                <ul className="plain-list">
                  {data.conditions.map((c) => (
                    <li key={c.key}>
                      <strong>{c.label}</strong>
                      <span className="hint">
                        {c.icdCode ? ` · ${c.icdCode}` : ''}
                        {c.diagnosedAt ? ` · diagnosed ${formatDate(c.diagnosedAt)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {data.profile?.allergies && data.profile.allergies.length > 0 && (
                <p>
                  <strong>Allergies:</strong> {data.profile.allergies.join(', ')}
                </p>
              )}
              {data.profile?.preferredPharmacy && (
                <p className="hint">Pharmacy: {data.profile.preferredPharmacy}</p>
              )}
            </section>

            <section className="card">
              <h2>Readings vs limits</h2>
              {data.readings.every((r) => r.count === 0) ? (
                <p className="hint">No tracked readings in this window.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Metric</th>
                        <th>Limits</th>
                        <th>Latest</th>
                        <th>90-day range</th>
                        <th>In range</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.readings.map((r) => (
                        <tr key={`${r.type}:${r.label}`}>
                          <td>{readingName(r)}</td>
                          <td>{r.limitLabel ?? '—'}</td>
                          <td>
                            {r.latestValue === null
                              ? 'No readings'
                              : `${formatMetric(r.type, r.latestValue, r.latestSecondary)}${
                                  r.latestAt ? ` · ${formatDate(r.latestAt)}` : ''
                                }`}
                          </td>
                          <td>
                            {r.count === 0
                              ? '—'
                              : `${r.min}–${r.max}${r.average !== null ? ` · avg ${r.average}` : ''} (${r.count})`}
                          </td>
                          <td>
                            {r.inRangePct === null ? '—' : `${Math.round(r.inRangePct * 100)}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="card">
              <h2>Threshold crossings</h2>
              {data.thresholdCrossings.length === 0 ? (
                <p className="hint">No module thresholds were crossed in this window.</p>
              ) : (
                <ul className="plain-list">
                  {data.thresholdCrossings.map((t) => (
                    <li key={t.id}>
                      <strong>
                        {t.count}× {t.severity}
                      </strong>
                      <span className="hint">
                        {t.latestAt ? ` · last ${formatDate(t.latestAt)}` : ''}
                      </span>
                      <span>{t.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card">
              <h2>Patterns firing now</h2>
              {(data.activePatterns ?? []).length === 0 ? (
                <p className="hint">No evaluated patterns are active in this window.</p>
              ) : (
                <ul className="plain-list">
                  {(data.activePatterns ?? []).map((p) => (
                    <li key={`${p.condition}-${p.id}`}>
                      <strong>{p.description}</strong>
                      <span className="hint"> · {p.condition}</span>
                      {p.detail && <span>{p.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card">
              <h2>Medications</h2>
              {data.medications.length === 0 ? (
                <p className="hint">No active medications on file.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Medication</th>
                        <th>Dose</th>
                        <th>Adherence (90d)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.medications.map((m) => (
                        <tr key={m.name + m.dose}>
                          <td>
                            {m.name}
                            {m.purpose ? <span className="hint"> · {m.purpose}</span> : null}
                          </td>
                          <td>
                            {m.dose} {m.form}
                          </td>
                          <td>
                            {m.doseCount === 0
                              ? 'No doses logged'
                              : `${Math.round(m.adherencePct * 100)}% (${m.missed} missed of ${m.doseCount})`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="card">
              <h2>Assessments</h2>
              {data.assessments.length === 0 ? (
                <p className="hint">No questionnaires completed in this window.</p>
              ) : (
                <ul className="plain-list">
                  {data.assessments.map((a) => (
                    <li key={`${a.key}-${a.completedAt}`}>
                      <strong>{a.title}</strong>
                      <span>
                        {a.score !== null ? ` · ${a.score}` : ''}
                        {a.band ? ` (${a.band})` : ''}
                      </span>
                      <span className="hint"> · {formatDate(a.completedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {data.notableLabs.length > 0 && (
              <section className="card">
                <h2>Flagged labs</h2>
                <ul className="plain-list">
                  {data.notableLabs.map((l, i) => (
                    <li key={`${l.testName}-${i}`}>
                      <strong>{l.testName}</strong> {l.value}
                      {l.unit ? ` ${l.unit}` : ''}
                      <span className="hint">
                        {' '}
                        · {l.flag}
                        {l.collectedAt ? ` · ${formatDate(l.collectedAt)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.imaging.length > 0 && (
              <section className="card">
                <h2>Imaging</h2>
                <ul className="plain-list">
                  {data.imaging.map((r, i) => (
                    <li key={`${r.title}-${i}`}>
                      <strong>{r.title}</strong>
                      <span className="hint">
                        {' '}
                        · {r.modality}
                        {r.examAt ? ` · ${formatDate(r.examAt)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="card">
              <h2>Visits</h2>
              <h3>Upcoming</h3>
              {data.upcomingVisits.length === 0 ? (
                <p className="hint">Nothing scheduled.</p>
              ) : (
                <ul className="plain-list">
                  {data.upcomingVisits.map((a) => (
                    <li key={a.startsAt + a.title}>
                      <strong>{a.title}</strong>
                      <span className="hint">
                        {' '}
                        · {formatDate(a.startsAt)}
                        {a.location ? ` · ${a.location}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <h3>In this window</h3>
              {data.pastVisits.length === 0 ? (
                <p className="hint">No visits logged in the last {data.windowDays} days.</p>
              ) : (
                <ul className="plain-list">
                  {data.pastVisits.map((a) => (
                    <li key={a.startsAt + a.title}>
                      <strong>{a.title}</strong>
                      <span className="hint">
                        {' '}
                        · {titleCase(a.type.replace(/_/g, ' '))} · {formatDate(a.startsAt)}
                      </span>
                      {a.visitNotes && <span>{a.visitNotes}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card">
              <h2>Questions to raise</h2>
              {data.questions.length === 0 ? (
                <p className="hint">No open to-dos. Add items on To Dos if you want them on this packet.</p>
              ) : (
                <ul className="plain-list">
                  {data.questions.map((q) => (
                    <li key={q.title}>
                      <strong>{q.title}</strong>
                      {q.dueAt && <span className="hint"> · due {formatDate(q.dueAt)}</span>}
                      {q.notes && <span>{q.notes}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {data.careTeam.length > 0 && (
              <section className="card">
                <h2>Care team</h2>
                <ul className="plain-list">
                  {data.careTeam.map((m) => (
                    <li key={m.name}>
                      <strong>{m.name}</strong>
                      <span className="hint">
                        {' '}
                        · {titleCase(m.role.replace(/_/g, ' '))}
                        {m.organization ? ` · ${m.organization}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </AppGate>
  )
}
