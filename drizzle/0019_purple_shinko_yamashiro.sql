CREATE TABLE "resource_absences" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"recorded_by" text NOT NULL,
	"recorded_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "billable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "type" text DEFAULT 'Delivery' NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_absences" ADD CONSTRAINT "resource_absences_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_absences_resource_id_idx" ON "resource_absences" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "resource_absences_resource_start_idx" ON "resource_absences" USING btree ("resource_id","start_date");