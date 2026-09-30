CREATE TABLE "oidc_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oidc_accounts" ADD CONSTRAINT "oidc_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_accounts_issuer_subject_unique" ON "oidc_accounts" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "oidc_accounts_user_idx" ON "oidc_accounts" USING btree ("user_id");