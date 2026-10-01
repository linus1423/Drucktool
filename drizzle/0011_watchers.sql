CREATE TABLE "request_watchers" (
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_watchers_request_id_user_id_pk" PRIMARY KEY("request_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "request_comments" ADD COLUMN "mentioned_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "request_watchers" ADD CONSTRAINT "request_watchers_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_watchers" ADD CONSTRAINT "request_watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_watchers_user_idx" ON "request_watchers" USING btree ("user_id");