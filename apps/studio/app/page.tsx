import { listProjects } from "@/lib/server/projects";
import { StartSessionButton } from "@/components/start-session-button";

export default async function HomePage() {
  const projects = await listProjects();
  const demo = process.env.B_STUDIO_MODE === "demo";

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-sm font-semibold text-muted">b-studio</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">프로젝트를 열어 샌드박스를 시작하세요</h1>
      <p className="mt-3 max-w-[60ch] leading-7 text-muted">
        세션마다 프로젝트 복사본으로 서비스를 띄웁니다. 에이전트가 작업을 끝내면 스튜디오가 바뀐 서비스를 재시작하고 API 계약을 비교해,
        통과한 결과만 완료로 보여줍니다.
      </p>

      <p className="mt-6 border-l-2 border-line pl-3 text-sm text-muted">
        {demo
          ? "데모 모드로 실행 중입니다. 준비된 요청을 스크립트로 실행하므로 API 키가 필요 없습니다."
          : "요청은 Claude API로 처리합니다. 서버에 ANTHROPIC_API_KEY가 있어야 합니다."}
      </p>

      <ul className="mt-10 divide-y divide-line border-y border-line">
        {projects.length === 0 && (
          <li className="py-6 text-muted">열 수 있는 프로젝트가 없습니다. studio.yaml이 있는 폴더를 B_STUDIO_PROJECTS_DIR에 두세요.</li>
        )}
        {projects.map((project) => (
          <li key={project.id} className="flex flex-wrap items-center gap-4 py-5">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">{project.name}</h2>
              {project.error ? (
                <p className="mt-1 text-sm text-fail">{project.error}</p>
              ) : (
                <p className="mt-1 text-sm text-muted">
                  {project.services.map((service) => `${service.name} (${service.template})`).join(", ")}
                </p>
              )}
            </div>
            {!project.error && <StartSessionButton projectId={project.id} />}
          </li>
        ))}
      </ul>
    </main>
  );
}
