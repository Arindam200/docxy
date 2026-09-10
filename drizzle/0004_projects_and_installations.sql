CREATE TABLE "github_installations" (
	"installation_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_login" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_repo" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "docs_repo" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "docs_roots" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_repo_unique" UNIQUE("source_repo");