/**
 * Better Auth's tables, as Drizzle definitions.
 *
 * The property keys here are Better Auth's own field names - the Drizzle
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
    /**
     * Which organization this session is currently looking at.
     *
     * Set by the organization plugin, never by a form - it is `input: false`
     * upstream - and deliberately nullable: a session exists for the moment
     * between verifying an email and naming a first organization, and it has no
     * active org to point at yet. Everything that reads org-scoped data must
     * treat null as "not onboarded", not as "show everything".
     */
    activeOrganizationId: text("active_organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
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

/**
 * An organization: the unit that owns projects, and the only unit that does.
 *
 * Every account gets one at signup, even a single person working alone, so
 * there is no second code path for "personal" ownership that has to grow team
 * support later. A solo org is a team of one, and inviting somebody is a row in
 * `member` rather than a migration.
 *
 * Field names are Better Auth's organization plugin's own - see the note at the
 * top of this file about why renaming a key breaks auth at runtime rather than
 * at compile time. The plugin declares no `updatedAt`, so this table does not
 * carry one.
 */
export const organization = authSchema.table(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Unique, and what an org-scoped URL is keyed by. */
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    /** Free-form JSON, stored as text by the plugin rather than as jsonb. */
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("organization_slug_idx").on(t.slug)],
);

/** A person's membership of one organization, carrying their role in it. */
export const member = authSchema.table(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** `owner`, `admin`, or `member`. The creator of an org is its owner. */
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("member_organization_id_idx").on(t.organizationId),
    index("member_user_id_idx").on(t.userId),
    // One membership per person per org. Without this, accepting the same
    // invitation twice quietly produces two rows and two roles for one person.
    uniqueIndex("member_organization_id_user_id_idx").on(t.organizationId, t.userId),
  ],
);

/**
 * An outstanding invitation to join an organization.
 *
 * Addressed to an email rather than to a user id on purpose: the point is to
 * invite people who do not have an account yet, and they accept by signing up.
 */
export const invitation = authSchema.table(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    /** `pending`, `accepted`, `rejected`, or `canceled`. */
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("invitation_organization_id_idx").on(t.organizationId),
    index("invitation_email_idx").on(t.email),
  ],
);

export const schema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
};
