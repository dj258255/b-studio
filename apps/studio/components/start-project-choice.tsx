import Link from "next/link";
import type { ProjectChoice } from "@/lib/server/workspace-entry";

/**
 * 쓰던 세션이 없는 첫 실행에서 프로젝트가 둘 이상일 때 첫 화면(`/`)이 보여준다(#749). 이름순 첫 프로젝트를 고르지도
 * 않았는데 켜면 ADR-104가 막은 헛된 기동과 같다. 고르면 그 프로젝트의 첫 화면(`/?project=`)으로 가고, 거기서 켠다.
 * 링크만 두어 고르기 전에는 세션을 만들지 않는다.
 */
export function StartProjectChoice({ projects }: { projects: readonly ProjectChoice[] }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold text-muted">b-studio</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">어떤 프로젝트로 시작할까요?</h1>
      <p className="mt-3 text-sm leading-6 text-muted">고르면 그 프로젝트의 샌드박스를 켭니다. 켜는 동안 요청을 적을 수 있습니다.</p>
      <ul className="glass-soft mt-6 rounded-panel p-2">
        {projects.map((project) => (
          <li key={project.id}>
            <Link href={`/?project=${encodeURIComponent(project.id)}`} className="tap-target flex items-baseline gap-2 rounded-control px-3 py-2 text-sm hover:bg-panel">
              <span className="truncate font-medium">{project.name}</span>
              {project.name !== project.id && <span className="truncate text-xs text-muted">{project.id}</span>}
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-muted">
        다른 폴더를 열거나 비교·병렬로 시작하려면{" "}
        <Link href="/start" className="underline underline-offset-2 hover:text-ink">
          새로 시작
        </Link>
        으로 가세요.
      </p>
    </main>
  );
}
