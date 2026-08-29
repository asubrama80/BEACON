ALTER TABLE "contacts" ADD COLUMN "department" varchar(128);--> statement-breakpoint
CREATE INDEX "contacts_mobile_phone_idx" ON "contacts" USING btree ("mobile_phone");