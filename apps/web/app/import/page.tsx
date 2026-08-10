'use client'

import { useEffect, useState } from 'react'
import { AppGate } from '../components/AppGate'
import { ImportParsingProgress } from '../components/ImportParsingProgress'
import { useToast } from '../components/Toast'
import { apiErrorMessage, apiGet, apiPost, ApiError } from '@/lib/api'
import { METRIC_LABELS } from '@/lib/format'

interface Lab {
  testName: string
  value: string
  unit: string | null
  referenceText: string | null
  flag: string | null
  panelName: string | null
  loinc: string | null
  collectedAt: string | null
  include: boolean
}
interface Med {
  name: string
  dose: string | null
  form: string | null
  frequency: string | null
  purpose: string | null
  include: boolean
}
interface Vital {
  type: string
  value: number | null
  valueSecondary: number | null
  unit: string | null
  at: string | null
  include: boolean
}
interface ImagingMeasurement {
  name: string
  value: string
  unit: string | null
  indexValue: string | null
  indexUnit: string | null
  category: string | null
  include: boolean
}
interface ImagingFinding {
  section: string
  text: string
  include: boolean
}
interface ImagingConclusion {
  text: string
  include: boolean
}
interface Diagnosis {
  name: string
  icdCode: string | null
  include: boolean
}

interface Parsed {
  documentType: string
  documentDate: string | null
  provider: string | null
  reportTitle: string | null
  resultsFrom: string | null
  resultsTo: string | null
  imagingModality: string | null
  indication: string | null
  referringPhysician: string | null
  readingPhysician: string | null
  signedAt: string | null
  comparisonNote: string | null
  notes: string | null
  labResults: Omit<Lab, 'include'>[]
  medications: Omit<Med, 'include'>[]
  vitals: Omit<Vital, 'include'>[]
  imagingMeasurements: Omit<ImagingMeasurement, 'include'>[]
  imagingFindings: Omit<ImagingFinding, 'include'>[]
  imagingConclusions: string[]
  diagnoses: Omit<Diagnosis, 'include'>[]
}

type Phase = 'idle' | 'parsing' | 'review' | 'committing'

/** ISO or date string → YYYY-MM-DD for <input type="date"> */
function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return ''
  const head = iso.trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : ''
}

