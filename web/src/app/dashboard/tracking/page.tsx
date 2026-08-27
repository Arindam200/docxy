import { fetchTracking } from "@/lib/docxy";
import { Page, PageHead } from "@/components/dashboard/Page";
import { TrackingPanel } from "@/components/dashboard/TrackingPanel";

export const dynamic = "force-dynamic";

export default async function TrackingPage() {
  const tracking = await fetchTracking();

  return (
    <Page>
      <PageHead
        title="Tracking"
        lede="What the pipeline watches: documentation roots, the changelog, and the symbol-to-doc knowledge map it has learned."
      />
      <TrackingPanel tracking={tracking} expanded />
    </Page>
  );
}
