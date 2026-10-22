import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LaunchNotice } from "@/components/launch-notice";
import { Workbench } from "@/components/workbench";
import { canManageSession, pageUser } from "@/lib/server/access";
import { authConfig } from "@/lib/server/auth";
import { getSnapshot, recoverSessions } from "@/lib/server/sessions";

/** 탭 제목에 프로젝트 이름을 둔다. 세션을 여러 개 열어도 탭으로 구분된다 */
export async function generateMetadata(props: PageProps<"/sessions/[id]">): Promise<Metadata> {
  await pageUser();
  const { id } = await props.params;
  await recoverSessions();
  const snapshot = getSnapshot(id);
  return { title: snapshot ? `${snapshot.projectName} 개발 화면` : "세션을 찾지 못했습니다" };
}

export default async function SessionPage(props: PageProps<"/sessions/[id]">) {
  const viewer = await pageUser();
  const { id } = await props.params;
  await recoverSessions();
  const snapshot = getSnapshot(id);
  if (!snapshot) notFound();
  const mode = authConfig().mode;

  return (
    <>
      <LaunchNotice sessionId={snapshot.id} />
      <Workbench
        initial={snapshot}
        access={{
          viewer: mode === "none" ? undefined : viewer,
          owner: snapshot.owner,
          canManage: canManageSession(viewer, snapshot.owner),
          canLogout: mode === "token",
        }}
      />
    </>
  );
}
