CREATE TABLE "rate_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"organization" text,
	"currency" text NOT NULL,
	"cost_rate" double precision NOT NULL,
	"bill_rate" double precision NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_cards_role_idx" ON "rate_cards" USING btree ("role");