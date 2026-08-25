/** Formatting shared across dashboard views. Pure, so it runs on either side. */

export function duration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Thousands as `k`, so a run list column stays one width. */
export function tokens(count: number | undefined): string {
  if (!count) return "—";
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}

export function timeAgo(iso: string | undefined): string {
  if (!iso) return "—";

  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const ROLE_TITLES: Record<string, string> = {
  coordinator: "Coordinator",
  "change-analyst": "Change Analyst",
  "impact-mapper": "Impact Mapper",
  "docs-updater": "Docs Updater",
  "changelog-author": "Changelog Author",
};

export function roleTitle(role: string): string {
  return ROLE_TITLES[role] ?? role;
}

/** Pipeline order, which is the order the dots and the waterfall read in. */
export const ROLE_ORDER = [
  "change-analyst",
  "impact-mapper",
  "docs-updater",
  "changelog-author",
  "coordinator",
] as const;
