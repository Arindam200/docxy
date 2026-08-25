import { fetchRuns } from "@/lib/docxy";
import { Page, PageHead } from "@/components/dashboard/Page";
import { RunTimeline } from "@/components/dashboard/RunTimeline";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const runs = await fetchRuns();
  const list = (runs ?? []).sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return (
    <Page>
      <PageHead title="Activity" lede="Every pipeline run, newest first.">
        <span className="text-xs text-muted tabular-nums">{list.length} runs</span>
      </PageHead>
      <RunTimeline runs={list} />
    </Page>
  );
}
