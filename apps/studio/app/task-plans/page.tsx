import Link from 'next/link';
import { TaskPlanWorkbench } from '@/components/task-plan-workbench';
import { pageUser } from '@/lib/server/access';
import { studioCapabilities } from '@/lib/server/capabilities';
import { listSelectableModels } from '@/lib/server/model-picker';
import { listModelOptions } from '@/lib/server/model-registry';
import { canPublishIssues, listProjects } from '@/lib/server/projects';
import { planModelAlias } from '@/lib/task-plan-types';
import { listTaskPlans, PLAN_LIMITS } from '@/lib/server/task-plans';

export default async function TaskPlansPage(props: { searchParams: Promise<{ id?: string | string[] }> }) {
  const requested = (await props.searchParams).id;
  const selectedId = Array.isArray(requested) ? requested[0] : requested;
  const user = await pageUser();
  const projects = await listProjects();
  // "이슈로 올리기"를 보일지 정하려면 프로젝트마다 원격 저장소·토큰을 확인해야 한다. 작업 분해 화면에서만 계산한다
  const publishable = await Promise.all(
    projects.map(async (project) => ({ ...project, canPublishIssues: project.error ? false : await canPublishIssues(project.id) })),
  );
  const models = listModelOptions();
  const initial = listTaskPlans(user);
  // 계획을 어떻게 받을 수 있는지는 서버가 정한다(api=모델 선택, claude-code=이 PC의 구독 CLI, 그 밖=고정 계획만)
  const capabilities = studioCapabilities();
  const planner = {
    mode: capabilities.mode,
    enabled: capabilities.split.enabled,
    ...(capabilities.split.reason ? { reason: capabilities.split.reason } : {}),
  };
  // "새 작업 분해" 폼의 모델·노력 단계 기본값. 방금 이 화면으로 넘어온 계획(?id=, 나눠서 병렬 제안 수락)이 있으면
  // 그 계획이 이어받은 세션 값을 그대로 보여 준다 — 폼에서 다시 계획을 만들 때도 같은 모델·노력으로 시작한다
  const selected = initial.find((plan) => plan.id === selectedId) ?? initial[0];
  const modelPicker = await listSelectableModels(capabilities.mode, selected ? planModelAlias(selected.modelId) : undefined, selected?.effort);

  return (
    <main className="mx-auto max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-muted">b-studio / 나눠서 병렬</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">한 요청을 나눠 동시에 실행하고 합친 결과를 다시 검증합니다</h1>
        </div>
        <Link href="/work" className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel">
          작업 목록
        </Link>
      </header>
      <TaskPlanWorkbench
        projects={publishable}
        models={models}
        initialPlans={initial}
        initialSelectedId={selectedId}
        planner={planner}
        limits={PLAN_LIMITS}
        modelPicker={modelPicker}
      />
    </main>
  );
}
