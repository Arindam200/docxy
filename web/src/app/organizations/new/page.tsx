import { redirect } from "next/navigation";

// Old links use onboarding's membership check. Only first-time accounts see
// the full-page form; returning members go back to their dashboard.
export default function NewOrganizationPage() {
  redirect("/onboarding");
}
