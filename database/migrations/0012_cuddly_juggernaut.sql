DROP INDEX "chat_messages_incident_created_at_idx";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "seq" serial NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_seq_idx" ON "chat_messages" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "chat_messages_incident_created_at_idx" ON "chat_messages" USING btree ("incident_id","created_at","seq");