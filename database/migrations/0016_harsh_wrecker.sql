CREATE TABLE "guest_otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"code_salt" text NOT NULL,
	"code_hash" text NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_otp_challenges_status_check" CHECK ("guest_otp_challenges"."status" IN ('active', 'consumed', 'expired', 'superseded', 'locked'))
);
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "guest_otp_challenges" ADD CONSTRAINT "guest_otp_challenges_invitation_id_guest_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."guest_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_invitation_id_guest_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."guest_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_otp_challenges_invitation_id_idx" ON "guest_otp_challenges" USING btree ("invitation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_otp_challenges_active_idx" ON "guest_otp_challenges" USING btree ("invitation_id") WHERE "guest_otp_challenges"."status" = 'active';--> statement-breakpoint
CREATE INDEX "guest_sessions_invitation_id_idx" ON "guest_sessions" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "guest_sessions_expires_at_idx" ON "guest_sessions" USING btree ("expires_at");