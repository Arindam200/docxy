CREATE SCHEMA "billing";
--> statement-breakpoint
CREATE TABLE "billing"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"environment" text NOT NULL,
	"dodo_customer_id" text,
	"entitled_plan" text DEFAULT 'free' NOT NULL,
	"purchased_seats" integer DEFAULT 1 NOT NULL,
	"access_state" text DEFAULT 'active' NOT NULL,
	"access_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing"."checkout_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"plan_key" text NOT NULL,
	"requested_seats" integer DEFAULT 1 NOT NULL,
	"request_key" text NOT NULL,
	"provider_session_id" text,
	"state" text DEFAULT 'open' NOT NULL,
	"failure_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing"."payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"subscription_id" uuid,
	"environment" text NOT NULL,
	"provider_payment_id" text NOT NULL,
	"status" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"refunded_minor" integer DEFAULT 0 NOT NULL,
	"disputed" boolean DEFAULT false NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing"."run_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"usage_period_id" uuid NOT NULL,
	"project_id" uuid,
	"run_id" uuid,
	"commit_sha" text,
	"invocation_key" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"release_reason" text,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing"."subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"plan_key" text NOT NULL,
	"plan_version" text NOT NULL,
	"purchased_seats" integer DEFAULT 1 NOT NULL,
	"provider_status" text NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"scheduled_plan_key" text,
	"scheduled_seats" integer,
	"provider_event_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing"."usage_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"subscription_id" uuid,
	"plan_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"runs_allowed" integer NOT NULL,
	"seats_allowed" integer NOT NULL,
	"repositories_allowed" integer NOT NULL,
	"automatic_runs" boolean NOT NULL,
	"runs_reserved" integer DEFAULT 0 NOT NULL,
	"runs_consumed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing"."webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"provider_delivery_id" text NOT NULL,
	"type" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing"."checkout_attempts" ADD CONSTRAINT "checkout_attempts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "billing"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."payments" ADD CONSTRAINT "payments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "billing"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."payments" ADD CONSTRAINT "payments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "billing"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."run_reservations" ADD CONSTRAINT "run_reservations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "billing"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."run_reservations" ADD CONSTRAINT "run_reservations_usage_period_id_usage_periods_id_fk" FOREIGN KEY ("usage_period_id") REFERENCES "billing"."usage_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."subscriptions" ADD CONSTRAINT "subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "billing"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."usage_periods" ADD CONSTRAINT "usage_periods_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "billing"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."usage_periods" ADD CONSTRAINT "usage_periods_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "billing"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_org_env" ON "billing"."accounts" USING btree ("organization_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_customer" ON "billing"."accounts" USING btree ("environment","dodo_customer_id") WHERE dodo_customer_id is not null;--> statement-breakpoint
CREATE INDEX "billing_accounts_owner" ON "billing"."accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_attempts_request_key" ON "billing"."checkout_attempts" USING btree ("account_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_attempts_one_open" ON "billing"."checkout_attempts" USING btree ("account_id") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX "checkout_attempts_session" ON "billing"."checkout_attempts" USING btree ("provider_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_id" ON "billing"."payments" USING btree ("environment","provider_payment_id");--> statement-breakpoint
CREATE INDEX "payments_account" ON "billing"."payments" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_reservations_invocation" ON "billing"."run_reservations" USING btree ("account_id","invocation_key");--> statement-breakpoint
CREATE INDEX "run_reservations_period" ON "billing"."run_reservations" USING btree ("usage_period_id","state");--> statement-breakpoint
CREATE INDEX "run_reservations_run" ON "billing"."run_reservations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_id" ON "billing"."subscriptions" USING btree ("environment","provider_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_account" ON "billing"."subscriptions" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_periods_account_start" ON "billing"."usage_periods" USING btree ("account_id","plan_key","period_start");--> statement-breakpoint
CREATE INDEX "usage_periods_account_window" ON "billing"."usage_periods" USING btree ("account_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_provider_id" ON "billing"."webhook_deliveries" USING btree ("environment","provider_delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_state" ON "billing"."webhook_deliveries" USING btree ("state","received_at");