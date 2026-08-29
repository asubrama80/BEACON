ALTER TABLE "incident_participants" DROP CONSTRAINT "incident_participants_guest_invitation_id_guest_invitations_id_fk";
--> statement-breakpoint
ALTER TABLE "incident_participants" ADD CONSTRAINT "incident_participants_guest_invitation_fk" FOREIGN KEY ("guest_invitation_id") REFERENCES "public"."guest_invitations"("id") ON DELETE cascade ON UPDATE no action;