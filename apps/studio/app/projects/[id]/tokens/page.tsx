import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectTokenView } from "@/components/project-token-view";
import { pageUser } from "@/lib/server/access";
import { StudioError } from "@/lib/server/errors";
import { projectTokenReport, type ProjectTokenReport } from "@/lib/server/project-token-report";

/** 프로젝트 토큰 보고서. 한 프로젝트의 모든 세션(레인·통합·Fleet 멤버 포함) 기록을 모아 보여 준다 */
export default async function ProjectTokensPage(props: PageProps<"/projects/[id]/tokens">) {
  const viewer = await pageUser();
  const { id } = await props.params;
  const query = await props.searchParams;
  const read = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  // JSX는 try 밖에서 만든다(React는 렌더를 나중에 하므로 try/catch가 오류를 잡지 못한다)
  const loaded = await loadReport(id, viewer, read(query.from), read(query.to));
  if (loaded.kind === "missing") notFound();
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Link href="/start" className="text-sm text-muted hover:text-ink">
        ← 새로 시작
      </Link>
      {loaded.kind === "bad-range" ? (
        <div className="mt-4">
          <p role="alert" className="glass rounded-panel px-5 py-4 text-sm">
            {loaded.message}
          </p>
          <Link href={`/projects/${encodeURIComponent(id)}/tokens`} className="mt-3 inline-block text-sm text-muted hover:text-ink">
            전체 기간 보고서 보기
          </Link>
        </div>
      ) : (
        <ProjectTokenView report={loaded.report} />
      )}
    </main>
  );
}

/** 보고서를 읽어 화면이 그릴 상태로 접는다. 없는 프로젝트와 형식이 틀린 기간은 화면이 안내한다 */
async function loadReport(
  id: string,
  viewer: string,
  from: string | undefined,
  to: string | undefined,
): Promise<{ kind: "ok"; report: ProjectTokenReport } | { kind: "missing" } | { kind: "bad-range"; message: string }> {
  try {
    return { kind: "ok", report: await projectTokenReport(id, { viewer, from, to }) };
  } catch (error) {
    if (error instanceof StudioError && error.status === 404) return { kind: "missing" };
    if (error instanceof StudioError && error.status === 400) return { kind: "bad-range", message: error.message };
    throw error;
  }
}
