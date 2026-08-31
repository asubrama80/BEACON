ALTER TABLE "war_room_sessions" DROP CONSTRAINT "war_room_sessions_reference_check";--> statement-breakpoint
ALTER TABLE "war_room_sessions" ADD COLUMN "guest_invitation_id" uuid;--> statement-breakpoint
ALTER TABLE "war_room_sessions" ADD CONSTRAINT "war_room_sessions_guest_invitation_fk" FOREIGN KEY ("guest_invitation_id") REFERENCES "public"."guest_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_participants_active_guest_idx" ON "incident_participants" USING btree ("incident_id","guest_invitation_id") WHERE "incident_participants"."status" != 'removed' AND "incident_participants"."guest_invitation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "war_room_sessions_active_guest_idx" ON "war_room_sessions" USING btree ("war_room_id","guest_invitation_id") WHERE "war_room_sessions"."status" = 'joined' AND "war_room_sessions"."guest_invitation_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "war_room_sessions" ADD CONSTRAINT "war_room_sessions_reference_check" CHECK (
        ("war_room_sessions"."participant_type" = 'user' AND "war_room_sessions"."user_id" IS NOT NULL AND "war_room_sessions"."guest_invitation_id" IS NULL)
        OR ("war_room_sessions"."participant_type" = 'guest' AND "war_room_sessions"."guest_invitation_id" IS NOT NULL AND "war_room_sessions"."user_id" IS NULL)
      );