/**
 * Better Auth's tables, as Drizzle definitions.
 *
 * The property keys here are Better Auth's own field names — the Drizzle
 * adapter resolves columns by looking up `schema[model][fieldName]`, so
 * renaming a key breaks auth at runtime rather than at compile time. Column
 * names are snake_case; only the keys are load-bearing.
 *
 * Everything lives in a dedicated `auth` Postgres schema. The docxy pipeline
 * writes its own tables to `public` in the same Neon database, and keeping the
 * two in separate namespaces is what lets each side run drizzle-kit without
 * proposing to drop the other's tables (see the `schemaFilter` in the two
 * drizzle.config.ts files).
 */

import { boolean, index, pgSchema, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const authSchema = pgSchema("auth");

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const user = authSchema.table("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  ...timestamps,
});

export const session = authSchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = authSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    /**
     * Added in Better Auth 1.7: identifies the issuer a social account came
     * from, so the same `accountId` from two different issuers cannot collide.
     */
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    /** Only ever set for the email/password provider; argon2-hashed by Better Auth. */
    password: text("password"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("account_issuer_account_id_idx").on(t.issuer, t.accountId),
    index("account_user_id_idx").on(t.userId),
  ],
);

export const verification = authSchema.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const schema = { user, session, account, verification };
