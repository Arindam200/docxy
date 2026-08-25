CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"role" text NOT NULL,
	"session_id" text NOT NULL,
	"spec_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_signoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_rationale" text NOT NULL,
	"required_signoffs" integer NOT NULL,
	"status" text NOT NULL,
	"denied_reason" text,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approvals_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_commits" (
	"project_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_commits_project_id_sha_pk" PRIMARY KEY("project_id","sha")
);
--> statement-breakpoint
CREATE TABLE "knowledge_symbols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"doc_sections" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"knowledge_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"path" text NOT NULL,
	"content_before" text NOT NULL,
	"content_after" text NOT NULL,
	"applied_edits" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_outputs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"classification" jsonb,
	"impact" jsonb,
	"docs" jsonb,
	"changelog" jsonb,
	"validation" jsonb
);
--> statement-breakpoint
CREATE TABLE "run_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"session_id" text NOT NULL,
	"turn_id" text,
	"reused_session" boolean DEFAULT false NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"commit_short_sha" text NOT NULL,
	"commit_subject" text NOT NULL,
	"status" text NOT NULL,
	"docs_branch" text,
	"error" text,
	"prior_symbol_count" integer DEFAULT 0 NOT NULL,
	"new_symbol_count" integer DEFAULT 0 NOT NULL,
	"pull_request_url" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_signoffs" ADD CONSTRAINT "approval_signoffs_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_commits" ADD CONSTRAINT "knowledge_commits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_symbols" ADD CONSTRAINT "knowledge_symbols_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_role_id_run_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."run_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_files" ADD CONSTRAINT "run_files_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_outputs" ADD CONSTRAINT "run_outputs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_roles" ADD CONSTRAINT "run_roles_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_project_role" ON "agent_sessions" USING btree ("project_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_signoffs_unique" ON "approval_signoffs" USING btree ("approval_id","by");--> statement-breakpoint
CREATE INDEX "knowledge_commits_seen" ON "knowledge_commits" USING btree ("project_id","seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_project_symbol" ON "knowledge_symbols" USING btree ("project_id","symbol");--> statement-breakpoint
CREATE INDEX "run_events_role_ordinal" ON "run_events" USING btree ("role_id","ordinal");--> statement-breakpoint
CREATE INDEX "run_files_run_ordinal" ON "run_files" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX "run_roles_run_ordinal" ON "run_roles" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX "runs_project_started" ON "runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "runs_commit" ON "runs" USING btree ("commit_sha");--> statement-breakpoint
CREATE INDEX "runs_status" ON "runs" USING btree ("status");