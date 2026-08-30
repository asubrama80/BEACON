CREATE TABLE "notification_delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"alert_recipient_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_message_id" varchar(255) NOT NULL,
	"provider_event_id" varchar(255),
	"dedupe_key" varchar(512) NOT NULL,
	"raw_provider_status" varchar(64) NOT NULL,
	"normalized_status" varchar(32) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_error_code" varchar(64),
	"safe_error_summary" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_delivery_events_normalized_status_check" CHECK ("notification_delivery_events"."normalized_status" IN ('submitted', 'pending', 'delivered', 'undelivered', 'bounced', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "delivery_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "delivery_status" varchar(32);--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "delivery_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "delivery_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "provider_delivery_code" varchar(64);--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "delivery_error_summary" varchar(255);--> statement-breakpoint
ALTER TABLE "notification_delivery_events" ADD CONSTRAINT "notification_delivery_events_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_events" ADD CONSTRAINT "notification_delivery_events_alert_recipient_id_alert_recipients_id_fk" FOREIGN KEY ("alert_recipient_id") REFERENCES "public"."alert_recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_delivery_events_alert_id_idx" ON "notification_delivery_events" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_events_recipient_id_idx" ON "notification_delivery_events" USING btree ("alert_recipient_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_events_provider_message_id_idx" ON "notification_delivery_events" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_events_dedupe_key_idx" ON "notification_delivery_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "alert_recipients_delivery_status_idx" ON "alert_recipients" USING btree ("delivery_status");--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD CONSTRAINT "alert_recipients_delivery_status_check" CHECK ("alert_recipients"."delivery_status" IS NULL OR "alert_recipients"."delivery_status" IN ('pending', 'delivered', 'undelivered', 'bounced', 'failed'));