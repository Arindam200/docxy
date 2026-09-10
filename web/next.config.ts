import { join } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // The repository root, named explicitly rather than inferred.
    //
    // This app lives beside the docxy CLI package, which has its own lockfile,
    // and Turbopack's own guess between the two is not one to leave to chance.
    // It has to be the repository root rather than this directory: the billing
    // catalog and the billing tables live in the pipeline's `src/` and are
    // imported here through the `@billing` aliases, and Turbopack refuses to
    // resolve a file outside its root. See web/tsconfig.json for the aliases
    // and src/billing/catalog.ts for why those definitions are shared rather
    // than restated.
    root: join(import.meta.dirname, ".."),
  },

  // `/dashboard/synced` was this page's address until it became Repositories.
  // A bookmark or an old link should land on the list, not on a 404.
  async redirects() {
    return [
      {
        source: "/dashboard/synced",
        destination: "/dashboard/repositories",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
