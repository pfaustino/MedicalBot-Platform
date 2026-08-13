ALTER TABLE "medications" ADD COLUMN IF NOT EXISTS "google_event_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;
