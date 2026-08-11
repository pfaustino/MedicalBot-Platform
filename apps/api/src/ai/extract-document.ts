import { complete, type ChatMessage, type ContentPart } from './openrouter.js'

/**
 * Reads an uploaded health document (lab report, prescription, visit summary,
 * scan) with a vision-capable model and returns STRUCTURED CANDIDATES only.
 * Nothing here writes to the record — the user reviews and confirms first. Parsed
 * content is untrusted (SPEC §6): it becomes suggestions, never actions.
 */

export interface ExtractedLab {
  testName: string
  value: string
  unit: string | null
  referenceText: string | null
  flag: string | null
  panelName: string | null
  loinc: string | null
  collectedAt: string | null
}

export interface ExtractedMed {
  name: string
  dose: string | null
  form: string | null
  frequency: string | null
  purpose: string | null
}

export interface ExtractedVital {
  type: string
  value: number | null
  valueSecondary: number | null
  unit: string | null
  at: string | null
}

export interface ExtractedImagingMeasurement {
  name: string
  value: string
  unit: string | null
  indexValue: string | null
  indexUnit: string | null
  category: string | null
}

export interface ExtractedImagingFinding {
  section: string
  text: string
}

export interface ExtractedDiagnosis {
  name: string
  icdCode: string | null
}

export interface ExtractedTodo {
  title: string
  notes: string | null
  dueAt: string | null
}

export interface ExtractedDocument {
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
  labResults: ExtractedLab[]
  medications: ExtractedMed[]
  vitals: ExtractedVital[]
  imagingMeasurements: ExtractedImagingMeasurement[]
  imagingFindings: ExtractedImagingFinding[]
  imagingConclusions: string[]
  diagnoses: ExtractedDiagnosis[]
  todos: ExtractedTodo[]
  notes: string | null
}

