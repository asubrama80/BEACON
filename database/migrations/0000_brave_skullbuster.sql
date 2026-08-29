CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_status_check" CHECK ("users"."status" IN ('active', 'inactive', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_id" varchar(64),
	"first_name" varchar(128) NOT NULL,
	"last_name" varchar(128) NOT NULL,
	"email" varchar(255),
	"mobile_phone" varchar(32),
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "contacts_status_check" CHECK ("contacts"."status" IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"channel" varchar(32) NOT NULL,
	"severity" varchar(32),
	"subject" varchar(255),
	"body" text NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "templates_channel_check" CHECK ("templates"."channel" IN ('sms', 'email', 'voice', 'push')),
	CONSTRAINT "templates_status_check" CHECK ("templates"."status" IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"severity" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'open' NOT NULL,
	"incident_commander_id" uuid,
	"activated_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_severity_check" CHECK ("incidents"."severity" IN ('info', 'warning', 'high', 'critical')),
	CONSTRAINT "incidents_status_check" CHECK ("incidents"."status" IN ('open', 'active', 'resolved', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "guest_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"guest_name" varchar(255) NOT NULL,
	"email" varchar(255),
	"mobile_phone" varchar(32),
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"token_hash" text NOT NULL,
	"otp_hash" text,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_invitations_status_check" CHECK ("guest_invitations"."status" IN ('pending', 'sent', 'verified', 'joined', 'expired', 'revoked')),
	CONSTRAINT "guest_invitations_contact_method_check" CHECK ("guest_invitations"."email" IS NOT NULL OR "guest_invitations"."mobile_phone" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "incident_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"participant_type" varchar(16) NOT NULL,
	"user_id" uuid,
	"contact_id" uuid,
	"guest_invitation_id" uuid,
	"participant_role" varchar(64) DEFAULT 'participant' NOT NULL,
	"status" varchar(16) DEFAULT 'invited' NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_participants_type_check" CHECK ("incident_participants"."participant_type" IN ('user', 'contact', 'guest')),
	CONSTRAINT "incident_participants_status_check" CHECK ("incident_participants"."status" IN ('invited', 'joined', 'left', 'removed')),
	CONSTRAINT "incident_participants_reference_check" CHECK (
        ("incident_participants"."participant_type" = 'user' AND "incident_participants"."user_id" IS NOT NULL AND "incident_participants"."contact_id" IS NULL AND "incident_participants"."guest_invitation_id" IS NULL)
        OR ("incident_participants"."participant_type" = 'contact' AND "incident_participants"."contact_id" IS NOT NULL AND "incident_participants"."user_id" IS NULL AND "incident_participants"."guest_invitation_id" IS NULL)
        OR ("incident_participants"."participant_type" = 'guest' AND "incident_participants"."guest_invitation_id" IS NOT NULL AND "incident_participants"."user_id" IS NULL AND "incident_participants"."contact_id" IS NULL)
      )
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid,
	"template_id" uuid,
	"channel" varchar(32) NOT NULL,
	"subject" varchar(255),
	"body" text NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_channel_check" CHECK ("alerts"."channel" IN ('sms', 'email', 'voice', 'push')),
	CONSTRAINT "alerts_status_check" CHECK ("alerts"."status" IN ('draft', 'queued', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "alert_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"contact_id" uuid,
	"recipient_name" varchar(255),
	"recipient_address" varchar(255),
	"channel" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"provider_message_id" varchar(255),
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_recipients_channel_check" CHECK ("alert_recipients"."channel" IN ('sms', 'email', 'voice', 'push')),
	CONSTRAINT "alert_recipients_status_check" CHECK ("alert_recipients"."status" IN ('queued', 'submitted', 'delivered', 'failed')),
	CONSTRAINT "alert_recipients_target_check" CHECK ("alert_recipients"."contact_id" IS NOT NULL OR "alert_recipients"."recipient_address" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"author_type" varchar(16) NOT NULL,
	"user_id" uuid,
	"participant_id" uuid,
	"message_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_author_type_check" CHECK ("chat_messages"."author_type" IN ('user', 'guest')),
	CONSTRAINT "chat_messages_author_reference_check" CHECK (
        ("chat_messages"."author_type" = 'user' AND "chat_messages"."user_id" IS NOT NULL)
        OR ("chat_messages"."author_type" = 'guest' AND "chat_messages"."participant_id" IS NOT NULL)
      )
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"incident_id" uuid,
	"resource_type" varchar(128),
	"resource_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_actor_type_check" CHECK ("audit_logs"."actor_type" IN ('user', 'contact', 'guest', 'system'))
);
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_incident_commander_id_users_id_fk" FOREIGN KEY ("incident_commander_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_invitations" ADD CONSTRAINT "guest_invitations_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_invitations" ADD CONSTRAINT "guest_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_participants" ADD CONSTRAINT "incident_participants_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_participants" ADD CONSTRAINT "incident_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_participants" ADD CONSTRAINT "incident_participants_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_participants" ADD CONSTRAINT "incident_participants_guest_invitation_id_guest_invitations_id_fk" FOREIGN KEY ("guest_invitation_id") REFERENCES "public"."guest_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD CONSTRAINT "alert_recipients_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_recipients" ADD CONSTRAINT "alert_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_participant_id_incident_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."incident_participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_user_role_idx" ON "user_roles" USING btree ("user_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_reference_id_idx" ON "contacts" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "contacts_status_idx" ON "contacts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_group_contact_idx" ON "group_members" USING btree ("group_id","contact_id");--> statement-breakpoint
CREATE INDEX "group_members_group_id_idx" ON "group_members" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_name_idx" ON "groups" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_name_channel_idx" ON "templates" USING btree ("name","channel");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "guest_invitations_incident_status_idx" ON "guest_invitations" USING btree ("incident_id","status");--> statement-breakpoint
CREATE INDEX "guest_invitations_expires_at_idx" ON "guest_invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "incident_participants_incident_id_idx" ON "incident_participants" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "alerts_incident_status_idx" ON "alerts" USING btree ("incident_id","status");--> statement-breakpoint
CREATE INDEX "alert_recipients_alert_id_idx" ON "alert_recipients" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "alert_recipients_status_idx" ON "alert_recipients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "alert_recipients_provider_message_id_idx" ON "alert_recipients" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "chat_messages_incident_created_at_idx" ON "chat_messages" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_event_type_idx" ON "audit_logs" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");