import { fetchInstructions } from "@/lib/docxy";
import { Page, PageHead } from "@/components/dashboard/Page";
import { InstructionsEditor } from "@/components/dashboard/InstructionsEditor";

export const dynamic = "force-dynamic";

export default async function InstructionsPage() {
  const instructions = await fetchInstructions();

  return (
    <Page>
      <PageHead
        title="Custom instructions"
        lede="Standing guidance every run hands to the docs agent — voice, conventions, things to never touch. Saved instantly, applied from the next run on."
      />
      <InstructionsEditor initial={instructions?.instructions ?? ""} updatedAt={instructions?.updatedAt ?? null} />
    </Page>
  );
}
