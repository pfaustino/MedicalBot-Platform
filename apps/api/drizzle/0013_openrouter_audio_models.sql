ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "openrouter_model_tts" text;
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "openrouter_model_stt" text;
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "openrouter_tts_voice" text;
