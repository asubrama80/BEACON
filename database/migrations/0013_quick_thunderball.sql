CREATE TABLE "incident_war_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"opened_by_user_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_by_user_id" uuid,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_war_rooms_status_check" CHECK ("incident_war_rooms"."status" IN ('open', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "war_room_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"war_room_id" uuid NOT NULL,
	"participant_type" varchar(16) DEFAULT 'user' NOT NULL,
	"user_id" uuid,
	"incident_participant_id" uuid,
	"status" varchar(16) DEFAULT 'joined' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "war_room_sessions_participant_type_check" CHECK ("war_room_sessions"."participant_type" IN ('user', 'guest')),
	CONSTRAINT "war_room_sessions_status_check" CHECK ("war_room_sessions"."status" IN ('joined', 'left')),
	CONSTRAINT "war_room_sessions_reference_check" CHECK (("war_room_sessions"."participant_type" = 'user' AND "war_room_sessions"."user_id" IS NOT NULL) OR ("war_room_sessions"."participant_type" = 'guest'))
);
--> statement-breakpoint
ALTER TABLE "incident_war_rooms" ADD CONSTRAINT "incident_war_rooms_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_war_rooms" ADD CONSTRAINT "incident_war_rooms_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_war_rooms" ADD CONSTRAINT "incident_war_rooms_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "war_room_sessions" ADD CONSTRAINT "war_room_sessions_war_room_id_incident_war_rooms_id_fk" FOREIGN KEY ("war_room_id") REFERENCES "public"."incident_war_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "war_room_sessions" ADD CONSTRAINT "war_room_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "war_room_sessions" ADD CONSTRAINT "war_room_sessions_incident_participant_fk" FOREIGN KEY ("incident_participant_id") REFERENCES "public"."incident_participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_war_rooms_incident_id_idx" ON "incident_war_rooms" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_war_rooms_active_idx" ON "incident_war_rooms" USING btree ("incident_id") WHERE "incident_war_rooms"."status" = 'open';--> statement-breakpoint
CREATE INDEX "war_room_sessions_war_room_id_idx" ON "war_room_sessions" USING btree ("war_room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "war_room_sessions_active_user_idx" ON "war_room_sessions" USING btree ("war_room_id","user_id") WHERE "war_room_sessions"."status" = 'joined' AND "war_room_sessions"."user_id" IS NOT NULL;