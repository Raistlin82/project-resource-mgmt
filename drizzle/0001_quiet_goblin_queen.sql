ALTER TABLE "change_requests" ADD COLUMN "created_by" text;--> statement-breakpoint
CREATE INDEX "audit_logs_at_idx" ON "audit_logs" USING btree ("at");