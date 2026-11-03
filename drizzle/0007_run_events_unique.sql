-- Earlier saves could write a role's events twice: see the unique index on
-- run_events in src/db/schema.ts. The copies are identical, so one of each is
-- kept, and the index below can then be built over what remains.
DELETE FROM "run_events" a USING "run_events" b WHERE a."role_id" = b."role_id" AND a."ordinal" = b."ordinal" AND a.ctid > b.ctid;--> statement-breakpoint
DROP INDEX "run_events_role_ordinal";--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_role_ordinal" ON "run_events" USING btree ("role_id","ordinal");