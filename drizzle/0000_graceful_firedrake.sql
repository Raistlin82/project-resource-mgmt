CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"project_id" text,
	"amount" double precision,
	"requested_by" text NOT NULL,
	"status" text NOT NULL,
	"steps" jsonb NOT NULL,
	"current_step" integer NOT NULL,
	"created_at" text NOT NULL,
	"sla_due_at" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"assigned_hours" double precision NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"at" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status_code" integer NOT NULL,
	"changed_keys" jsonb,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
CREATE TABLE "billing_plan_items" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"project_id" text,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"milestone_id" text,
	"recurrence" text,
	"expected_date" text,
	"amount" double precision NOT NULL,
	"cap_amount" double precision,
	"progress_pct" double precision,
	"markup_pct" double precision,
	"retention_pct" double precision,
	"tax_rate_pct" double precision,
	"payment_terms_days" integer,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"issued_date" text,
	"due_date" text,
	"paid_date" text,
	"order_id" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"requested_by" text NOT NULL,
	"owner" text NOT NULL,
	"status" text NOT NULL,
	"impact_scope" text NOT NULL,
	"impact_budget" double precision NOT NULL,
	"impact_schedule_days" integer NOT NULL,
	"priority" text NOT NULL,
	"created_at" text NOT NULL,
	"decided_by" text,
	"decided_at" text
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"total_value" double precision NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_centers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"manager" text NOT NULL,
	"allocated" double precision NOT NULL,
	"actual" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"industry" text,
	"country" text
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"currency" text PRIMARY KEY NOT NULL,
	"rate_to_base" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "languages" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"date" text NOT NULL,
	"status" text NOT NULL,
	"approved_by" text,
	"approved_at" text
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"project_id" text NOT NULL,
	"description" text NOT NULL,
	"amount" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"type" text NOT NULL,
	"partner_id" text,
	"amount" double precision NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"order_date" text NOT NULL,
	"invoice_number" text,
	"invoice_date" text
);
--> statement-breakpoint
CREATE TABLE "proficiency_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"levels" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_cost_centers" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"manager" text NOT NULL,
	"allocated" double precision NOT NULL,
	"actual" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"size" text NOT NULL,
	"uploaded_at" text NOT NULL,
	"author" text NOT NULL,
	"author_initials" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_financials" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"category" text NOT NULL,
	"budget" double precision NOT NULL,
	"actual" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"reported_by" text NOT NULL,
	"owner" text,
	"due_date" text,
	"impact" text,
	"action_plan" text,
	"escalated" boolean
);
--> statement-breakpoint
CREATE TABLE "project_partners" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"company" text NOT NULL,
	"role" text NOT NULL,
	"contact" text NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"restricted" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"assignee" text NOT NULL,
	"assignee_type" text,
	"partner_id" text,
	"due_date" text NOT NULL,
	"status" text NOT NULL,
	"priority" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"location" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"status" text NOT NULL,
	"description" text,
	"owner_id" text,
	"contract_id" text
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"required_role" text NOT NULL,
	"required_effort" double precision NOT NULL,
	"staffed_effort" double precision,
	"status" text NOT NULL,
	"skills" jsonb NOT NULL,
	"description" text,
	"start_date" text,
	"end_date" text,
	"requester_id" text,
	"project_id" text
);
--> statement-breakpoint
CREATE TABLE "resource_organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"cost_centers" jsonb NOT NULL,
	"service_organization_id" text
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"skills" jsonb NOT NULL,
	"project_roles" jsonb NOT NULL,
	"external_experience" jsonb NOT NULL,
	"profile_picture" text,
	"resume" text,
	"utilization" double precision NOT NULL,
	"capacity" double precision NOT NULL,
	"manager_id" text,
	"organization" text,
	"location" text,
	"cost_rate" double precision,
	"bill_rate" double precision
);
--> statement-breakpoint
CREATE TABLE "service_organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"cost_centers" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_catalogs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"skills" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"concept_uri" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"catalogs" jsonb NOT NULL,
	"proficiency_set_id" text,
	"restricted" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"request_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"project_id" text NOT NULL,
	"date" text NOT NULL,
	"hours" double precision NOT NULL,
	"status" text NOT NULL,
	"notes" text,
	"approved_by" text,
	"approved_at" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"status" text NOT NULL,
	"progress" double precision NOT NULL,
	"assignee" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_plan_items" ADD CONSTRAINT "billing_plan_items_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_plan_items" ADD CONSTRAINT "billing_plan_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_plan_items" ADD CONSTRAINT "billing_plan_items_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_plan_items" ADD CONSTRAINT "billing_plan_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_partner_id_project_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."project_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cost_centers" ADD CONSTRAINT "project_cost_centers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_financials" ADD CONSTRAINT "project_financials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_issues" ADD CONSTRAINT "project_issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_partners" ADD CONSTRAINT "project_partners_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_partner_id_project_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."project_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_organizations" ADD CONSTRAINT "resource_organizations_service_organization_id_service_organizations_id_fk" FOREIGN KEY ("service_organization_id") REFERENCES "public"."service_organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_proficiency_set_id_proficiency_sets_id_fk" FOREIGN KEY ("proficiency_set_id") REFERENCES "public"."proficiency_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_packages" ADD CONSTRAINT "work_packages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_project_id_idx" ON "approval_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "approval_requests_ref_id_idx" ON "approval_requests" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "assignments_request_id_idx" ON "assignments" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "assignments_resource_id_idx" ON "assignments" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "billing_plan_items_contract_id_idx" ON "billing_plan_items" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "billing_plan_items_project_id_idx" ON "billing_plan_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "billing_plan_items_milestone_id_idx" ON "billing_plan_items" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "billing_plan_items_order_id_idx" ON "billing_plan_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "change_requests_project_id_idx" ON "change_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "contracts_customer_id_idx" ON "contracts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "milestones_project_id_idx" ON "milestones" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "order_lines_order_id_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_project_id_idx" ON "order_lines" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "orders_contract_id_idx" ON "orders" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "orders_partner_id_idx" ON "orders" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "project_cost_centers_project_id_idx" ON "project_cost_centers" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_documents_project_id_idx" ON "project_documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_financials_project_id_idx" ON "project_financials" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_issues_project_id_idx" ON "project_issues" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_partners_project_id_idx" ON "project_partners" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_tasks_project_id_idx" ON "project_tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_tasks_partner_id_idx" ON "project_tasks" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "projects_contract_id_idx" ON "projects" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "requests_project_id_idx" ON "requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "resource_organizations_service_organization_id_idx" ON "resource_organizations" USING btree ("service_organization_id");--> statement-breakpoint
CREATE INDEX "resources_manager_id_idx" ON "resources" USING btree ("manager_id");--> statement-breakpoint
CREATE INDEX "skills_proficiency_set_id_idx" ON "skills" USING btree ("proficiency_set_id");--> statement-breakpoint
CREATE INDEX "time_entries_project_id_idx" ON "time_entries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "time_entries_resource_id_idx" ON "time_entries" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "time_entries_assignment_id_idx" ON "time_entries" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "time_entries_request_id_idx" ON "time_entries" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "users_resource_id_idx" ON "users" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "work_packages_project_id_idx" ON "work_packages" USING btree ("project_id");