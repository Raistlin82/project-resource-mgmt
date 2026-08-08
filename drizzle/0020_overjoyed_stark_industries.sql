ALTER TABLE "resources" ADD COLUMN "code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "resources_person_code_unique_idx" ON "resources" USING btree ("code") WHERE "resources"."code" ~ '^[A-Z]{6}[0-9]{6}$';--> statement-breakpoint
CREATE INDEX "resources_code_idx" ON "resources" USING btree ("code");