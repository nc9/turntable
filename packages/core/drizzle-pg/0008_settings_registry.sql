CREATE TABLE "settings" (
	"scope_kind" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "settings_scope_kind_scope_id_key_pk" PRIMARY KEY("scope_kind","scope_id","key"),
	CONSTRAINT "settings_scope_kind_check" CHECK (scope_kind IN ('instance', 'org', 'project'))
);
