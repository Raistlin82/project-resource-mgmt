ALTER TABLE "assignments" ADD COLUMN "approval_id" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "staffed_effort_planned" double precision;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "utilization_planned" double precision;--> statement-breakpoint
UPDATE "assignments" SET "status" = 'Allocated' WHERE "status" IN ('hard-booked', 'soft-booked');