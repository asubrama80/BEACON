DROP INDEX "templates_name_channel_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "templates_name_lower_channel_unique_idx" ON "templates" USING btree (lower("name"),"channel") WHERE "templates"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "templates_status_idx" ON "templates" USING btree ("status");