CREATE TABLE "assignment_months" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"month" text NOT NULL,
	"status" text NOT NULL,
	"approval_id" text,
	"planner_note" text,
	"approver_note" text
);
--> statement-breakpoint
ALTER TABLE "assignment_months" ADD CONSTRAINT "assignment_months_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_months_assignment_id_idx" ON "assignment_months" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "assignment_months_month_idx" ON "assignment_months" USING btree ("month");