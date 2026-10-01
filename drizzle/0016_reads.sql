CREATE TABLE "request_reads" (
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "request_reads_request_id_user_id_pk" PRIMARY KEY("request_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "request_reads" ADD CONSTRAINT "request_reads_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_reads" ADD CONSTRAINT "request_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Was vor der Einführung passiert ist, gilt für alle als gelesen.
INSERT INTO "settings" ("key", "value") VALUES ('unread_baseline', jsonb_build_object('since', now())) ON CONFLICT DO NOTHING;
