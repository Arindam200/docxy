import type { MetadataRoute } from "next";

import { site } from "@/lib/site";

const canonical = process.env.BETTER_AUTH_URL?.trim() || site.url;

/**
 * What a crawler may read now that this is a real domain.
 *
 * The landing page is the only thing here worth indexing. `/dashboard` is
 * behind a session and would only ever answer a crawler with a redirect to
 * `/login`; `/api` is the auth endpoints and the pipeline proxy. Neither is
 * secret - the gate is the session, not this file - but both are noise in an
 * index and in the crawl budget spent reaching them.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/dashboard/", "/login", "/signup"],
    },
    sitemap: `${canonical}/sitemap.xml`,
    host: canonical,
  };
}
