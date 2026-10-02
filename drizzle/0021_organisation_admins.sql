CREATE TABLE "organisation_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisation_members" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "cost_center" text;--> statement-breakpoint
ALTER TABLE "organisation_invites" ADD CONSTRAINT "organisation_invites_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_invites" ADD CONSTRAINT "organisation_invites_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_invites" ADD CONSTRAINT "organisation_invites_used_by_id_users_id_fk" FOREIGN KEY ("used_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_invites_token_unique" ON "organisation_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "organisation_invites_organisation_idx" ON "organisation_invites" USING btree ("organisation_id");