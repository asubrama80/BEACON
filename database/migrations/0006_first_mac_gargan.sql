DROP INDEX "groups_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "groups_name_lower_unique_idx" ON "groups" USING btree (lower("name")) WHERE "groups"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "groups_status_idx" ON "groups" USING btree ("status");--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_status_check" CHECK ("groups"."status" IN ('active', 'inactive'));