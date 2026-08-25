import { defineConfig } from "drizzle-kit";

/**
 * The dashboard owns only the `auth` schema. `schemaFilter` is what keeps
 * drizzle-kit from noticing the docxy pipeline's tables in `public` — which it
 * would otherwise offer to drop, since they are absent from this schema file.
 * The pipeline has its own config one directory up, filtered the other way.
 */

// drizzle-kit reads `.env`, but Next.js developers keep secrets in `.env.local`.
// Load it first so `npm run db:*` and `next dev` see the same DATABASE_URL.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Absent or unreadable; the next candidate (or the ambient env) covers it.
  }
}

const url = process.env.DATABASE_URL;
// `generate` diffs the schema file against the migration folder and never
// connects, so it should not demand a connection string it will not use.
if (!url && !process.argv.includes("generate")) {
  throw new Error(
    "DATABASE_URL is not set. Add your Neon connection string to web/.env.local before running drizzle-kit.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  schemaFilter: ["auth"],
  dbCredentials: { url: url ?? "" },
  strict: true,
  verbose: true,
});
