import { Page } from "@/components/dashboard/Page";
import {
  HeadSkeleton,
  LoadingRegion,
  RowsSkeleton,
  StatsSkeleton,
} from "@/components/dashboard/Skeleton";

/**
 * What a dashboard page shows while the server is still rendering it.
 *
 * Every route under here is dynamic and reads the pipeline API before it can
 * draw anything, and with no loading boundary Next had nothing to prefetch and
 * nothing to show: a click in the sidebar looked ignored until the next page
 * arrived whole. This is that boundary. The sidebar and header belong to the
 * layout above it and stay put, so only the content column is stood in for.
 *
 * It covers the first visit to a project too - the project's own layout sits
 * inside this boundary, and its header cannot be drawn before the project is
 * resolved. Moving between a project's sections is the project's own
 * `loading.tsx`, which keeps that header on screen.
 */
export default function DashboardLoading() {
  return (
    <Page>
      <LoadingRegion label="Loading this page">
        <HeadSkeleton />
        <StatsSkeleton />
        <RowsSkeleton />
      </LoadingRegion>
    </Page>
  );
}
