CREATE TABLE "assignment_days" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"date" text NOT NULL,
	"hours" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planning_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "contract_hours_per_day" double precision;--> statement-breakpoint
ALTER TABLE "assignment_days" ADD CONSTRAINT "assignment_days_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_days_assignment_id_idx" ON "assignment_days" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "assignment_days_date_idx" ON "assignment_days" USING btree ("date");