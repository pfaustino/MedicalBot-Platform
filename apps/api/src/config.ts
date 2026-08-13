import { config as loadDotenv } from 'dotenv'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// Load env from repo root and apps/api — npm workspace cwd varies by how dev is started.
const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const repoRoot = join(apiRoot, '../..')
loadDotenv({ path: join(repoRoot, '.env'), override: true })
loadDotenv({ path: join(apiRoot, '.env'), override: true })

/** PGlite on Google Drive corrupts — default local dev to AppData on Windows. */
function defaultDatabaseUrl(): string {
  if (process.platform === 'win32') {
    const dir = join(homedir(), 'AppData', 'Local', 'medbot-pglite').replace(/\\/g, '/')
    return `pglite://${dir}`
  }
  return 'pglite://./.data/medbot'
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_URL: z.string().url().default('http://localhost:3000'),

  // `pglite://<dir>` runs Postgres embedded locally; anything else is a normal
  // connection string. Defaults to embedded so a fresh clone runs with no setup.
  DATABASE_URL: z.string().min(1).default(defaultDatabaseUrl()),
  REDIS_URL: z.string().optional(),

  /**
   * Enables seeded exploration: the demo sign-in route and the reset endpoint.
   * Independent of NODE_ENV so a deployed instance can be explored, but it is
   * off unless set and the server logs loudly when it is on.
   */
  DEMO_MODE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // Validated below rather than here: both are mandatory in production, but get
  // throwaway defaults outside it so a fresh clone boots with no .env at all.
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars').optional(),
  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)')
    .optional(),

  // Trimmed: a trailing space or newline pasted into a Railway variable would
  // otherwise be URL-encoded into the OAuth request and make Google reject it
  // with a generic 400 "malformed request".
  GOOGLE_CLIENT_ID: z.string().trim().optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().optional(),
  GOOGLE_REDIRECT_URI: z.string().trim().url().optional(),

  /**
   * The software operator's Google email. On login this account is promoted to
   * 'owner', which unlocks the admin section and the ability to grant admin to
   * other users. Hardcoded to the initial operator for now; override with the
   * OWNER_EMAIL env var (and eventually manage owners in-app).
   */
  OWNER_EMAIL: z.string().trim().toLowerCase().email().default('travisbollenbach@gmail.com'),

  /**
   * One-time bootstrap credentials for the admin password login. Used only when
   * no admin/owner account has a password_hash yet. The user must change this
   * password on first sign-in.
   */
  BOOTSTRAP_ADMIN_EMAIL: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .optional()
    .or(z.literal(''))
    .transform((v) => (v === '' ? undefined : v)),
  BOOTSTRAP_ADMIN_PASSWORD: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v : undefined))
    .pipe(z.string().min(8).optional()),

  /**
   * USDA FoodData Central. DEMO_KEY works for light personal use; a free key
   * from https://fdc.nal.usda.gov/api-key-signup raises the rate limit.
   */
  USDA_FDC_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : 'DEMO_KEY')),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),

  // Model routing by task class — see SPEC.md §4.1. Swappable without a deploy.
  MODEL_CHAT: z.string().default('anthropic/claude-sonnet-4.5'),
  MODEL_EXTRACT: z.string().default('anthropic/claude-haiku-4.5'),
  MODEL_ANALYZE: z.string().default('anthropic/claude-sonnet-4.5'),
  // Multimodal model for reading uploaded lab reports, prescriptions, and scans.
  // Must accept images and PDFs.
  MODEL_VISION: z.string().default('anthropic/claude-sonnet-4.5'),

  // OpenRouter audio (assistant mic + speak). Same API key as chat.
  MODEL_TTS: z.string().default('mistralai/voxtral-mini-tts-2603'),
  MODEL_STT: z.string().default('openai/whisper-large-v3'),
  TTS_VOICE: z.string().default('en_paul_neutral'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n')
  // Fail loudly at boot rather than at the first request that needs the value.
  console.error(`Invalid environment configuration:\n${issues}`)
  process.exit(1)
}

const env = parsed.data
const inProduction = env.NODE_ENV === 'production'

const googleOAuthConfigured = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI,
)

/**
 * Missing secrets used to exit(1) in production. That is the wrong trade here:
 * the container never binds a port, so every healthcheck fails and the logs say
 * nothing about why. Each secret now gets handled on its own terms.
 *
 * SESSION_SECRET: generate a random one per boot. Cryptographically fine — the
 * only cost is that sessions do not survive a restart, so you sign in again.
 * Never falls back to a hardcoded value in production.
 *
 * ENCRYPTION_KEY: this one is load-bearing, because it encrypts stored Google
 * refresh tokens. Rotating it silently would make existing tokens
 * undecryptable, so it is still fatal in production — but only when Google
 * OAuth is actually configured. With no Google integration, nothing is
 * encrypted and demanding the key is pointless friction.
 */
const DEV_SESSION_SECRET = 'dev-only-session-secret-not-for-production-use'
const DEV_ENCRYPTION_KEY = '0'.repeat(64)

if (inProduction && !env.ENCRYPTION_KEY && googleOAuthConfigured) {
  console.error(
    'ENCRYPTION_KEY is required when Google OAuth is configured: it encrypts stored\n' +
      'refresh tokens, and starting without it would corrupt them on the next rotation.\n' +
      'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  )
  process.exit(1)
}

let sessionSecret = env.SESSION_SECRET
if (!sessionSecret) {
  if (inProduction) {
    sessionSecret = randomBytes(32).toString('hex')
    console.warn(
      '[config] SESSION_SECRET is not set. Generated a random one for this boot —\n' +
        '         sign-ins will not survive a restart or a second instance.\n' +
        '         Set it in your service variables to make sessions stable.',
    )
  } else {
    sessionSecret = DEV_SESSION_SECRET
  }
}

let encryptionKey = env.ENCRYPTION_KEY
if (!encryptionKey) {
  encryptionKey = inProduction ? randomBytes(32).toString('hex') : DEV_ENCRYPTION_KEY
  if (inProduction) {
    console.warn(
      '[config] ENCRYPTION_KEY is not set. Using an ephemeral key. This is only safe\n' +
        '         because Google OAuth is not configured, so nothing is being encrypted.',
    )
  }
}

export const config = {
  ...env,
  SESSION_SECRET: sessionSecret,
  ENCRYPTION_KEY: encryptionKey,
  // Local dev should always offer demo unless explicitly turned off.
  DEMO_MODE: inProduction ? env.DEMO_MODE : env.DEMO_MODE || true,
}
export type Config = typeof config

export const isProduction = inProduction
export const googleConfigured = Boolean(
  config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REDIRECT_URI,
)
export const openRouterConfigured = Boolean(config.OPENROUTER_API_KEY)
