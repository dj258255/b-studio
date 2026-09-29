import Link from 'next/link';
import { TaskPlanWorkbench } from '@/components/task-plan-workbench';
import { pageUser } from '@/lib/server/access';
import { listModelOptions } from '@/lib/server/model-registry';
import { canPublishIssues, listProjects } from '@/lib/server/projects';
import { listTaskPlans } from '@/lib/server/task-plans';

export default async function TaskPlansPage() {
  const user = await pageUser();
  const projects = await listProjects();
  // "이슈로 올리기"를 보일지 정하려면 프로젝트마다 원격 저장소·토큰을 확인해야 한다. 작업 분해 화면에서만 계산한다
  const publishable = await Promise.all(
    projects.map(async (project) => ({ ...project, canPublishIssues: project.error ? false : await canPublishIssues(project.id) })),
  );
  const models = listModelOptions();
  const initial = listTaskPlans(user);

  return (
    <main className="mx-auto max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-muted">b-studio / 작업 분해</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">한 요청을 나눠 동시에 실행하고 합친 결과를 다시 검증합니다</h1>
        </div>
        <Link href="/" className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel">
          프로젝트로 돌아가기
        </Link>
      </header>
      <TaskPlanWorkbench projects={publishable} models={models} initialPlans={initial} />
    </main>
  );
}
