CREATE TABLE "notification_dispatch_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"alert_recipient_id" uuid NOT NULL,
	"channel" varchar(32) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" varchar(32) NOT NULL,
	"provider_message_id" varchar(255),
	"failure_class" varchar(16),
	"provider_error_code" varchar(64),
	"safe_error_summary" varchar(255),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_dispatch_attempts_channel_check" CHECK ("notification_dispatch_attempts"."channel" IN ('sms', 'email', 'voice', 'push')),
	CONSTRAINT "notification_dispatch_attempts_status_check" CHECK ("notification_dispatch_attempts"."status" IN ('dispatching', 'submitted', 'submission_failed')),
	CONSTRAINT "notification_dispatch_attempts_failure_class_check" CHECK ("notification_dispatch_attempts"."failure_class" IS NULL OR "notification_dispatch_attempts"."failure_class" IN ('transient', 'permanent'))
);
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_status_check";--> statement-breakpoint
ALTER TABLE "alert_recipients" DROP CONSTRAINT "alert_recipients_status_check";--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "provider" varchar(32);--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "last_failure_class" varchar(16);--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "last_error_code" varchar(64);--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "last_error_summary" varchar(255);--> statement-breakpoint
ALTER TABLE "notification_dispatch_attempts" ADD CONSTRAINT "notification_dispatch_attempts_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_dispatch_attempts" ADD CONSTRAINT "notification_dispatch_attempts_alert_recipient_id_alert_recipients_id_fk" FOREIGN KEY ("alert_recipient_id") REFERENCES "public"."alert_recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_dispatch_attempts_alert_id_idx" ON "notification_dispatch_attempts" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "notification_dispatch_attempts_recipient_id_idx" ON "notification_dispatch_attempts" USING btree ("alert_recipient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dispatch_attempts_recipient_attempt_idx" ON "notification_dispatch_attempts" USING btree ("alert_recipient_id","attempt_number");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_status_check" CHECK ("alerts"."status" IN ('draft', 'ready', 'cancelled', 'dispatching', 'submitted', 'partially_submitted', 'submission_failed', 'queued', 'sending', 'sent', 'failed'));--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD CONSTRAINT "alert_recipients_last_failure_class_check" CHECK ("alert_recipients"."last_failure_class" IS NULL OR "alert_recipients"."last_failure_class" IN ('transient', 'permanent'));--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD CONSTRAINT "alert_recipients_status_check" CHECK ("alert_recipients"."status" IN ('pending_delivery', 'dispatching', 'submitted', 'submission_failed', 'queued', 'delivered', 'failed'));