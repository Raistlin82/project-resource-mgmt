CREATE TABLE "negotiated_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text,
	"project_id" text,
	"role" text NOT NULL,
	"currency" text NOT NULL,
	"bill_rate" double precision NOT NULL
);
--> statement-breakpoint
ALTER TABLE "negotiated_rates" ADD CONSTRAINT "negotiated_rates_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiated_rates" ADD CONSTRAINT "negotiated_rates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "negotiated_rates_contract_id_idx" ON "negotiated_rates" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "negotiated_rates_project_id_idx" ON "negotiated_rates" USING btree ("project_id");