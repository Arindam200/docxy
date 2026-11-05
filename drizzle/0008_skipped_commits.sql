CREATE TABLE "skipped_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"commit_short_sha" text NOT NULL,
	"commit_subject" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"triage" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skipped_commits" ADD CONSTRAINT "skipped_commits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skipped_commits_project_commit" ON "skipped_commits" USING btree ("project_id","commit_sha");--> statement-breakpoint
CREATE INDEX "skipped_commits_project_at" ON "skipped_commits" USING btree ("project_id","at");