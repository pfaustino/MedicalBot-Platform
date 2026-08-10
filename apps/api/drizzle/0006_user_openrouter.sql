ALTER TABLE "profiles" ADD COLUMN "openrouter_api_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "openrouter_configured_at" timestamp with time zone;
