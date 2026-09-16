'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ModelProfile } from '@b-studio/agent';
import type { ProjectSummary } from '@/lib/studio-events';
import type { TaskPlanStatus, TaskPlanStepStatus, TaskPlanView } from '@/lib/task-plan-types';

type ModelOption = ModelProfile & { configured: boolean };

const PLAN_STATUS: Record<TaskPlanStatus, string> = {
  planning: '작업 계획 중',
  running: '레인 실행 중',
  integrating: '결과 통합 중',
  done: '통합 검증 통과',
  failed: '중단됨',
};

const STEP_STATUS: Record<TaskPlanStepStatus, string> = {
  queued: '대기',
  booting: '샌드박스 준비 중',
  running: '실행 중',
  done: '검증 통과',
  failed: '실패',
  skipped: '건너뜀',
};

const STEP_COLOR: Record<TaskPlanStepStatus, string> = {
  queued: 'text-muted',
  booting: 'text-wait',
  running: 'text-wait',
  done: 'text-pass',
  failed: 'text-fail',
  skipped: 'text-muted',
};

export function TaskPlanWorkbench({ projects, models, initialPlans }: { projects: ProjectSummary[]; models: ModelOption[]; initialPlans: TaskPlanView[] }) {
  const readyModels = models.filter((model) => model.configured && model.enabled !== false && model.capabilities.includes('tools'));
  const [projectId, setProjectId] = useState(projects.find((project) => !project.error)?.id ?? '');
  const [modelId, setModelId] = useState(readyModels[0]?.id ?? '');
  const [request, setRequest] = useState('');
  const [plans, setPlans] = useState(initialPlans);
  const [selectedId, setSelectedId] = useState(initialPlans[0]?.id);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const selected = plans.find((plan) => plan.id === selectedId);
  const active = selected !== undefined && !['done', 'failed'].includes(selected.status);

  useEffect(() => {
    if (!selectedId || !active) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/task-plans/${encodeURIComponent(selectedId)}`, { cache: 'no-store' });
        if (!response.ok) return;
        const plan = (await response.json()) as TaskPlanView;
        setPlans((current) => [plan, ...current.filter((entry) => entry.id !== plan.id)]);
      } catch {
        // 일시적인 폴링 실패는 다음 주기에 다시 시도한다
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [active, selectedId]);

  async function create() {
    setCreating(true);
    setError(undefined);
    try {
      const response = await fetch('/api/task-plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, request, modelId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result && typeof result.error === 'string' ? result.error : '요청을 처리하지 못했습니다');
      const plan = result as TaskPlanView;
      setPlans((current) => [plan, ...current.filter((entry) => entry.id !== plan.id)]);
      setSelectedId(plan.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[24rem_minmax(0,1fr)]">
      <aside className="space-y-4 xl:sticky xl:top-5">
        <section className="glass rounded-2xl p-5">
          <h2 className="text-lg font-semibold">새 작업 분해</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            모델이 작업·쓰기 범위·의존 관계를 제안하고 스튜디오가 검증합니다. 이어진 작업은 한 세션에서 차례로, 독립 작업은 다른 세션에서 동시에 돌린 뒤 결과를 새 세션에서 합쳐 다시 검증합니다.
          </p>

          <label className="mt-5 block text-sm font-medium" htmlFor="plan-project">프로젝트</label>
          <select id="plan-project" value={projectId} onChange={(event) => setProjectId(event.target.value)} className="mt-1 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm">
            {projects.filter((project) => !project.error).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>

          <label className="mt-4 block text-sm font-medium" htmlFor="plan-model">모델</label>
          <select id="plan-model" value={modelId} onChange={(event) => setModelId(event.target.value)} className="mt-1 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm">
            {readyModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
          {readyModels.length === 0 && <p className="mt-1 text-xs text-fail">도구 호출을 지원하고 API 키가 설정된 모델이 없습니다</p>}

          <label className="mt-4 block text-sm font-medium" htmlFor="plan-request">요청</label>
          <textarea
            id="plan-request"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            rows={7}
            placeholder="여러 화면·API에 걸친 기능과 완료 조건을 적어 주세요"
            className="mt-1 w-full resize-y rounded-xl border border-line bg-panel px-3 py-2 text-sm leading-6 placeholder:text-muted"
          />
          <button
            type="button"
            disabled={!projectId || !modelId || !request.trim() || creating}
            onClick={() => void create()}
            className="mt-4 w-full rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-panel shadow-sm hover:bg-ink/85 disabled:opacity-50"
          >
            {creating ? '계획을 요청하는 중' : '작업 계획 받고 실행'}
          </button>
          {error && <p className="mt-3 text-sm text-fail">{error}</p>}
        </section>

        {plans.length > 0 && (
          <section className="glass rounded-2xl p-4">
            <h2 className="px-1 text-sm font-semibold">최근 작업 분해</h2>
            <ul className="mt-2 max-h-72 space-y-1 overflow-auto">
              {plans.map((plan) => (
                <li key={plan.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(plan.id)}
                    className={`w-full rounded-xl px-3 py-2 text-left text-sm ${selectedId === plan.id ? 'bg-panel shadow-sm ring-1 ring-line' : 'hover:bg-panel/60'}`}
                  >
                    <span className="block truncate font-medium">{plan.request}</span>
                    <span className="mt-0.5 block text-xs text-muted">{plan.projectId} · {PLAN_STATUS[plan.status]} · 레인 {plan.lanes.length}개</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>

      <section className="min-w-0">
        {!selected ? (
          <div className="glass flex min-h-[30rem] items-center justify-center rounded-2xl p-8 text-center text-muted">
            <div><p className="font-medium text-ink">실행한 작업 분해가 아직 없습니다</p><p className="mt-2 text-sm">여러 영역에 걸친 요청을 나눠 동시에 실행해 보세요.</p></div>
          </div>
        ) : (
          <PlanResult plan={selected} />
        )}
      </section>
    </div>
  );
}

function PlanResult({ plan }: { plan: TaskPlanView }) {
  return (
    <div className="space-y-4">
      <header className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted">{plan.projectId} · 작업 분해 {plan.id} · {plan.modelId}</p>
            <h2 className="mt-1 text-xl font-semibold leading-8 whitespace-pre-wrap">{plan.request}</h2>
          </div>
          <span className={`glass-soft rounded-full px-3 py-1.5 text-sm font-medium ${plan.status === 'done' ? 'text-pass' : plan.status === 'failed' ? 'text-fail' : 'text-wait'}`}>{PLAN_STATUS[plan.status]}</span>
        </div>
        {plan.error && <p className="mt-3 text-sm text-fail whitespace-pre-wrap">{plan.error}</p>}
        <p className="mt-3 text-sm text-muted">통합 결과는 자동으로 병합·푸시·배포하지 않습니다. 통합 세션에서 diff와 검증 근거를 확인한 뒤 내보내세요.</p>
      </header>

      <div className={`grid gap-4 ${plan.lanes.length >= 3 ? '2xl:grid-cols-3' : 'lg:grid-cols-2'}`}>
        {plan.lanes.map((lane) => (
          <article key={lane.id} className="glass min-w-0 rounded-2xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-lg font-semibold">{lane.id}</p>
                <p className="mt-0.5 break-all font-mono text-xs text-muted">쓰기 범위: {lane.paths.join(', ')}</p>
              </div>
              <span className={`shrink-0 text-sm font-medium ${STEP_COLOR[lane.status]}`}>{STEP_STATUS[lane.status]}</span>
            </div>
            <ol className="mt-4 space-y-2">
              {lane.tasks.map((task, index) => (
                <li key={task.id} className="rounded-xl border border-line bg-panel p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{index + 1}. {task.title}</span>
                    <span className={`shrink-0 text-xs font-medium ${STEP_COLOR[task.status]}`}>{STEP_STATUS[task.status]}</span>
                  </div>
                  <p className="mt-1 break-all font-mono text-xs text-muted">{task.paths.join(', ')}{task.dependsOn.length > 0 ? ` · 선행: ${task.dependsOn.join(', ')}` : ''}</p>
                  {task.summary && <p className="mt-2 text-xs leading-5 whitespace-pre-wrap text-muted">{task.summary}</p>}
                  {task.checkpoint && <p className="mt-1 text-xs text-muted">체크포인트 <span className="font-mono text-ink">{task.checkpoint.shortSha}</span></p>}
                </li>
              ))}
            </ol>
            {lane.error && <p className="mt-3 text-xs text-fail whitespace-pre-wrap">{lane.error}</p>}
            {lane.sessionId && <Link href={`/sessions/${lane.sessionId}`} className="mt-4 inline-block rounded-full border border-line px-3 py-1.5 text-sm font-medium hover:border-ink">레인 세션 보기</Link>}
          </article>
        ))}
      </div>

      {plan.integration && (
        <article className={`glass rounded-2xl p-5 ${plan.integration.status === 'done' ? 'ring-2 ring-pass' : ''}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-lg font-semibold">통합</p>
              <p className="mt-0.5 text-sm text-muted">레인들의 최종 파일 {plan.integration.files.length}개를 새 세션에서 같은 게이트로 다시 검증합니다</p>
            </div>
            <span className={`shrink-0 text-sm font-medium ${STEP_COLOR[plan.integration.status]}`}>{STEP_STATUS[plan.integration.status]}</span>
          </div>
          {plan.integration.files.length > 0 && <p className="mt-3 break-all font-mono text-xs text-muted">{plan.integration.files.join(', ')}</p>}
          {(plan.integration.deleted ?? []).length > 0 && (
            <p className="mt-1 break-all font-mono text-xs text-fail">삭제 {plan.integration.deleted.length}개: {plan.integration.deleted.join(', ')}</p>
          )}
          {plan.integration.error && <p className="mt-3 text-sm text-fail whitespace-pre-wrap">{plan.integration.error}</p>}
          {plan.integration.checkpoint && <p className="mt-3 text-xs text-muted">체크포인트 <span className="font-mono text-ink">{plan.integration.checkpoint.shortSha}</span></p>}
          {plan.integration.sessionId && <Link href={`/sessions/${plan.integration.sessionId}`} className="mt-4 inline-block rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-panel">통합 세션·diff 보기</Link>}
        </article>
      )}
    </div>
  );
}
