import type { MetadataRoute } from "next";

import { site } from "@/lib/site";

const canonical = process.env.BETTER_AUTH_URL?.trim() || site.url;

/**
 * One public page, so one entry.
 *
 * Listing the sign-in routes would advertise a form nobody outside the operator
 * allowlist can complete, and the dashboard behind them renders nothing without
 * a session. A sitemap that names them is a longer file, not a better one.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: canonical,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
