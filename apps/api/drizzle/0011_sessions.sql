CREATE TABLE IF NOT EXISTS "sessions" (
  "sid" text PRIMARY KEY NOT NULL,
  "sess" jsonb NOT NULL,
  "expire" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_expire_idx" ON "sessions" ("expire");
