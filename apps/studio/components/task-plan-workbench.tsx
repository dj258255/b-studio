'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ModelProfile } from '@b-studio/agent';
import type { ProjectSummary, SessionMode } from '@/lib/studio-events';
import type { TaskPlanMetrics } from '@/lib/task-plan-metrics';
import type { TaskPlanStatus, TaskPlanStepStatus, TaskPlanStrategy, TaskPlanView } from '@/lib/task-plan-types';
import { describeTokens, hasTokens } from '@/lib/usage';
import { PlanGraphView } from './plan-graph';

const STRATEGY_LABEL: Record<TaskPlanStrategy, string> = {
  S2: 'S2 계약 먼저',
  S3: 'S3 게시판',
  S4: 'S4 통합 후 수리',
  S5: 'S5 실패 서명만',
};

type ModelOption = ModelProfile & { configured: boolean };

const PLAN_STATUS: Record<TaskPlanStatus, string> = {
  planning: '작업 계획 중',
  awaiting_approval: '승인 대기',
  running: '레인 실행 중',
  integrating: '결과 통합 중',
  interrupted: '중단됨 (이어서 가능)',
  done: '통합 검증 통과',
  failed: '중단됨',
  rejected: '거부됨',
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

/** 이 서버에서 계획을 어떻게 받는지(서버 capabilities에서 온다). enabled=false면 이 화면은 고정 계획만 보여 준다 */
export interface PlannerCapability {
  mode: SessionMode;
  enabled: boolean;
  reason?: string;
}

/** 이 서버의 계획 상한(설정에서 온다). 화면이 몇 개까지 계획하는지 그대로 보여 준다 */
export interface PlanLimitView {
  maxLanes: number;
  maxTasks: number;
}

export function TaskPlanWorkbench({
  projects,
  models,
  initialPlans,
  planner,
  limits,
}: {
  projects: ProjectSummary[];
  models: ModelOption[];
  initialPlans: TaskPlanView[];
  planner: PlannerCapability;
  limits: PlanLimitView;
}) {
  // 로컬 Claude Code 구독 모드는 모델 레지스트리가 아니라 그 CLI가 모델을 정한다(모델 선택 칸을 쓰지 않는다)
  const localCli = planner.enabled && planner.mode === 'claude-code';
  const readyModels = models.filter((model) => model.configured && model.enabled !== false && model.capabilities.includes('tools'));
  const [projectId, setProjectId] = useState(projects.find((project) => !project.error)?.id ?? '');
  const [modelId, setModelId] = useState(readyModels[0]?.id ?? '');
  const [request, setRequest] = useState('');
  const [plans, setPlans] = useState(initialPlans);
  const [selectedId, setSelectedId] = useState(initialPlans[0]?.id);
  const [creating, setCreating] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string>();
  const selected = plans.find((plan) => plan.id === selectedId);
  // 승인 대기·중단됨·거부됨은 사람이 움직이기 전까지 바뀌지 않으므로 폴링하지 않는다
  const active = selected !== undefined && !['done', 'failed', 'rejected', 'awaiting_approval', 'interrupted'].includes(selected.status);

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
        // 로컬 CLI 모드는 모델을 보내지 않는다(그 CLI가 정한다)
        body: JSON.stringify({ projectId, request, ...(localCli ? {} : { modelId }) }),
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

  async function decide(approve: boolean, reason?: string, publishIssues?: boolean) {
    if (!selectedId) return;
    setDeciding(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/task-plans/${encodeURIComponent(selectedId)}/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(approve ? { approve: true, publishIssues: publishIssues === true } : { approve: false, reason }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result && typeof result.error === 'string' ? result.error : '요청을 처리하지 못했습니다');
      const plan = result as TaskPlanView;
      setPlans((current) => [plan, ...current.filter((entry) => entry.id !== plan.id)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeciding(false);
    }
  }

  async function resume() {
    if (!selectedId) return;
    setDeciding(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/task-plans/${encodeURIComponent(selectedId)}/resume`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result && typeof result.error === 'string' ? result.error : '요청을 처리하지 못했습니다');
      const plan = result as TaskPlanView;
      setPlans((current) => [plan, ...current.filter((entry) => entry.id !== plan.id)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeciding(false);
    }
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[24rem_minmax(0,1fr)]">
      <aside className="space-y-4 xl:sticky xl:top-5">
        <section className="glass rounded-panel p-5">
          <h2 className="text-lg font-semibold">새 작업 분해</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            모델이 작업·쓰기 범위·의존 관계를 제안하고 스튜디오가 검증합니다. 이어진 작업은 한 세션에서 차례로, 독립 작업은 다른 세션에서 동시에 돌린 뒤 결과를 새 세션에서 합쳐 다시 검증합니다.
          </p>
          <p className="mt-1 text-xs text-muted">
            이 서버는 작업 {limits.maxTasks}개·레인 {limits.maxLanes}개까지 계획합니다(독립 레인은 최대 {limits.maxLanes}개가 동시에 돕니다).
          </p>

          <label className="mt-5 block text-sm font-medium" htmlFor="plan-project">프로젝트</label>
          <select id="plan-project" value={projectId} onChange={(event) => setProjectId(event.target.value)} className="mt-1 w-full rounded-control border border-line bg-panel px-3 py-2 text-sm">
            {projects.filter((project) => !project.error).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>

          {localCli ? (
            <>
              <p className="mt-4 text-sm font-medium">모델</p>
              <p className="mt-1 rounded-control border border-line bg-panel px-3 py-2 text-sm leading-6 text-muted">
                이 PC에 로그인한 Claude Code 구독으로 계획을 받습니다. 모델은 <span className="font-mono">B_STUDIO_CLAUDE_CODE_MODEL</span> 또는 계정 기본값입니다.
              </p>
            </>
          ) : (
            <>
              <label className="mt-4 block text-sm font-medium" htmlFor="plan-model">모델</label>
              <select id="plan-model" value={modelId} onChange={(event) => setModelId(event.target.value)} className="mt-1 w-full rounded-control border border-line bg-panel px-3 py-2 text-sm">
                {readyModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
              {readyModels.length === 0 && <p className="mt-1 text-xs text-fail">도구 호출을 지원하고 API 키가 설정된 모델이 없습니다</p>}
            </>
          )}
          {!planner.enabled && <p className="mt-1 text-xs text-wait">{planner.reason ?? '이 모드에서는 모델에게 계획을 받을 수 없습니다'}</p>}

          <label className="mt-4 block text-sm font-medium" htmlFor="plan-request">요청</label>
          <textarea
            id="plan-request"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            rows={7}
            placeholder="여러 화면·API에 걸친 기능과 완료 조건을 적어 주세요"
            className="mt-1 w-full resize-y rounded-control border border-line bg-panel px-3 py-2 text-sm leading-6 placeholder:text-muted"
          />
          <button
            type="button"
            disabled={!planner.enabled || !projectId || (!localCli && !modelId) || !request.trim() || creating}
            onClick={() => void create()}
            className="mt-4 w-full rounded-control bg-ink px-4 py-2.5 text-sm font-semibold text-panel hover:bg-ink/85 disabled:opacity-50"
          >
            {creating ? '계획을 요청하는 중' : '작업 계획 받기'}
          </button>
          {error && <p className="mt-3 text-sm text-fail">{error}</p>}
        </section>

        {plans.length > 0 && (
          <section className="glass rounded-panel p-4">
            <h2 className="px-1 text-sm font-semibold">최근 작업 분해</h2>
            <ul className="mt-2 max-h-72 space-y-1 overflow-auto">
              {plans.map((plan) => (
                <li key={plan.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(plan.id)}
                    className={`w-full rounded-control px-3 py-2 text-left text-sm ${selectedId === plan.id ? 'bg-panel ring-1 ring-line' : 'hover:bg-panel/60'}`}
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
          <div className="flex min-h-[30rem] items-center justify-center rounded-panel border border-line bg-panel p-8 text-center text-muted">
            <div><p className="font-medium text-ink">실행한 작업 분해가 아직 없습니다</p><p className="mt-2 text-sm">여러 영역에 걸친 요청을 나눠 동시에 실행해 보세요.</p></div>
          </div>
        ) : (
          <PlanResult
            plan={selected}
            canPublish={projects.find((project) => project.id === selected.projectId)?.canPublishIssues === true}
            deciding={deciding}
            onDecide={(approve, reason, publishIssues) => void decide(approve, reason, publishIssues)}
            onResume={() => void resume()}
          />
        )}
      </section>
    </div>
  );
}

/** 계획 카드의 토큰 합계. 모델별 합(usageByModel)이 있으면 모델마다 한 줄 더 적는다 */
export function PlanTokenTotals({ metrics }: { metrics?: TaskPlanMetrics }) {
  if (!metrics || !hasTokens(metrics.usage)) return null;
  const models = Object.entries(metrics.usageByModel ?? {});
  return (
    <div className="mt-3 text-sm text-muted">
      <p>토큰 합계 {describeTokens(metrics.usage)}</p>
      {models.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs">
          {models.map(([model, usage]) => (
            <li key={model}>
              <span className="font-mono text-ink">{model}</span> {describeTokens(usage)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanResult({
  plan,
  canPublish,
  deciding,
  onDecide,
  onResume,
}: {
  plan: TaskPlanView;
  /** 원격 저장소 + 토큰이 있어 "이슈로 올리기"를 고를 수 있는가 */
  canPublish: boolean;
  deciding: boolean;
  onDecide: (approve: boolean, reason?: string, publishIssues?: boolean) => void;
  onResume: () => void;
}) {
  const [reason, setReason] = useState('');
  const [publishIssues, setPublishIssues] = useState(true);
  /** 레인·통합 카드로 보는 기존 목록 보기와, 관계를 한 그림으로 보는 그래프 보기를 겹쳐 둔다 */
  const [view, setView] = useState<'list' | 'graph'>('list');
  /**
   * 레인 사이 계약(S2)은 아래 "레인 사이 계약" 절에서 본문·refs·출처를 보여 준다.
   * 같은 메모가 게시판 목록에도 나오면 두 번 보이므로, 게시판 목록에서는 플랫폼이 게시한 계약 메모를 뺀다
   * (S3에서 레인이 쓴 계약 메모는 게시판에 그대로 남는다 — 누가 언제 썼는지가 거기 있다).
   */
  const platformContracts = (plan.board?.notes ?? []).filter((note) => note.kind === 'contract' && note.by === 'platform');
  const showContracts = plan.contracts !== undefined || platformContracts.length > 0;
  const boardNotes = (plan.board?.notes ?? []).filter((note) => !showContracts || !(note.kind === 'contract' && note.by === 'platform'));
  return (
    <div className="space-y-4">
      {plan.status === 'interrupted' && (
        <section className="rounded-panel border border-line bg-panel p-5 ring-2 ring-wait">
          <h2 className="text-lg font-semibold">레인 결과가 남아 있습니다. 통합만 다시 시도할까요?</h2>
          <p className="mt-1 text-sm leading-6 text-muted">레인은 다시 돌리지 않고, 남겨 둔 레인 파일을 새 세션에서 같은 게이트로 다시 검증합니다.</p>
          <button
            type="button"
            disabled={deciding}
            onClick={onResume}
            className="mt-3 rounded-control bg-ink px-4 py-2.5 text-sm font-semibold text-panel hover:bg-ink/85 disabled:opacity-50"
          >
            통합 다시 시도
          </button>
        </section>
      )}

      {plan.status === 'awaiting_approval' && (
        <section className="rounded-panel border border-line bg-panel p-5 ring-2 ring-wait">
          <h2 className="text-lg font-semibold">이 계획대로 레인을 실행할까요?</h2>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="거부 사유 (선택)"
            className="mt-4 w-full rounded-control border border-line bg-panel px-3 py-2 text-sm placeholder:text-muted"
          />
          {canPublish && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={publishIssues} onChange={(event) => setPublishIssues(event.target.checked)} className="size-4" />
              이슈로 올리기 (추적 이슈와 작업별 하위 이슈를 원격 저장소에 만듭니다)
            </label>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={deciding}
              onClick={() => onDecide(true, undefined, canPublish && publishIssues)}
              className="rounded-control bg-ink px-4 py-2.5 text-sm font-semibold text-panel hover:bg-ink/85 disabled:opacity-50"
            >
              승인하고 실행
            </button>
            <button
              type="button"
              disabled={deciding}
              onClick={() => onDecide(false, reason)}
              className="rounded-control border border-line px-4 py-2.5 text-sm font-medium hover:border-ink disabled:opacity-50"
            >
              거부
            </button>
          </div>
        </section>
      )}

      <header className="glass rounded-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted">{plan.projectId} · 작업 분해 {plan.id} · {plan.modelId}</p>
            <h2 className="mt-1 text-xl font-semibold leading-8 whitespace-pre-wrap">{plan.request}</h2>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <span className={`glass-soft rounded-full px-3 py-1.5 text-sm font-medium ${plan.status === 'done' ? 'text-pass' : plan.status === 'failed' || plan.status === 'rejected' ? 'text-fail' : 'text-wait'}`}>{PLAN_STATUS[plan.status]}</span>
            <div className="glass-soft inline-flex rounded-control p-0.5 text-sm" role="group" aria-label="보기 방식">
              {(['list', 'graph'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={view === kind}
                  onClick={() => setView(kind)}
                  className={`rounded-md px-3 py-1 font-medium transition-colors ${view === kind ? 'bg-panel text-ink ring-1 ring-line' : 'text-muted hover:text-ink'}`}
                >
                  {kind === 'list' ? '목록' : '그래프'}
                </button>
              ))}
            </div>
          </div>
        </div>
        {plan.error && <p className="mt-3 text-sm text-fail whitespace-pre-wrap">{plan.error}</p>}
        {plan.rejectedReason && <p className="mt-3 text-sm text-fail whitespace-pre-wrap">거부 사유: {plan.rejectedReason}</p>}
        <PlanTokenTotals metrics={plan.metrics} />
        <p className="mt-3 text-sm text-muted">통합 결과는 자동으로 병합·푸시·배포하지 않습니다. 통합 세션에서 diff와 검증 근거를 확인한 뒤 내보내세요.</p>
      </header>

      {plan.issues && (
        <section className="rounded-panel border border-line bg-panel p-4 text-sm">
          <p className="font-medium">이슈</p>
          {plan.issues.tracking && (
            <p className="mt-1">
              추적 이슈{' '}
              <a href={plan.issues.tracking.url} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                #{plan.issues.tracking.number}
              </a>
            </p>
          )}
          {Object.values(plan.issues.tasks).length > 0 && (
            <p className="mt-1 text-muted">
              하위 이슈{' '}
              {Object.values(plan.issues.tasks).map((ref) => (
                <a key={ref.number} href={ref.url} target="_blank" rel="noreferrer" className="mr-2 font-medium underline underline-offset-2">
                  #{ref.number}
                </a>
              ))}
            </p>
          )}
          {plan.issues.error && <p className="mt-1 text-fail">이슈를 올리지 못했습니다: {plan.issues.error}</p>}
        </section>
      )}

      {plan.coordination && (
        <section className="glass rounded-panel p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">조율 게시판</h2>
            <span className="glass-soft rounded-full px-3 py-1 text-sm font-medium text-wait">{STRATEGY_LABEL[plan.coordination.strategy]}</span>
            <span className="text-sm text-muted">topology {plan.coordination.topology}</span>
          </div>
          {plan.board && (
            <p className="mt-2 text-xs text-muted">
              메모 {plan.board.stats.posts}개 · 거부 {plan.board.stats.rejected} · 읽기 {plan.board.stats.reads}회 · 읽은 바이트 {plan.board.stats.bytesRead.toLocaleString('ko-KR')}
            </p>
          )}
          {boardNotes.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {boardNotes.map((note, index) => (
                <li key={`${note.at}-${index}`} className="rounded-md border border-line bg-panel p-3">
                  <p className="text-xs font-medium">
                    [{note.kind}·{note.priority}] {note.lane}
                    {note.task ? ` / ${note.task}` : ''} · {note.by === 'platform' ? '검증기' : '모델'}
                  </p>
                  <p className="mt-1 text-sm leading-5 whitespace-pre-wrap">{note.body.slice(0, 200)}</p>
                  {note.refs.length > 0 && <p className="mt-1 break-all font-mono text-xs text-muted">{note.refs.join(', ')}</p>}
                  <p className="mt-1 text-xs text-muted">{note.at}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">{showContracts ? '레인 사이 계약 말고는 아직 게시된 메모가 없습니다.' : '아직 게시된 메모가 없습니다.'}</p>
          )}
        </section>
      )}

      {showContracts && (
        <section className="glass rounded-panel p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">레인 사이 계약</h2>
            <span className="glass-soft rounded-full px-3 py-1 text-sm font-medium text-wait">
              계약 {plan.contracts?.count ?? platformContracts.length}개
            </span>
            <span className="text-sm text-muted">출처: {plan.contracts?.source === 'model' ? '계획 모델' : '사람'}</span>
            {plan.contracts?.usage && hasTokens(plan.contracts.usage) && (
              <span className="text-xs text-muted">
                {describeTokens(plan.contracts.usage)}
                {plan.contracts.durationMs !== undefined && ` · ${(plan.contracts.durationMs / 1_000).toFixed(1)}초`}
              </span>
            )}
          </div>
          {plan.contracts?.warning && <p className="mt-2 text-sm text-fail">{plan.contracts.warning}</p>}
          {platformContracts.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {platformContracts.map((note, index) => (
                <li key={`${note.at}-${index}`} className="rounded-md border border-line bg-panel p-3">
                  <p className="text-sm leading-5 whitespace-pre-wrap">{note.body}</p>
                  {note.refs.length > 0 && <p className="mt-1 break-all font-mono text-xs text-muted">{note.refs.join(', ')}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">게시된 계약이 없습니다. 레인끼리 맞물리는 인터페이스가 없다고 판단했습니다.</p>
          )}
          {plan.contracts !== undefined && plan.contracts.count > platformContracts.length && (
            <p className="mt-2 text-sm text-fail">
              계약 {plan.contracts.count - platformContracts.length}개가 게시되지 않았습니다. refs가 없는 계약은 게시판이 거부합니다.
            </p>
          )}
          <p className="mt-2 text-xs text-muted">레인은 시작 전에 read_notes로 이 계약을 읽습니다.</p>
        </section>
      )}

      {view === 'graph' ? (
        <PlanGraphView plan={plan} />
      ) : (
        <>
          <div className={`grid gap-4 ${plan.lanes.length >= 3 ? '2xl:grid-cols-3' : 'lg:grid-cols-2'}`}>
            {plan.lanes.map((lane) => {
              // 레인 합계는 그 레인 작업들의 실행 기록에서 더한다. 계획 전체 합계(plan.metrics)만으로는 레인별 비중을 알 수 없다
              const laneCacheRead = lane.tasks.reduce((sum, task) => sum + (task.run?.usage?.cacheReadTokens ?? 0), 0);
              const laneOutput = lane.tasks.reduce((sum, task) => sum + (task.run?.usage?.outputTokens ?? 0), 0);
              return (
              <article key={lane.id} className="min-w-0 rounded-panel border border-line bg-panel p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-lg font-semibold">{lane.id}</p>
                    <p className="mt-0.5 break-all font-mono text-xs text-muted">쓰기 범위: {lane.paths.join(', ')}</p>
                    <p className="mt-0.5 text-xs text-muted">백엔드: {lane.backend ?? '서버 기본'}{lane.model ? ` (${lane.model})` : ''}</p>
                  </div>
                  <span className={`shrink-0 text-sm font-medium ${STEP_COLOR[lane.status]}`}>{STEP_STATUS[lane.status]}</span>
                </div>
                <ol className="mt-4 space-y-2">
                  {lane.tasks.map((task, index) => (
                    <li key={task.id} className="rounded-md border border-line bg-panel p-3 text-sm">
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
                {(laneCacheRead > 0 || laneOutput > 0) && (
                  <p className="mt-3 text-xs text-muted">
                    레인 합계 · 캐시 읽기 <span className="font-mono text-ink">{laneCacheRead.toLocaleString('ko-KR')}</span> · 출력{' '}
                    <span className="font-mono text-ink">{laneOutput.toLocaleString('ko-KR')}</span>
                  </p>
                )}
                {lane.error && <p className="mt-3 text-xs text-fail whitespace-pre-wrap">{lane.error}</p>}
                {lane.sessionId && <Link href={`/sessions/${lane.sessionId}`} className="mt-4 inline-block rounded-control border border-line px-3 py-1.5 text-sm font-medium hover:border-ink">레인 세션 보기</Link>}
              </article>
              );
            })}
          </div>

          {plan.integration && (
            <article className={`rounded-panel border border-line bg-panel p-5 ${plan.integration.status === 'done' ? 'ring-2 ring-pass' : ''}`}>
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
              {plan.integration.repair && (
                <p className={`mt-3 text-sm ${plan.integration.repair.status === 'done' ? 'text-pass' : 'text-fail'}`}>
                  S4 수리 요청 {plan.integration.repair.status === 'done' ? '성공' : '실패'} · {plan.integration.repair.status}
                </p>
              )}
              {plan.integration.error && <p className="mt-3 text-sm text-fail whitespace-pre-wrap">{plan.integration.error}</p>}
              {plan.integration.checkpoint && <p className="mt-3 text-xs text-muted">체크포인트 <span className="font-mono text-ink">{plan.integration.checkpoint.shortSha}</span></p>}
              {plan.integration.sessionId && <Link href={`/sessions/${plan.integration.sessionId}`} className="mt-4 inline-block rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel">통합 세션·diff 보기</Link>}
            </article>
          )}
        </>
      )}
    </div>
  );
}
