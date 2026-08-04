ALTER TABLE "resource_organizations" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "resource_organizations" ADD COLUMN "level" text DEFAULT 'capability' NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_organizations" ADD COLUMN "manager_id" text;--> statement-breakpoint
CREATE INDEX "resource_organizations_parent_id_idx" ON "resource_organizations" USING btree ("parent_id");