function fromDateInputValue(value: string): string | null {
  const v = value.trim()
  return v ? v : null
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export default function ImportPage() {
  const toast = useToast()
  const [phase, setPhase] = useState<Phase>('idle')
  const [filename, setFilename] = useState('')
  const [meta, setMeta] = useState<
    Pick<
      Parsed,
      | 'documentType'
      | 'documentDate'
      | 'provider'
      | 'reportTitle'
      | 'resultsFrom'
      | 'resultsTo'
      | 'imagingModality'
      | 'indication'
      | 'referringPhysician'
      | 'readingPhysician'
      | 'signedAt'
      | 'comparisonNote'
      | 'notes'
    > | null
  >(null)
  const [labs, setLabs] = useState<Lab[]>([])
  const [meds, setMeds] = useState<Med[]>([])
  const [vitals, setVitals] = useState<Vital[]>([])
  const [imagingMeasurements, setImagingMeasurements] = useState<ImagingMeasurement[]>([])
  const [imagingFindings, setImagingFindings] = useState<ImagingFinding[]>([])
  const [imagingConclusions, setImagingConclusions] = useState<ImagingConclusion[]>([])
  const [diagnoses, setDiagnoses] = useState<Diagnosis[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)

  useEffect(() => {
    apiGet<{ ai: { configured: boolean } }>('/api/settings/ai')
      .then((d) => setNotConfigured(!d.ai.configured))
      .catch(() => {})
  }, [])

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setFilename(file.name)
    setPhase('parsing')
    try {
      const dataUrl = await readAsDataUrl(file)
      const parsed = await apiPost<Parsed>('/api/import/parse', {
        filename: file.name,
        mimeType: file.type,
        dataUrl,
      })
      setMeta({
        documentType: parsed.documentType,
        documentDate: parsed.documentDate,
        provider: parsed.provider,
        reportTitle: parsed.reportTitle,
        resultsFrom: parsed.resultsFrom,
        resultsTo: parsed.resultsTo,
        imagingModality: parsed.imagingModality,
        indication: parsed.indication,
        referringPhysician: parsed.referringPhysician,
        readingPhysician: parsed.readingPhysician,
        signedAt: parsed.signedAt,
        comparisonNote: parsed.comparisonNote,
        notes: parsed.notes,
      })
      setLabs(
        parsed.labResults.map((l) => ({
          ...l,
          include: true,
          collectedAt:
            l.collectedAt ??
            (parsed.documentType !== 'lab_trends' ? parsed.documentDate : null),
        })),
      )
      setMeds(parsed.medications.map((m) => ({ ...m, include: true })))
      setVitals(
        parsed.vitals.map((v) => ({
          ...v,
          include: true,
          at: v.at ?? parsed.documentDate,
        })),
      )
      setImagingMeasurements(parsed.imagingMeasurements.map((m) => ({ ...m, include: true })))
      setImagingFindings(parsed.imagingFindings.map((f) => ({ ...f, include: true })))
      setImagingConclusions(parsed.imagingConclusions.map((text) => ({ text, include: true })))
      setDiagnoses(parsed.diagnoses.map((d) => ({ ...d, include: true })))
      setPhase('review')
      const total =
        parsed.labResults.length +
        parsed.medications.length +
        parsed.vitals.length +
        parsed.imagingMeasurements.length +
        parsed.imagingFindings.length +
        parsed.imagingConclusions.length +
        parsed.diagnoses.length
      if (total === 0) toast.show('No records found in that document.', 'info')
    } catch (err) {
      setPhase('idle')
      if (err instanceof ApiError) {
        if (err.status === 503) {
          setNotConfigured(true)
        }
        setError(
          apiErrorMessage(err.body) ??
            'Could not read that document. Try a clearer scan or a different file.',
        )
      } else {
        setError('Could not read that document. Try a clearer scan or a different file.')
      }
    }
  }

  async function commit() {
    const selectedLabs = labs.filter((l) => l.include)
    const selectedVitals = vitals.filter((v) => v.include)
    const labsWithoutDate = selectedLabs.filter((l) => !l.collectedAt)
    const vitalsWithoutDate = selectedVitals.filter((v) => !v.at)

    if (labsWithoutDate.length > 0 || vitalsWithoutDate.length > 0) {
      toast.show(
        'Every selected lab and vital needs a collection date before saving — charting requires it.',
        'err',
      )
      return
    }

    setPhase('committing')
    const selectedMeasurements = imagingMeasurements.filter((m) => m.include)
    const selectedFindings = imagingFindings.filter((f) => f.include)
    const selectedConclusions = imagingConclusions.filter((c) => c.include)
    const selectedDiagnoses = diagnoses.filter((d) => d.include)
    const hasImaging =
      selectedMeasurements.length > 0 ||
      selectedFindings.length > 0 ||
      selectedConclusions.length > 0 ||
      selectedDiagnoses.length > 0

    try {
      const res = await apiPost<{
        labsAdded: number
        medsAdded: number
        vitalsAdded: number
        imagingAdded: number
      }>('/api/import/commit', {
        sourceDocument: filename,
        labResults: labs.filter((l) => l.include).map(({ include, ...rest }) => rest),
        medications: meds.filter((m) => m.include).map(({ include, ...rest }) => rest),
        vitals: vitals.filter((v) => v.include).map(({ include, ...rest }) => rest),
        imagingReport: hasImaging
          ? {
              modality: (meta?.imagingModality as 'echo') ?? 'other',
              title: meta?.reportTitle ?? filename,
              examAt: meta?.documentDate,
              signedAt: meta?.signedAt,
              facility: meta?.provider,
              referringPhysician: meta?.referringPhysician,
              readingPhysician: meta?.readingPhysician,
              indication: meta?.indication,
              comparisonNote: meta?.comparisonNote,
              measurements: selectedMeasurements.map(({ include, ...rest }) => rest),
              findings: selectedFindings.map(({ include, ...rest }) => rest),
              conclusions: selectedConclusions.map((c) => c.text),
              diagnoses: selectedDiagnoses.map(({ include, ...rest }) => rest),
            }
          : null,
      })
      const parts = [
        res.labsAdded ? `${res.labsAdded} lab(s)` : '',
        res.medsAdded ? `${res.medsAdded} medication(s)` : '',
        res.vitalsAdded ? `${res.vitalsAdded} vital(s)` : '',
        res.imagingAdded ? `${res.imagingAdded} imaging report(s)` : '',
      ].filter(Boolean)
      toast.show(`Saved ${parts.join(', ')}.`)
      reset()
    } catch {
      setPhase('review')
      toast.show('Could not save those records.', 'err')
    }
  }

  function reset() {
    setPhase('idle')
    setMeta(null)
    setLabs([])
    setMeds([])
    setVitals([])
    setImagingMeasurements([])
    setImagingFindings([])
    setImagingConclusions([])
    setDiagnoses([])
    setFilename('')
  }

  const selectedCount =
    labs.filter((l) => l.include).length +
    meds.filter((m) => m.include).length +
    vitals.filter((v) => v.include).length +
    imagingMeasurements.filter((m) => m.include).length +
    imagingFindings.filter((f) => f.include).length +
    imagingConclusions.filter((c) => c.include).length +
    diagnoses.filter((d) => d.include).length

  const hasAnyItems =
    labs.length > 0 ||
    meds.length > 0 ||
    vitals.length > 0 ||
    imagingMeasurements.length > 0 ||
    imagingFindings.length > 0 ||
    imagingConclusions.length > 0 ||
    diagnoses.length > 0

  const selectedLabsMissingDate = labs.filter((l) => l.include && !l.collectedAt).length
  const selectedVitalsMissingDate = vitals.filter((v) => v.include && !v.at).length
  const hasDateGaps = selectedLabsMissingDate > 0 || selectedVitalsMissingDate > 0

  return (
    <AppGate>
      <main>
        <div className="page-header">
          <div>
            <h1>Import a document</h1>
            <p className="muted">
              Upload a lab report, imaging study, prescription, or visit summary. We read it and
              pull out your data for you to review before anything is saved.
            </p>
          </div>
        </div>

        {notConfigured && (
          <div className="callout danger">
            <strong>Import not enabled.</strong>
            <p>
              Add your OpenRouter API key in <a href="/settings">Settings</a> to turn on document
              reading.
            </p>
          </div>
        )}

        {phase === 'idle' && (
          <div className="card">
            <label className="btn-primary" style={{ cursor: 'pointer' }}>
              Choose a PDF or image
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/webp"
                onChange={onFile}
                style={{ display: 'none' }}
              />
            </label>
            <p className="help-text">PDF, PNG, JPG, or WebP · up to 15 MB.</p>
            {error && <p className="field-error">{error}</p>}
            <p className="hint" style={{ marginTop: '1rem' }}>
              Nothing is saved automatically — you'll review and confirm every item. This reads
              your document with an AI model; it does not diagnose or interpret results.
            </p>
          </div>
        )}

        {phase === 'parsing' && (
          <div className="card">
            <ImportParsingProgress filename={filename} />
          </div>
        )}

        {(phase === 'review' || phase === 'committing') && meta && (
          <>
            {phase === 'committing' && (
              <div className="card">
                <ImportParsingProgress filename={filename} mode="saving" />
              </div>
            )}
            <div className="card">
              <div className="row-between">
                <div>
                  <strong>{meta.reportTitle ?? filename}</strong>
                  <p className="hint">
                    {meta.documentType.replace(/_/g, ' ')}
                    {meta.resultsFrom && meta.resultsTo && ` · ${meta.resultsFrom} – ${meta.resultsTo}`}
                    {!meta.resultsFrom && meta.documentDate && ` · exam ${meta.documentDate}`}
                    {meta.signedAt && ` · signed ${meta.signedAt}`}
                    {meta.provider && ` · ${meta.provider}`}
                  </p>
                  {meta.indication && <p className="hint">Indication: {meta.indication}</p>}
                  {meta.readingPhysician && (
                    <p className="hint">Read by: {meta.readingPhysician}</p>
                  )}
                  {meta.comparisonNote && (
                    <p className="hint">Comparison: {meta.comparisonNote}</p>
                  )}
                </div>
                <button type="button" className="btn-ghost btn-sm" onClick={reset}>
                  Start over
                </button>
              </div>
            </div>

            {!hasAnyItems ? (
              <div className="empty-state">
                <span className="empty-icon">📄</span>
                <h3>Nothing to import</h3>
                <p>We couldn't find labs, medications, vitals, or imaging data in that document.</p>
              </div>
            ) : (
              <>
                <p className="hint">
                  Review what we found, fix anything that looks off, and untick anything you don't
                  want. Nothing is saved until you press “Save selected”.
                </p>
                {hasDateGaps && (
                  <div className="callout danger">
                    <strong>Missing dates.</strong>
                    <p>
                      {selectedLabsMissingDate > 0 &&
                        `${selectedLabsMissingDate} lab result(s) `}
                      {selectedLabsMissingDate > 0 && selectedVitalsMissingDate > 0 && 'and '}
                      {selectedVitalsMissingDate > 0 && `${selectedVitalsMissingDate} vital(s) `}
                      need a collection date before you can save — otherwise they cannot be charted.
                    </p>
                  </div>
                )}
              </>
            )}

            {diagnoses.length > 0 && (
              <section>
                <h2>Diagnoses ({diagnoses.length})</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Add</th>
                        <th>Diagnosis</th>
                        <th>ICD-10</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diagnoses.map((d, i) => (
                        <tr key={i}>
                          <td>
                            <input
                              type="checkbox"
                              checked={d.include}
                              onChange={(e) =>
                                setDiagnoses((p) =>
                                  p.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)),
                                )
                              }
                            />
                          </td>
                          <td>{d.name}</td>
                          <td className="hint">{d.icdCode ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {imagingMeasurements.length > 0 && (
              <section>
                <h2>Imaging measurements ({imagingMeasurements.length})</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Add</th>
                        <th>Measurement</th>
                        <th>Value</th>
                        <th>Section</th>
                      </tr>
                    </thead>
                    <tbody>
                      {imagingMeasurements.map((m, i) => (
                        <tr key={i}>
                          <td>
                            <input
                              type="checkbox"
                              checked={m.include}
                              onChange={(e) =>
                                setImagingMeasurements((p) =>
                                  p.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)),
                                )
                              }
                            />
                          </td>
                          <td>{m.name}</td>
                          <td>
                            {m.value} {m.unit ?? ''}
                            {m.indexValue && (
                              <span className="hint">
                                {' '}
                                (index {m.indexValue} {m.indexUnit ?? ''})
                              </span>
                            )}
                          </td>
                          <td className="hint">{m.category ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {imagingFindings.length > 0 && (
              <section>
                <h2>Findings ({imagingFindings.length})</h2>
                {imagingFindings.map((f, i) => (
                  <div key={i} className="card" style={{ marginBottom: '0.75rem' }}>
                    <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                      <input
                        type="checkbox"
                        checked={f.include}
                        onChange={(e) =>
                          setImagingFindings((p) =>
                            p.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)),
                          )
                        }
                      />
                      <span>
                        <strong>{f.section}</strong>
                        <p className="hint" style={{ marginTop: '0.25rem' }}>
                          {f.text}
                        </p>
                      </span>
                    </label>
                  </div>
                ))}
              </section>
            )}

            {imagingConclusions.length > 0 && (
              <section>
                <h2>Conclusions ({imagingConclusions.length})</h2>
                {imagingConclusions.map((c, i) => (
                  <div key={i} className="card" style={{ marginBottom: '0.5rem' }}>
                    <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                      <input
                        type="checkbox"
                        checked={c.include}
                        onChange={(e) =>
                          setImagingConclusions((p) =>
                            p.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)),
                          )
                        }
                      />
                      <span>{c.text}</span>
                    </label>
                  </div>
                ))}
              </section>
            )}

            {labs.length > 0 && (
              <section>
                <h2>Lab results ({labs.length})</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Add</th>
                        <th>Date</th>
                        <th>Test</th>
                        <th>Value</th>
                        <th>Unit</th>
                        <th>Reference</th>
                        <th>Flag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {labs.map((l, i) => (
                        <tr key={i}>
                          <td>
                            <input
                              type="checkbox"
                              checked={l.include}
                              onChange={(e) =>
                                setLabs((p) => p.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="date"
                              value={toDateInputValue(l.collectedAt)}
                              onChange={(e) =>
                                setLabs((p) =>
                                  p.map((x, j) =>
                                    j === i ? { ...x, collectedAt: fromDateInputValue(e.target.value) } : x,
                                  ),
                                )
                              }
                              className={l.include && !l.collectedAt ? 'field-error-input' : undefined}
                              required={l.include}
                              aria-label={`Collection date for ${l.testName}`}
                            />
                          </td>
                          <td>
                            <input
                              value={l.testName}
                              onChange={(e) =>
                                setLabs((p) => p.map((x, j) => (j === i ? { ...x, testName: e.target.value } : x)))
                              }
                            />
                          </td>
                          <td>
                            <input
                              value={l.value}
                              onChange={(e) =>
                                setLabs((p) => p.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                              }
                              style={{ maxWidth: '6rem' }}
                            />
                          </td>
                          <td>
                            <input
                              value={l.unit ?? ''}
                              onChange={(e) =>
                                setLabs((p) => p.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))
                              }
                              style={{ maxWidth: '5rem' }}
                            />
                          </td>
                          <td className="hint">{l.referenceText ?? '—'}</td>
                          <td>
                            {l.flag && l.flag !== 'normal' ? (
                              <span className="badge badge-warn">{l.flag.replace(/_/g, ' ')}</span>
                            ) : (
                              <span className="hint">normal</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {meds.length > 0 && (
              <section>
                <h2>Medications ({meds.length})</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Add</th>
                        <th>Name</th>
                        <th>Dose</th>
                        <th>Frequency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {meds.map((m, i) => (
                        <tr key={i}>
                          <td>
                            <input
                              type="checkbox"
                              checked={m.include}
                              onChange={(e) =>
                                setMeds((p) => p.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))
                              }
                            />
                          </td>
                          <td>
                            <input
                              value={m.name}
                              onChange={(e) =>
                                setMeds((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                              }
                            />
                          </td>
                          <td>
                            <input
                              value={m.dose ?? ''}
                              onChange={(e) =>
                                setMeds((p) => p.map((x, j) => (j === i ? { ...x, dose: e.target.value } : x)))
                              }
                              style={{ maxWidth: '7rem' }}
                            />
                          </td>
                          <td className="hint">{m.frequency ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {vitals.length > 0 && (
              <section>
                <h2>Vitals ({vitals.length})</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Add</th>
                        <th>Date</th>
                        <th>Type</th>
                        <th>Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vitals.map((v, i) => (
                        <tr key={i}>
                          <td>
                            <input
                              type="checkbox"
                              checked={v.include}
                              onChange={(e) =>
                                setVitals((p) => p.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="date"
                              value={toDateInputValue(v.at)}
                              onChange={(e) =>
                                setVitals((p) =>
                                  p.map((x, j) =>
                                    j === i ? { ...x, at: fromDateInputValue(e.target.value) } : x,
                                  ),
                                )
                              }
                              className={v.include && !v.at ? 'field-error-input' : undefined}
                              required={v.include}
                              aria-label={`Date for ${METRIC_LABELS[v.type] ?? v.type}`}
                            />
                          </td>
                          <td>{METRIC_LABELS[v.type] ?? v.type}</td>
                          <td>
                            {v.value}
                            {v.valueSecondary != null ? `/${v.valueSecondary}` : ''} {v.unit ?? ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {hasAnyItems && (
              <div className="form-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={commit}
                  disabled={phase === 'committing' || selectedCount === 0 || hasDateGaps}
                >
                  {phase === 'committing' ? 'Saving…' : `Save selected (${selectedCount})`}
                </button>
                <button type="button" className="btn-secondary" onClick={reset} disabled={phase === 'committing'}>
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </AppGate>
  )
}
