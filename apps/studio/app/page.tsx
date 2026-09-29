import { WorkspaceLauncher } from "@/components/workspace-launcher";

/**
 * 앱의 첫 화면. 입력창 대신 마지막 프로젝트의 개발 화면(대화+미리보기)을 바로 연다(ADR-066).
 * 세션을 고르고 샌드박스를 켜는 일은 화면이 POST /api/workspace로 요청한다 — 이 페이지를 미리 읽어도 세션이 생기지 않게 한다.
 * `?project=<id>`면 그 프로젝트의 개발 화면을 연다.
 */
export default async function HomePage(props: { searchParams: Promise<{ project?: string | string[] }> }) {
  const requested = (await props.searchParams).project;
  const projectId = Array.isArray(requested) ? requested[0] : requested;
  return <WorkspaceLauncher {...(projectId ? { projectId } : {})} />;
}
