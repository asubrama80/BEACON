CREATE SEQUENCE "public"."incident_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "incident_timeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" serial NOT NULL,
	"incident_id" uuid NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"actor_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "incident_number" varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incident_timeline_events" ADD CONSTRAINT "incident_timeline_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_timeline_events" ADD CONSTRAINT "incident_timeline_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_timeline_events_seq_idx" ON "incident_timeline_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "incident_timeline_events_incident_id_idx" ON "incident_timeline_events" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "incident_timeline_events_order_idx" ON "incident_timeline_events" USING btree ("incident_id","occurred_at","seq");--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_incident_number_idx" ON "incidents" USING btree ("incident_number");--> statement-breakpoint
CREATE INDEX "incidents_severity_idx" ON "incidents" USING btree ("severity");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_participants_active_user_idx" ON "incident_participants" USING btree ("incident_id","user_id") WHERE "incident_participants"."status" != 'removed' AND "incident_participants"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_participants_active_contact_idx" ON "incident_participants" USING btree ("incident_id","contact_id") WHERE "incident_participants"."status" != 'removed' AND "incident_participants"."contact_id" IS NOT NULL;