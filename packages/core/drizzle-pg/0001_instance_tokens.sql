CREATE TABLE "instance_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"last_used_at" bigint,
	"expires_at" bigint,
	"revoked_at" bigint,
	CONSTRAINT "instance_tokens_hash_unique" UNIQUE("token_hash")
);
