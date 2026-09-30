CREATE TYPE "public"."organisation_status" AS ENUM('pending', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."request_event_type" AS ENUM('created', 'updated', 'status_changed', 'assigned', 'commented');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('new', 'in_review', 'on_hold', 'quoted', 'approved', 'printing', 'shipped', 'completed', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('superadmin', 'admin', 'staff', 'customer');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending', 'active', 'rejected', 'disabled');--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"street" text,
	"zip" text,
	"city" text,
	"country" text DEFAULT 'DE' NOT NULL,
	"vat_id" text,
	"status" "organisation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_id" uuid,
	"type" "request_event_type" NOT NULL,
	"from_status" "request_status",
	"to_status" "request_status",
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "requests_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1001 CACHE 1),
	"organisation_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"assignee_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"quantity" integer,
	"desired_date" date,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quote_amount_cents" integer,
	"quote_note" text,
	"status" "request_status" DEFAULT 'new' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"role" "user_role" DEFAULT 'customer' NOT NULL,
	"status" "user_status" DEFAULT 'pending' NOT NULL,
	"organisation_id" uuid,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "request_comments" ADD CONSTRAINT "request_comments_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_comments" ADD CONSTRAINT "request_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_comments_request_idx" ON "request_comments" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "request_events_request_idx" ON "request_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "requests_organisation_idx" ON "requests" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "requests_status_idx" ON "requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "requests_assignee_idx" ON "requests" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_organisation_idx" ON "users" USING btree ("organisation_id");