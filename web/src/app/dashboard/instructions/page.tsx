import { redirect } from "next/navigation";

export default function InstructionsPage() {
  redirect("/dashboard/settings#instructions");
}
