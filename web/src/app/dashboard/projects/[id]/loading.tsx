import {
  HeadSkeleton,
  LoadingRegion,
  RowsSkeleton,
  StatsSkeleton,
} from "@/components/dashboard/Skeleton";

/**
 * What one of a project's sections shows while it renders.
 *
 * Nested inside the project layout, so the project's name, its repository link
 * and the content column are already on screen; this only stands in for the
 * section below them. That is the move people make most - Overview to Activity
 * to a run and back - and each one reads the pipeline before it can draw, so
 * without this the header sat there unchanged until the new section arrived
 * whole and nothing said the click had registered.
 */
export default function ProjectSectionLoading() {
  return (
    <LoadingRegion label="Loading this section">
      <HeadSkeleton level={2} />
      <StatsSkeleton />
      <RowsSkeleton />
    </LoadingRegion>
  );
}
