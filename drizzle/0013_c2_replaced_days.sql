ALTER TABLE "assignment_months" ADD COLUMN "replaced_days" jsonb;--> statement-breakpoint
ALTER TABLE "assignment_months" DROP COLUMN "replaced_hours";