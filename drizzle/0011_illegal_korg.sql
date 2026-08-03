ALTER TABLE "resources" ADD COLUMN "kind" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "vendor_id" text;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;