import { defineConfig } from 'drizzle-kit';

/**
 * The pipeline owns the `public` schema. `schemaFilter` is what keeps
 * drizzle-kit from noticing the dashboard's Better Auth tables in `auth` —
 * which it would otherwise offer to drop, since they are absent from this
 * schema file. The dashboard has its own config in web/, filtered the other way.
 */

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Absent or unreadable; the next candidate (or the ambient env) covers it.
  }
}

const url = process.env.DATABASE_URL;
// `generate` diffs the schema file against the migration folder and never
// connects, so it should not demand a connection string it will not use.
if (!url && !process.argv.includes('generate')) {
  throw new Error(
    'DATABASE_URL is not set. Add your Neon connection string to .env before running drizzle-kit.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['public'],
  // Pinned explicitly. Both sides share one database, and drizzle-kit decides
  // what to apply by comparing journal timestamps against whatever it finds in
  // this table — so a shared ledger makes each side's migrations look already
  // applied to the other, and it reports success without running them.
  migrations: { table: '__drizzle_migrations', schema: 'drizzle' },
  dbCredentials: { url: url ?? '' },
  strict: true,
  verbose: true,
});
