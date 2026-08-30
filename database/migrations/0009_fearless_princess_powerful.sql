CREATE SEQUENCE "public"."alert_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "alert_contact_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_group_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_status_check";--> statement-breakpoint
ALTER TABLE "alert_recipients" DROP CONSTRAINT "alert_recipients_status_check";--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_recipients" ALTER COLUMN "status" SET DEFAULT 'pending_delivery';--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "alert_number" varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "title" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "content_source" varchar(16) DEFAULT 'adhoc' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "template_name_snapshot" varchar(255);--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "eligible_recipient_count" integer;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "excluded_count" integer;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "exclusion_summary" jsonb;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "rendered_subject" text;--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD COLUMN "rendered_body" text;--> statement-breakpoint
ALTER TABLE "alert_contact_selections" ADD CONSTRAINT "alert_contact_selections_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_contact_selections" ADD CONSTRAINT "alert_contact_selections_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_group_selections" ADD CONSTRAINT "alert_group_selections_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_group_selections" ADD CONSTRAINT "alert_group_selections_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_contact_selections_alert_contact_idx" ON "alert_contact_selections" USING btree ("alert_id","contact_id");--> statement-breakpoint
CREATE INDEX "alert_contact_selections_alert_id_idx" ON "alert_contact_selections" USING btree ("alert_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_group_selections_alert_group_idx" ON "alert_group_selections" USING btree ("alert_id","group_id");--> statement-breakpoint
CREATE INDEX "alert_group_selections_alert_id_idx" ON "alert_group_selections" USING btree ("alert_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_alert_number_idx" ON "alerts" USING btree ("alert_number");--> statement-breakpoint
CREATE INDEX "alerts_status_idx" ON "alerts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_recipients_alert_contact_idx" ON "alert_recipients" USING btree ("alert_id","contact_id") WHERE "alert_recipients"."contact_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_content_source_check" CHECK ("alerts"."content_source" IN ('template', 'adhoc'));--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_status_check" CHECK ("alerts"."status" IN ('draft', 'ready', 'cancelled', 'queued', 'sending', 'sent', 'failed'));--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD CONSTRAINT "alert_recipients_status_check" CHECK ("alert_recipients"."status" IN ('pending_delivery', 'queued', 'submitted', 'delivered', 'failed'));