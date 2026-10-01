CREATE TABLE "mail_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"mode" text DEFAULT 'blocks' NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"html" text DEFAULT '' NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_templates" ADD CONSTRAINT "mail_templates_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;