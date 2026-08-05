CREATE TABLE "cost_baselines" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"period" text NOT NULL,
	"amount" double precision NOT NULL,
	"frozen_at" text NOT NULL,
	"frozen_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_baselines" ADD CONSTRAINT "cost_baselines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_baselines_project_id_idx" ON "cost_baselines" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "cost_baselines_project_period_idx" ON "cost_baselines" USING btree ("project_id","period");