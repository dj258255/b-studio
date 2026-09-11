import { notFound } from "next/navigation";
import { Workbench } from "@/components/workbench";
import { canManageSession, pageUser } from "@/lib/server/access";
import { authConfig } from "@/lib/server/auth";
import { getSnapshot, recoverSessions } from "@/lib/server/sessions";

export default async function SessionPage(props: PageProps<"/sessions/[id]">) {
  const viewer = await pageUser();
  const { id } = await props.params;
  await recoverSessions();
  const snapshot = getSnapshot(id);
  if (!snapshot) notFound();
  const mode = authConfig().mode;

  return (
    <Workbench
      initial={snapshot}
      access={{
        viewer: mode === "none" ? undefined : viewer,
        owner: snapshot.owner,
        canManage: canManageSession(viewer, snapshot.owner),
        canLogout: mode === "token",
      }}
    />
  );
}