const SYSTEM = `You extract structured data from a personal health document (a lab report, lab trend export, prescription, visit summary, imaging report, or immunization record). You do not diagnose or interpret — you transcribe what is printed, accurately.

Return ONLY a single JSON object, no prose and no code fences, in exactly this shape:
{
  "documentType": "lab_report" | "lab_trends" | "prescription" | "visit_summary" | "imaging_report" | "immunization" | "other",
  "documentDate": string | null,
  "provider": string | null,
  "reportTitle": string | null,
  "resultsFrom": string | null,
  "resultsTo": string | null,
  "imagingModality": "echo" | "ct" | "mri" | "xray" | "ultrasound" | "mammogram" | "dexa" | "pet" | "other" | null,
  "indication": string | null,
  "referringPhysician": string | null,
  "readingPhysician": string | null,
  "signedAt": string | null,
  "comparisonNote": string | null,
  "labResults": [ ... ],
  "medications": [ ... ],
  "vitals": [ ... ],
  "imagingMeasurements": [
    { "name": string, "value": string, "unit": string | null,
      "indexValue": string | null, "indexUnit": string | null,
      "category": string | null }
  ],
  "imagingFindings": [
    { "section": string, "text": string }
  ],
  "imagingConclusions": [ string ],
  "diagnoses": [
    { "name": string, "icdCode": string | null }
  ],
  "todos": [
    { "title": string, "notes": string | null, "dueAt": string | null }
  ],
  "notes": string | null
}

labResults item shape:
{ "testName": string, "value": string, "unit": string | null, "referenceText": string | null,
  "flag": "normal"|"low"|"high"|"critical_low"|"critical_high"|"abnormal"|null,
  "panelName": string | null, "loinc": string | null, "collectedAt": string | null }

medications item shape:
{ "name": string, "dose": string | null, "form": string | null, "frequency": string | null, "purpose": string | null }

vitals item shape:
{ "type": string, "value": number | null, "valueSecondary": number | null, "unit": string | null, "at": string | null }

todos item shape:
{ "title": string, "notes": string | null, "dueAt": string | null }

Rules:
- For "vitals.type" use: blood_pressure, heart_rate, weight, temperature, spo2, blood_glucose. For blood_pressure put systolic in "value" and diastolic in "valueSecondary". Use exam date for "at" when printed.

- **Lab trend reports** (portal "Result Trends", rows = tests, columns = dates): documentType "lab_trends". One labResults row per test per collection date column — not one row per test. Copy High/Low flags. panelName from report title. **collectedAt is REQUIRED on every row** — use the ISO date (YYYY-MM-DD) from that column's header (e.g. "Feb 1, 2023" → "2023-02-01", "Jul 14, 2026" → "2026-07-14"). Never omit collectedAt on trend rows.
- Single lab reports (one draw date): set the same collectedAt on every row from the collection or report date printed on the document.

- **Imaging reports — especially echocardiograms (TTE)**:
  - documentType "imaging_report"; imagingModality "echo" for transthoracic echo.
  - reportTitle: full study name (e.g. "TRANSTHORACIC ECHOCARDIOGRAM REPORT").
  - documentDate: exam date; signedAt: electronic signature date if different.
  - provider: facility name (e.g. imaging center).
  - Extract ALL of the following when present:
    * **imagingMeasurements**: every value in MEASUREMENTS and numeric values embedded in FINDINGS — LVIDd, LVIDs, IVSd, LVPWd, LA size, RA area/volume, TAPSE, RV dimensions, valve velocities, IVC, aorta, EF (including ranges like "50 to 55%"), stroke volume, MV E/A velocities, E/e' ratios, LVOT gradients (rest and Valsalva), height, weight, BSA. Use category for anatomic section (LEFT VENTRICLE, MITRAL VALVE, etc.). Include index values when printed (e.g. indexValue "2.32", indexUnit "cm/m²").
    * **imagingFindings**: one entry per FINDINGS section header (LEFT VENTRICLE, LEFT ATRIUM, RIGHT VENTRICLE, valves, AORTA, IVC, PERICARDIUM, etc.) with the full narrative text under that header.
    * **imagingConclusions**: each numbered conclusion line verbatim, without the number prefix.
    * **diagnoses**: diagnosis line(s) with ICD-10 code when printed (e.g. "Hypertrophic cardiomyopathy", icdCode "I42.2").
    * **comparisonNote**: text comparing to prior study if printed.
    * **indication**, **referringPhysician**, **readingPhysician** when printed.
  - Also put weight and blood_pressure in vitals if printed in the header.

- BMP/CMP lab components: Sodium, BUN, Calcium, Potassium, Chloride, Total CO2, Anion Gap, Glucose, Creatinine, eGFR.

- **Follow-ups / action items (todos)**: extract concrete next steps the patient or care team should take when the document states them — e.g. labs to schedule or repeat, referrals to book, medication changes to start/stop/adjust, appointments to schedule, imaging to obtain, lifestyle instructions framed as tasks. Put each as a short actionable title; put timing/context in notes; put a due/target date in dueAt (ISO YYYY-MM-DD) only when printed. Do not invent follow-ups that are not written or clearly implied as instructions.

- Only include items actually present. Empty arrays are fine.
- Never invent values. If a field is not printed, use null.
- Do not include interpretation, advice, or a diagnosis beyond what is printed on the report.`

const INSTRUCTION =
  'Extract the structured data from this document as JSON, following the schema and rules exactly. For imaging reports, be exhaustive — capture every measurement, finding section, conclusion, and diagnosis printed.'

export async function extractDocument(input: {
  userId: string
  filename: string
  mimeType: string
  dataUrl: string
}): Promise<ExtractedDocument> {
  const isPdf = input.mimeType === 'application/pdf'
  const filePart: ContentPart = isPdf
    ? { type: 'file', file: { filename: input.filename, file_data: input.dataUrl } }
    : { type: 'image_url', image_url: { url: input.dataUrl } }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: [{ type: 'text', text: INSTRUCTION }, filePart] },
  ]

  const res = await complete({
    task: 'vision',
    messages,
    temperature: 0,
    maxTokens: 16384,
    userId: input.userId,
  })
  return normalize(parseJson(res.content))
}

