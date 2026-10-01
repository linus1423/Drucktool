ALTER TYPE "public"."file_role" ADD VALUE 'attachment';--> statement-breakpoint
ALTER TABLE "request_files" ADD COLUMN "comment_id" uuid;--> statement-breakpoint
ALTER TABLE "request_files" ADD CONSTRAINT "request_files_comment_id_request_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."request_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_files_comment_idx" ON "request_files" USING btree ("comment_id");