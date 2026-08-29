CREATE TABLE "contact_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_type" varchar(8) NOT NULL,
	"status" varchar(32) DEFAULT 'mapping' NOT NULL,
	"headers" jsonb NOT NULL,
	"raw_rows" jsonb,
	"column_mapping" jsonb,
	"row_count" integer NOT NULL,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "contact_import_batches_file_type_check" CHECK ("contact_import_batches"."file_type" IN ('csv', 'xlsx')),
	CONSTRAINT "contact_import_batches_status_check" CHECK ("contact_import_batches"."status" IN ('mapping', 'previewed', 'confirmed', 'completed', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "contact_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"first_name" varchar(128),
	"last_name" varchar(128),
	"email" varchar(255),
	"mobile_phone" varchar(32),
	"department" varchar(128),
	"reference_id" varchar(64),
	"status" varchar(32) NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duplicate_matches" jsonb,
	"selected" boolean DEFAULT false NOT NULL,
	"imported_contact_id" uuid,
	"import_result" varchar(16),
	"import_error" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_import_rows_status_check" CHECK ("contact_import_rows"."status" IN ('valid', 'invalid', 'possible_duplicate', 'duplicate_in_file')),
	CONSTRAINT "contact_import_rows_import_result_check" CHECK ("contact_import_rows"."import_result" IN ('imported', 'skipped', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "contact_import_batches" ADD CONSTRAINT "contact_import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_import_rows" ADD CONSTRAINT "contact_import_rows_batch_id_contact_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."contact_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_import_batches_created_by_idx" ON "contact_import_batches" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "contact_import_batches_status_idx" ON "contact_import_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "contact_import_rows_batch_id_idx" ON "contact_import_rows" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "contact_import_rows_batch_status_idx" ON "contact_import_rows" USING btree ("batch_id","status");