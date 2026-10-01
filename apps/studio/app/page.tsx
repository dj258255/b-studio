import { redirect } from "next/navigation";
import { ResumeSessionChoice } from "@/components/resume-session-choice";
import { WorkspaceLauncher } from "@/components/workspace-launcher";
import { pageUser } from "@/lib/server/access";
import { findWorkspaceChoice } from "@/lib/server/workspace-entry";

/**
 * 앱의 첫 화면. 입력창 대신 마지막 프로젝트의 개발 화면(대화+미리보기)을 바로 연다(ADR-066).
 * 켜진 개발 세션이 있으면 서버에서 바로 그 화면으로 보낸다(읽기만 하므로 GET에서 해도 된다, ADR-069).
 * 지연 기동·중지된 세션이 있으면(서버를 막 재시작한 뒤가 보통 이렇다) 곧바로 되살리지 않고 "이어서 열기"
 * 선택을 보여준다(ADR-104) — 다른 프로젝트로 시작하려는 사람에게 샌드박스를 헛켜지 않는다.
 * 고를 세션이 없으면(새 프로젝트) 화면이 POST /api/workspace로 요청한다 — 이 페이지를 미리 읽어도 세션이 생기지 않게 한다.
 * `?project=<id>`면 그 프로젝트의 개발 화면을 연다.
 */
export default async function HomePage(props: { searchParams: Promise<{ project?: string | string[] }> }) {
  const requested = (await props.searchParams).project;
  const projectId = Array.isArray(requested) ? requested[0] : requested;
  const viewer = await pageUser();
  const choice = await findWorkspaceChoice(viewer, projectId ? { projectId } : {});
  if (choice.kind === "live") redirect(`/sessions/${choice.id}`);
  if (choice.kind === "resumable") return <ResumeSessionChoice projectId={choice.projectId} projectName={choice.projectName} updatedAt={choice.updatedAt} />;
  return <WorkspaceLauncher {...(choice.projectId ? { projectId: choice.projectId } : {})} />;
}
