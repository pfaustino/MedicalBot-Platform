# MedicalBot Platform

A personal health management assistant. Tracks health metrics, medications and adherence,
appointments, and standardized assessments; talks to the user in natural language; and
integrates with Google Workspace for calendar, reminders, and health records.

**It does not diagnose, prescribe, or adjust doses.** That boundary is enforced in code —
see [Safety](#safety) — not just stated in a disclaimer.

The full design is in [SPEC.md](SPEC.md). This README covers running it.

**Collaborating?** See [CONTRIBUTING.md](CONTRIBUTING.md) — pull before you push, use feature branches, rebuild shared packages after pulls.

## Status

**Phase 1 of 6 — foundation.** Working: monorepo, database schema, Google OAuth login,
metric ingestion with condition-aware threshold detection, and the OpenRouter client. Not
built yet: the conversational agent, calendar sync, the questionnaire UI, and the
dashboard. See [docs/phases/](docs/phases/) for the full build plan.

## Layout

```
apps/
  api/         Fastify API — auth, metrics, AI layer, database schema
  web/         Next.js frontend (placeholder shell for now)
packages/
  shared/      Domain types, Zod schemas, questionnaires
  conditions/  Condition modules — diabetes, schizophrenia
tests/         Scoring and condition-merge tests
```

### Why conditions are their own package

A condition module declares what a diagnosis means operationally: which metrics to track,
what the target bands are, which questionnaires to schedule, and what counts as a red
flag. Diabetes is data-dense and numeric; schizophrenia is adherence- and sleep-driven.
Adding CHF or epilepsy is a new file in `packages/conditions/src`, not a change to the
core. When a user has several conditions, `mergedMetrics()` takes the stricter target band
from each.

## Running locally

You need Node 20+ and a Postgres instance.

```bash
npm install
cp .env.example .env     # then fill it in — see below
npm run db:generate      # generate migrations from the schema
npm run db:migrate       # apply them
npm run dev:api          # http://localhost:3001
npm run dev:web          # http://localhost:3000
```

Check it came up:

```bash
curl http://localhost:3001/health
# {"status":"ok","checks":{"database":true,"google":false,"openrouter":false}}
```

`degraded` means the database ping failed. The `google` and `openrouter` flags just report
whether those keys are set — the API runs without them, with those features disabled.

### Environment

Required to boot: `DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`. The config module
validates everything at startup and exits with a specific message rather than failing on
the first request that needs a missing value.

Generate the two secrets:

```bash
openssl rand -hex 32    # SESSION_SECRET
openssl rand -hex 32    # ENCRYPTION_KEY — must be exactly 64 hex chars
```

`ENCRYPTION_KEY` encrypts Google refresh tokens at rest (AES-256-GCM). **Changing it makes
existing stored tokens undecryptable** and forces every user to reconnect Google.

Google OAuth: create credentials at
[console.cloud.google.com](https://console.cloud.google.com) → APIs & Services →
Credentials, and set the redirect URI to match `GOOGLE_REDIRECT_URI`.

### Model routing

Four task classes route to separately configurable models, so you can tune cost and
quality independently without a code change:

| Variable | Used for |
|---|---|
| `MODEL_CHAT` | Conversation — quality matters most |
| `MODEL_EXTRACT` | Parsing "sugar was 142 before dinner" into a row. High volume, cheap |
| `MODEL_ANALYZE` | Trend analysis and the weekly digest. Runs in a job, latency-tolerant |

## Testing

```bash
npm test
```

Coverage is concentrated on the logic that's easy to get subtly wrong: questionnaire
scoring and banding, and the target-band merge for users with multiple conditions.

## Scope

**No message screening.** The app does not scan what you type for crisis keywords and does
not interject helpline numbers. Adults tracking their own health don't need their logging
app triaging them, and one that cries wolf on routine entries stops getting used.

**Condition thresholds do fire, and that's the product.** Every metric written is checked
against the thresholds its condition modules declare, with occurrence counting over a
window so one outlier doesn't trip a multi-reading rule. A glucose reading of 48 tells you
it's low and what to do about it. These run on data you chose to record against a
condition you told the app you have, and they say something specific — they aren't generic
referrals.

**No dose changes.** There is deliberately no tool that alters a medication. Each condition
module contributes its own guardrails to the system prompt.

## Deploying to Railway

Use **one app service** plus **Postgres** and **Redis** plugins in a single Railway
project. The root `railway.json` runs `npm ci && npm run build` (API + static Next
export) and starts the API with `npm run start`. The API serves the exported web app from
`apps/web/out` on the same origin, so session cookies work without a separate web
service.

1. Connect this repo to one Railway service (repo root — do **not** set the root
   directory to `apps/web` or `apps/api`).
2. Railway auto-detects root `railway.json`; healthcheck is `/health`.
3. Add Postgres and Redis plugins; reference `DATABASE_URL` and `REDIS_URL` on the app
   service.
4. Set the environment variables from `.env.example`. Set `APP_URL` to this service's
   public URL (for OAuth redirects).

If you have a leftover `@medbot/web` service from an older two-service template, delete it —
it is redundant and will fail or duplicate the API.

Use a separate Railway environment for staging. Never point staging at production data.

## Before this holds anyone else's data

If this stays a personal tool, HIPAA does not attach. The moment it serves another
person's health data it does, and that means a BAA with Railway, a BAA with every AI
provider in the request path (OpenRouter fans out to downstream providers — this is the
hard one), audit logging, and breach procedures. **Decide which product this is before
building further**, because it changes hosting, model routing, and logging.

Independent of HIPAA, already true here: secrets stay out of git, PHI is redacted from
logs at the Fastify logger, refresh tokens are encrypted at rest, and Gmail content is
treated as untrusted input that never reaches the tool-calling agent directly.
