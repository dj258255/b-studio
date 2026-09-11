import { notFound } from "next/navigation";
import { Workbench } from "@/components/workbench";
import { getSnapshot, recoverSessions } from "@/lib/server/sessions";

export default async function SessionPage(props: PageProps<"/sessions/[id]">) {
  const { id } = await props.params;
  await recoverSessions();
  const snapshot = getSnapshot(id);
  if (!snapshot) notFound();

  return <Workbench initial={snapshot} />;
}
