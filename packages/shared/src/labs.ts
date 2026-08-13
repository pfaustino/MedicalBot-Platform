import { z } from 'zod'
import {
  getLabReference,
  interpretLabValue,
  LAB_GLOSSARY,
  type LabFlag,
} from './reference/lab-glossary.js'
import { resolvePanelComponent } from './reference/lab-panels.js'

export const LAB_FLAGS = [
  'normal',
  'low',
  'high',
  'critical_low',
  'critical_high',
  'abnormal',
] as const
export type LabFlagValue = (typeof LAB_FLAGS)[number]

export const LAB_DOCUMENT_TYPES = [
  'lab_report',
  'lab_trends',
  'prescription',
  'visit_summary',
  'imaging_report',
  'immunization',
  'other',
] as const
export type LabDocumentType = (typeof LAB_DOCUMENT_TYPES)[number]

/** Structured lab row — mirrors `lab_results` table and import extraction. */
export const labResultInputSchema = z.object({
  testName: z.string().min(1),
  loinc: z.string().nullish(),
  value: z.string().min(1),
  unit: z.string().nullish(),
  collectedAt: z.string().nullish(),
  referenceText: z.string().nullish(),
  referenceLow: z.number().nullish(),
  referenceHigh: z.number().nullish(),
  flag: z.enum(LAB_FLAGS).nullish(),
  panelName: z.string().nullish(),
  orderingProvider: z.string().nullish(),
  performingLab: z.string().nullish(),
  note: z.string().nullish(),
  sourceDocument: z.string().nullish(),
})
export type LabResultInput = z.infer<typeof labResultInputSchema>

export interface ParsedReferenceRange {
  low: number | null
  high: number | null
  unit: string | null
  referenceText: string
}

/**
 * Parse a printed reference range from portal PDFs, e.g.
 * "135 - 146 mmol/L", "7 - 22 mg/dL", "0.60 - 1.30 mg/dL".
 */
export function parseReferenceRange(text: string | null | undefined): ParsedReferenceRange | null {
  if (!text?.trim()) return null
  const referenceText = text.trim().replace(/\s+/g, ' ')

  if (/see\s+(gfr|comment|note)/i.test(referenceText)) {
    return { low: null, high: null, unit: null, referenceText }
  }

  const match = referenceText.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(.*)?/)
  if (!match) {
    return { low: null, high: null, unit: null, referenceText }
  }

  const unit = match[3]?.trim().replace(/\s+/g, ' ') || null
  return {
    low: Number(match[1]),
    high: Number(match[2]),
    unit: unit || null,
    referenceText,
  }
}

export function findLabReference(testName: string) {
  const exact = getLabReference(testName)
  if (exact) return exact

  const q = testName.trim().toLowerCase()
  return LAB_GLOSSARY.find(
    (t) =>
      t.name.toLowerCase() === q ||
      t.aliases.some((a) => {
        const al = a.toLowerCase()
        return al === q || q.includes(al) || al.includes(q)
      }),
  )
}

/** Glossary name when we recognize the test; otherwise the original string. */
export function canonicalLabName(testName: string): string {
  return findLabReference(testName)?.name ?? testName.trim()
}

export function labContextMatches(stored: string | null | undefined, wanted: string): boolean {
  if (!stored?.trim()) return false
  return canonicalLabName(stored).toLowerCase() === canonicalLabName(wanted).toLowerCase()
}

/** Names and aliases to match a lab filter against stored metrics.context. */
export function labContextNames(wanted: string): string[] {
  const ref = findLabReference(wanted)
  if (!ref) return [wanted]
  return [...new Set([ref.name, ...ref.aliases])]
}

export function inferLabFlag(
  value: string,
  range?: { low?: number | null; high?: number | null },
): LabFlag | null {
  if (/see\s+comment/i.test(value)) return 'abnormal'
  const n = Number(value)
  if (!Number.isFinite(n) || !range) return null
  if (range.low != null && n < range.low) return 'low'
  if (range.high != null && n > range.high) return 'high'
  return 'normal'
}

export function normalizeLabFlag(flag: string | null | undefined): LabFlagValue {
  const f = flag?.trim().toLowerCase()
  if (f === 'low' || f === 'critical_low') return f
  if (f === 'high' || f === 'critical_high') return f
  if (f === 'abnormal') return 'abnormal'
  return 'normal'
}

/** Fill LOINC, parsed ranges, units, and flags from panel + glossary knowledge. */
export function enrichLabResult(input: LabResultInput) {
  const component = resolvePanelComponent(input.testName)
  const glossary = findLabReference(input.testName)
  const testName = component?.name ?? glossary?.name ?? input.testName.trim()
  const loinc = input.loinc ?? component?.loinc ?? glossary?.loinc ?? null

  const parsed = parseReferenceRange(input.referenceText)
  const referenceLow = input.referenceLow ?? parsed?.low ?? null
  const referenceHigh = input.referenceHigh ?? parsed?.high ?? null
  const referenceText = parsed?.referenceText ?? input.referenceText ?? null
  const unit = input.unit ?? parsed?.unit ?? component?.defaultUnit ?? glossary?.unit ?? null

  let flag = input.flag ? normalizeLabFlag(input.flag) : null
  if (!flag) {
    const qualitative = inferLabFlag(input.value, { low: referenceLow, high: referenceHigh })
    if (qualitative) flag = qualitative
  }
  const n = Number(input.value)
  if (!flag && Number.isFinite(n)) {
    if (glossary) {
      flag = interpretLabValue(glossary, n, null, {
        low: referenceLow ?? undefined,
        high: referenceHigh ?? undefined,
      }).flag
    } else {
      const fromReport = inferLabFlag(input.value, { low: referenceLow, high: referenceHigh })
      if (fromReport) flag = fromReport
    }
  }
  if (!flag) flag = 'normal'

  const note =
    input.note ??
    (/see\s+comment/i.test(input.value) ? 'See comment on lab report' : null)

  return {
    testName,
    loinc,
    value: input.value.trim(),
    unit: unit || null,
    collectedAt: input.collectedAt ?? null,
    referenceText,
    referenceLow,
    referenceHigh,
    flag,
    panelName: input.panelName ?? null,
    orderingProvider: input.orderingProvider ?? null,
    performingLab: input.performingLab ?? null,
    note,
    sourceDocument: input.sourceDocument ?? null,
  }
}
