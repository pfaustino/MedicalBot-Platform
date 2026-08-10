import type { FastifyInstance } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  IMAGING_MODALITIES,
  METRIC_TYPES,
  enrichLabResult,
  imagingMeasurementSchema,
  imagingFindingSchema,
  extractedDiagnosisSchema,
  LAB_FLAGS,
  normalizeMetricInput,
} from '@medbot/shared'
import { isOpenRouterConfigured } from '../lib/openrouter-settings.js'
import { db, schema } from '../db/index.js'
import { extractDocument } from '../ai/extract-document.js'
import { openRouterUserMessage } from '../ai/openrouter.js'
import { requireUser } from './auth.js'

/**
 * Document import: upload a lab report / prescription / visit summary as a PDF or
 * image, have a vision model extract structured candidates, and — only after the
 * user reviews and confirms — write them into labs, medications, and vitals.
 * Parse and commit are separate steps on purpose: nothing is written until the
 * user approves it.
 */

const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
])
const MAX_BYTES = 15 * 1024 * 1024
const MED_FORMS = new Set([
  'tablet',
  'capsule',
  'liquid',
  'injection',
  'inhaler',
  'patch',
  'topical',
  'other',
])

const toDate = (s: string | null | undefined): Date | null => {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(+d) ? null : d
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  // Base64 data URLs are large, so this route gets a bigger body limit.
  app.post('/import/parse', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    const userId = request.session.userId!
    if (!(await isOpenRouterConfigured(userId))) {
      return reply.code(503).send({
        error: 'Add your OpenRouter API key in Settings to enable document import.',
        configured: false,
      })
    }
    const body = request.body as { filename?: string; mimeType?: string; dataUrl?: string }
    const { filename, mimeType, dataUrl } = body
    if (!mimeType || !ALLOWED_TYPES.has(mimeType)) {
      return reply.code(400).send({ error: 'Upload a PDF, PNG, JPG, or WebP file.' })
    }
    if (!dataUrl || !dataUrl.startsWith('data:')) {
      return reply.code(400).send({ error: 'Missing file data.' })
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    if ((base64.length * 3) / 4 > MAX_BYTES) {
      return reply.code(413).send({ error: 'File is too large (max 15 MB).' })
    }

    try {
      const extracted = await extractDocument({
        userId,
        filename: filename ?? 'document',
        mimeType,
        dataUrl,
      })
      return reply.send(extracted)
    } catch (err) {
      request.log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'Document parse failed')
      const message =
        openRouterUserMessage(err) ??
        'Could not read that document. Try a clearer scan or a different file.'
      return reply.code(502).send({ error: message })
    }
  })

  const commitBody = z.object({
    sourceDocument: z.string().max(300).nullish(),
    labResults: z
      .array(
        z.object({
          testName: z.string().min(1),
          value: z.string().min(1),
          unit: z.string().nullish(),
          referenceText: z.string().nullish(),
          flag: z.enum(LAB_FLAGS).nullish(),
          panelName: z.string().nullish(),
          loinc: z.string().nullish(),
          collectedAt: z.string().min(1, 'Collection date is required'),
        }),
      )
      .default([]),
    medications: z
      .array(
        z.object({
          name: z.string().min(1),
          dose: z.string().nullish(),
          form: z.string().nullish(),
          frequency: z.string().nullish(),
          purpose: z.string().nullish(),
        }),
      )
      .default([]),
    vitals: z
      .array(
        z.object({
          type: z.enum(METRIC_TYPES),
          value: z.number(),
          valueSecondary: z.number().nullish(),
          unit: z.string().nullish(),
          at: z.string().min(1, 'Date is required'),
        }),
      )
      .default([]),
    imagingReport: z
      .object({
        modality: z.enum(IMAGING_MODALITIES).default('other'),
        title: z.string().min(1),
        examAt: z.string().nullish(),
        signedAt: z.string().nullish(),
        facility: z.string().nullish(),
        referringPhysician: z.string().nullish(),
        readingPhysician: z.string().nullish(),
        indication: z.string().nullish(),
        comparisonNote: z.string().nullish(),
        measurements: z.array(imagingMeasurementSchema).default([]),
        findings: z.array(imagingFindingSchema).default([]),
        conclusions: z.array(z.string().min(1)).default([]),
        diagnoses: z.array(extractedDiagnosisSchema).default([]),
      })
      .nullish(),
  })

  app.post('/import/commit', async (request, reply) => {
    const parsed = commitBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid selection', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const { labResults, medications, vitals, sourceDocument, imagingReport } = parsed.data
    let imagingAdded = 0

    await db.transaction(async (tx) => {
      for (const lab of labResults) {
        const enriched = enrichLabResult({
          ...lab,
          sourceDocument: sourceDocument ?? null,
        })
        const collectedAt = toDate(enriched.collectedAt)
        if (!collectedAt) continue
        await tx.insert(schema.labResults).values({
          userId,
          testName: enriched.testName,
          loinc: enriched.loinc,
          value: enriched.value,
          unit: enriched.unit,
          collectedAt,
          referenceLow: enriched.referenceLow != null ? String(enriched.referenceLow) : null,
          referenceHigh: enriched.referenceHigh != null ? String(enriched.referenceHigh) : null,
          referenceText: enriched.referenceText,
          flag: enriched.flag,
          panelName: enriched.panelName,
          note: enriched.note,
          sourceDocument: enriched.sourceDocument,
        })
        const n = Number(enriched.value)
        if (Number.isFinite(n)) {
          await tx.insert(schema.metrics).values({
            userId,
            type: 'lab_value',
            value: String(n),
            unit: enriched.unit ?? 'varies',
            recordedAt: collectedAt,
            source: 'lab_upload',
            context: enriched.testName,
            note: enriched.referenceText ?? enriched.note ?? null,
          })
        }
      }

      for (const med of medications) {
        const form = med.form && MED_FORMS.has(med.form.toLowerCase()) ? med.form.toLowerCase() : 'other'
        await tx.insert(schema.medications).values({
          userId,
          name: med.name,
          dose: med.dose ?? 'as directed',
          form,
          schedule: {
            kind: 'as_needed',
            times: [],
            intervalHours: null,
            daysOfWeek: [],
            cycleOnDays: null,
            cycleOffDays: null,
            withFood: false,
            instructions: med.frequency ?? null,
          },
          purpose: med.purpose ?? null,
        })
      }

      for (const v of vitals) {
        const recordedAt = toDate(v.at)
        if (!recordedAt) continue
        const entry = normalizeMetricInput({
          type: v.type as never,
          value: v.value,
          valueSecondary: v.valueSecondary ?? null,
          recordedAt,
        })
        await tx.insert(schema.metrics).values({
          userId,
          type: entry.type,
          value: String(entry.value),
          valueSecondary: entry.valueSecondary == null ? null : String(entry.valueSecondary),
          unit: entry.unit,
          recordedAt: entry.recordedAt,
          source: 'lab_upload',
          context: null,
        })
      }

      if (imagingReport) {
        const examAt = toDate(imagingReport.examAt)
        await tx.insert(schema.imagingReports).values({
          userId,
          modality: imagingReport.modality,
          title: imagingReport.title,
          examAt,
          signedAt: toDate(imagingReport.signedAt),
          facility: imagingReport.facility ?? null,
          referringPhysician: imagingReport.referringPhysician ?? null,
          readingPhysician: imagingReport.readingPhysician ?? null,
          indication: imagingReport.indication ?? null,
          comparisonNote: imagingReport.comparisonNote ?? null,
          measurements: imagingReport.measurements.map((m) => ({
            name: m.name,
            value: m.value,
            unit: m.unit ?? null,
            indexValue: m.indexValue ?? null,
            indexUnit: m.indexUnit ?? null,
            category: m.category ?? null,
          })),
          findings: imagingReport.findings.map((f) => ({
            section: f.section,
            text: f.text,
          })),
          conclusions: imagingReport.conclusions,
          diagnoses: imagingReport.diagnoses.map((d) => ({
            name: d.name,
            icdCode: d.icdCode ?? null,
          })),
          sourceDocument: sourceDocument ?? null,
        })
        imagingAdded = 1

        for (const m of imagingReport.measurements) {
          const displayValue = m.indexValue ? `${m.value} (index ${m.indexValue} ${m.indexUnit ?? ''})`.trim() : m.value
          const n = Number.parseFloat(m.value.replace(/[^\d.-]/g, ''))
          await tx.insert(schema.labResults).values({
            userId,
            testName: m.name,
            value: displayValue,
            unit: m.unit,
            collectedAt: examAt,
            flag: 'normal',
            panelName: imagingReport.title,
            note: m.category,
            sourceDocument: sourceDocument ?? null,
          })
          if (Number.isFinite(n)) {
            await tx.insert(schema.metrics).values({
              userId,
              type: 'lab_value',
              value: String(n),
              unit: m.unit ?? 'varies',
              recordedAt: examAt ?? new Date(),
              source: 'lab_upload',
              context: m.name,
              note: imagingReport.title,
            })
          }
        }
      }
    })

    return reply.send({
      ok: true,
      labsAdded: labResults.length,
      medsAdded: medications.length,
      vitalsAdded: vitals.length,
      imagingAdded,
    })
  })

  app.get('/imaging-reports', async (request, reply) => {
    const userId = request.session.userId!
    const rows = await db
      .select()
      .from(schema.imagingReports)
      .where(eq(schema.imagingReports.userId, userId))
      .orderBy(desc(schema.imagingReports.examAt))
      .limit(100)
    return reply.send({ imagingReports: rows })
  })

  app.get('/lab-results', async (request, reply) => {
    const userId = request.session.userId!
    const rows = await db
      .select()
      .from(schema.labResults)
      .where(eq(schema.labResults.userId, userId))
      .orderBy(desc(schema.labResults.collectedAt))
      .limit(500)
    return reply.send({ labResults: rows })
  })
}
