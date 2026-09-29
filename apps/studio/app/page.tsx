import { redirect } from "next/navigation";
import { WorkspaceLauncher } from "@/components/workspace-launcher";
import { pageUser } from "@/lib/server/access";
import { findOpenWorkspace } from "@/lib/server/workspace-entry";

/**
 * 앱의 첫 화면. 입력창 대신 마지막 프로젝트의 개발 화면(대화+미리보기)을 바로 연다(ADR-066).
 * 켜진 개발 세션이 있으면 서버에서 바로 그 화면으로 보낸다(읽기만 하므로 GET에서 해도 된다, ADR-069).
 * 켜거나 새로 만들어야 하면 화면이 POST /api/workspace로 요청한다 — 이 페이지를 미리 읽어도 세션이 생기지 않게 한다.
 * `?project=<id>`면 그 프로젝트의 개발 화면을 연다.
 */
export default async function HomePage(props: { searchParams: Promise<{ project?: string | string[] }> }) {
  const requested = (await props.searchParams).project;
  const projectId = Array.isArray(requested) ? requested[0] : requested;
  const viewer = await pageUser();
  const open = await findOpenWorkspace(viewer, projectId ? { projectId } : {});
  if (open) redirect(`/sessions/${open}`);
  return <WorkspaceLauncher {...(projectId ? { projectId } : {})} />;
}
