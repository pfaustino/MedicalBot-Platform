import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { StoredModuleConfig } from '@medbot/shared'

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for password-only accounts (e.g. bootstrapped admin). */
    googleId: text('google_id'),
    email: text('email').notNull(),
    /** bcrypt hash — used for admin/owner password login. */
    passwordHash: text('password_hash'),
    /** Set on bootstrap login; cleared after the user picks a new password. */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    /**
     * Access level. 'owner' is the software operator (bootstrapped from
     * OWNER_EMAIL), 'admin' is a trusted advanced user the owner promotes, and
     * everyone else is 'user'. Authorization is always checked server-side.
     */
    role: text('role').notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Set when the user completes intake; gates the rest of the app.
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    // Terms acceptance — required before using the Service; re-prompt on version bump.
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
    termsVersion: text('terms_version'),
    /**
     * Marks seeded exploration accounts. Every other table cascades from users,
     * so the master reset is a single delete on this flag — no per-row tagging
     * and nothing left orphaned.
     */
    isDemo: boolean('is_demo').notNull().default(false),
  },
  (t) => [
    uniqueIndex('users_google_id_idx').on(t.googleId),
    uniqueIndex('users_email_idx').on(t.email),
  ],
)

export const profiles = pgTable('profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  /** Google profile photo URL when signed in with Google; null for password-only accounts. */
  avatarUrl: text('avatar_url'),
  dateOfBirth: date('date_of_birth'),
  sexAtBirth: text('sex_at_birth'),
  heightCm: numeric('height_cm', { precision: 5, scale: 1 }),
  timezone: text('timezone').notNull().default('America/New_York'),
  allergies: jsonb('allergies').$type<string[]>().notNull().default([]),
  emergencyContactName: text('emergency_contact_name'),
  emergencyContactPhone: text('emergency_contact_phone'),
  preferredPharmacy: text('preferred_pharmacy'),
  /** Per-user OpenRouter key, encrypted at rest — see src/lib/crypto.ts. */
  openrouterApiKeyEncrypted: text('openrouter_api_key_encrypted'),
  openrouterConfiguredAt: timestamp('openrouter_configured_at', { withTimezone: true }),
  openrouterBaseUrl: text('openrouter_base_url'),
  openrouterModelChat: text('openrouter_model_chat'),
  openrouterModelExtract: text('openrouter_model_extract'),
  openrouterModelAnalyze: text('openrouter_model_analyze'),
  openrouterModelVision: text('openrouter_model_vision'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const careTeam = pgTable(
  'care_team',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role').notNull(),
    organization: text('organization'),
    phone: text('phone'),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('care_team_user_idx').on(t.userId)],
)

export const conditions = pgTable(
  'conditions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Module key, `icd:…`, or `custom:…` — see @medbot/shared buildConditionKey.
    key: text('key').notNull(),
    displayName: text('display_name'),
    icdCode: text('icd_code'),
    diagnosedAt: date('diagnosed_at'),
    status: text('status').notNull().default('active'),
    managingProviderId: uuid('managing_provider_id').references(() => careTeam.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    /**
     * Dynamic tracking module for diagnoses without a code module in
     * @medbot/conditions. Shape: StoredModuleConfig from @medbot/shared.
     */
    moduleConfig: jsonb('module_config').$type<StoredModuleConfig>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conditions_user_key_idx').on(t.userId, t.key)],
)

/**
 * One row per observation, every metric type. Kept generic on purpose — see
 * SPEC.md §2.3. The (user, type, recorded_at) index carries every trend query.
 */
export const metrics = pgTable(
  'metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    value: numeric('value', { precision: 10, scale: 2 }).notNull(),
    valueSecondary: numeric('value_secondary', { precision: 10, scale: 2 }),
    unit: text('unit').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    source: text('source').notNull().default('manual'),
    context: text('context'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('metrics_user_type_time_idx').on(t.userId, t.type, t.recordedAt),
    index('metrics_user_time_idx').on(t.userId, t.recordedAt),
  ],
)

export const medications = pgTable(
  'medications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    rxcui: text('rxcui'),
    dose: text('dose').notNull(),
    form: text('form').notNull().default('tablet'),
    schedule: jsonb('schedule').notNull(),
    purpose: text('purpose'),
    prescriber: text('prescriber'),
    pharmacy: text('pharmacy'),
    startedAt: date('started_at'),
    endedAt: date('ended_at'),
    refillsRemaining: integer('refills_remaining'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('medications_user_active_idx').on(t.userId, t.isActive)],
)

/** Highest-value signal in the system for psychiatric and diabetic users. */
export const adherenceEvents = pgTable(
  'adherence_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    medicationId: uuid('medication_id')
      .notNull()
      .references(() => medications.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
  },
  (t) => [
    index('adherence_user_time_idx').on(t.userId, t.scheduledFor),
    uniqueIndex('adherence_med_slot_idx').on(t.medicationId, t.scheduledFor),
  ],
)

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Set once synced to Google Calendar; null means app-only so far.
    googleEventId: text('google_event_id'),
    title: text('title').notNull(),
    type: text('type').notNull().default('office_visit'),
    providerId: uuid('provider_id').references(() => careTeam.id, { onDelete: 'set null' }),
    location: text('location'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    prepNotes: text('prep_notes'),
    visitNotes: text('visit_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('appointments_user_time_idx').on(t.userId, t.startsAt)],
)

/**
 * Personal follow-ups — manual entries plus action items pulled from document
 * import (labs to schedule, referrals, med changes, appointments to book).
 */
export const todos = pgTable(
  'todos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    notes: text('notes'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    // open | done | cancelled
    status: text('status').notNull().default('open'),
    // manual | import
    source: text('source').notNull().default('manual'),
    sourceDocument: text('source_document'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('todos_user_status_idx').on(t.userId, t.status)],
)

export const questionnaireResponses = pgTable(
  'questionnaire_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionnaireKey: text('questionnaire_key').notNull(),
    answers: jsonb('answers').$type<Record<string, number | string | boolean>>().notNull(),
    score: integer('score'),
    band: text('band'),
    criticalTriggered: jsonb('critical_triggered').$type<string[]>().notNull().default([]),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('questionnaire_user_key_time_idx').on(t.userId, t.questionnaireKey, t.completedAt)],
)

/**
 * Structured lab results, typically parsed from an uploaded report and confirmed
 * by the user. Mirrors labResultSchema in @medbot/shared. Numeric results are
 * also mirrored into `metrics` (type lab_value) so they trend on the charts.
 */
export const labResults = pgTable(
  'lab_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    testName: text('test_name').notNull(),
    loinc: text('loinc'),
    // Text because a result can be numeric or qualitative ("positive", "<5").
    value: text('value').notNull(),
    unit: text('unit'),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    referenceLow: numeric('reference_low', { precision: 12, scale: 3 }),
    referenceHigh: numeric('reference_high', { precision: 12, scale: 3 }),
    referenceText: text('reference_text'),
    // normal | low | high | critical_low | critical_high | abnormal
    flag: text('flag').notNull().default('normal'),
    orderingProvider: text('ordering_provider'),
    performingLab: text('performing_lab'),
    panelName: text('panel_name'),
    note: text('note'),
    // Provenance without storing the file itself: just the source filename.
    sourceDocument: text('source_document'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lab_results_user_time_idx').on(t.userId, t.collectedAt)],
)

/**
 * Structured imaging reports (echo, CT, MRI, etc.) parsed from uploaded PDFs.
 * Measurements, findings, conclusions, and diagnoses are stored as JSON arrays.
 */
export const imagingReports = pgTable(
  'imaging_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    modality: text('modality').notNull().default('other'),
    title: text('title').notNull(),
    examAt: timestamp('exam_at', { withTimezone: true }),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    facility: text('facility'),
    referringPhysician: text('referring_physician'),
    readingPhysician: text('reading_physician'),
    indication: text('indication'),
    comparisonNote: text('comparison_note'),
    diagnoses: jsonb('diagnoses')
      .$type<Array<{ name: string; icdCode: string | null }>>()
      .notNull()
      .default([]),
    measurements: jsonb('measurements')
      .$type<
        Array<{
          name: string
          value: string
          unit: string | null
          indexValue: string | null
          indexUnit: string | null
          category: string | null
        }>
      >()
      .notNull()
      .default([]),
    findings: jsonb('findings')
      .$type<Array<{ section: string; text: string }>>()
      .notNull()
      .default([]),
    conclusions: jsonb('conclusions').$type<string[]>().notNull().default([]),
    sourceDocument: text('source_document'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('imaging_reports_user_time_idx').on(t.userId, t.examAt)],
)

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    // Which OpenRouter model produced this, for assistant turns.
    model: text('model'),
    toolCalls: jsonb('tool_calls').$type<unknown[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversations_user_time_idx').on(t.userId, t.createdAt)],
)

/**
 * Google OAuth tokens. Refresh tokens are encrypted at rest — see
 * src/lib/crypto.ts. Never select this table into a log line.
 */
export const googleAccounts = pgTable('google_accounts', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token').notNull(),
  refreshTokenEncrypted: text('refresh_token_encrypted'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Cookie session persistence — survives API redeploys (unlike in-memory store). */
export const sessions = pgTable(
  'sessions',
  {
    sid: text('sid').primaryKey(),
    sess: jsonb('sess').$type<Record<string, unknown>>().notNull(),
    expire: timestamp('expire', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_expire_idx').on(t.expire)],
)