/** Tolerant JSON parse — strips code fences and grabs the outermost object. */
function parseJson(raw: string): Record<string, unknown> {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      } catch {
        /* fall through */
      }
    }
    throw new Error('Model did not return valid JSON')
  }
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() && Number.isFinite(Number(v))
      ? Number(v)
      : null

function normalize(d: Record<string, unknown>): ExtractedDocument {
  const documentType = str(d.documentType) ?? 'other'
  const documentDate = str(d.documentDate)
  const isTrend = documentType === 'lab_trends'

  const labResults = arr(d.labResults)
    .map((r) => r as Record<string, unknown>)
    .filter((r) => str(r.testName))
    .map((r) => ({
      testName: str(r.testName)!,
      value: str(r.value) ?? (num(r.value) !== null ? String(num(r.value)) : ''),
      unit: str(r.unit),
      referenceText: str(r.referenceText),
      flag: str(r.flag),
      panelName: str(r.panelName),
      loinc: str(r.loinc),
      collectedAt: str(r.collectedAt) ?? (!isTrend ? documentDate : null),
    }))

  const vitals = arr(d.vitals)
    .map((r) => r as Record<string, unknown>)
    .filter((r) => str(r.type) && num(r.value) !== null)
    .map((r) => ({
      type: str(r.type)!,
      value: num(r.value),
      valueSecondary: num(r.valueSecondary),
      unit: str(r.unit),
      at: str(r.at) ?? documentDate,
    }))

  return {
    documentType,
    documentDate,
    provider: str(d.provider),
    reportTitle: str(d.reportTitle),
    resultsFrom: str(d.resultsFrom),
    resultsTo: str(d.resultsTo),
    imagingModality: str(d.imagingModality),
    indication: str(d.indication),
    referringPhysician: str(d.referringPhysician),
    readingPhysician: str(d.readingPhysician),
    signedAt: str(d.signedAt),
    comparisonNote: str(d.comparisonNote),
    notes: str(d.notes),
    labResults,
    medications: arr(d.medications)
      .map((r) => r as Record<string, unknown>)
      .filter((r) => str(r.name))
      .map((r) => ({
        name: str(r.name)!,
        dose: str(r.dose),
        form: str(r.form),
        frequency: str(r.frequency),
        purpose: str(r.purpose),
      })),
    vitals,
    imagingMeasurements: arr(d.imagingMeasurements)
      .map((r) => r as Record<string, unknown>)
      .filter((r) => str(r.name) && (str(r.value) || num(r.value) !== null))
      .map((r) => ({
        name: str(r.name)!,
        value: str(r.value) ?? String(num(r.value)),
        unit: str(r.unit),
        indexValue: str(r.indexValue),
        indexUnit: str(r.indexUnit),
        category: str(r.category),
      })),
    imagingFindings: arr(d.imagingFindings)
      .map((r) => r as Record<string, unknown>)
      .filter((r) => str(r.section) && str(r.text))
      .map((r) => ({
        section: str(r.section)!,
        text: str(r.text)!,
      })),
    imagingConclusions: arr(d.imagingConclusions)
      .map((c) => (typeof c === 'string' ? c.trim() : ''))
      .filter(Boolean),
    diagnoses: arr(d.diagnoses)
      .map((r) => r as Record<string, unknown>)
      .filter((r) => str(r.name))
      .map((r) => ({
        name: str(r.name)!,
        icdCode: str(r.icdCode),
      })),
    todos: arr(d.todos)
      .map((r) => r as Record<string, unknown>)
      .filter((r) => str(r.title))
      .map((r) => ({
        title: str(r.title)!,
        notes: str(r.notes),
        dueAt: str(r.dueAt),
      })),
  }
}
