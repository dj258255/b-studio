'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ModelProfile, PlanBackend } from '@b-studio/agent';
import type { EffortPickerView, ModelPickerView } from '@/lib/server/model-picker';
import type { ProjectSummary, SessionMode } from '@/lib/studio-events';
import type { TaskPlanMetrics } from '@/lib/task-plan-metrics';
import { planModelAlias, type TaskPlanLaneView, type TaskPlanStatus, type TaskPlanStepStatus, type TaskPlanStrategy, type TaskPlanView } from '@/lib/task-plan-types';
import { describeTokens, hasTokens } from '@/lib/usage';
import { EFFORT_LABEL, ModelPicker } from './chat-panel';
import { Markdown } from './markdown';
import { PlanGraphView } from './plan-graph';
import { SESSION_BACKEND_LABEL } from './status';

/** claude-code 별칭 → 화면 표기(레인 카드). model-picker.ts의 CLAUDE_CODE_ALIASES 라벨과 같은 값이다 */
const CLAUDE_CODE_ALIAS_LABEL: Record<string, string> = { fable: 'Fable 5.1', opus: 'Opus 5', sonnet: 'Sonnet 5', haiku: 'Haiku 4.5' };

/** 레인 카드에 보여줄 모델 표시("Sonnet 5 · 보통"). 계획이 쓴 modelId·effort를 사람이 읽는 이름으로 바꾼다 */
function planModelLabel(plan: TaskPlanView, models: ModelOption[]): string {
  const alias = planModelAlias(plan.modelId);
  const label = alias === '' ? '서버 기본' : (CLAUDE_CODE_ALIAS_LABEL[alias] ?? models.find((model) => model.id === alias)?.label ?? alias);
  return plan.effort ? `${label} · ${EFFORT_LABEL[plan.effort] ?? plan.effort}` : label;
}

/**
 * 레인 카드 머리글의 백엔드·모델 표시(이슈 #398). 레인이 백엔드를 따로 골랐으면 그 백엔드 이름("로컬 Claude
 * Agent")과 모델·노력 단계를, 아니면 "세션과 같음"과 계획 기본 모델 표시를 보여 준다.
 */
export function laneBackendLabel(plan: TaskPlanView, lane: TaskPlanLaneView, models: ModelOption[]): string {
  if (!lane.backend) return `세션과 같음 · ${planModelLabel(plan, models)}`;
  const backendLabel = SESSION_BACKEND_LABEL[lane.backend] ?? lane.backend;
  const modelLabel = lane.model ? (CLAUDE_CODE_ALIAS_LABEL[lane.model] ?? models.find((model) => model.id === lane.model)?.label ?? lane.model) : '기본';
  const effortLabel = lane.effort ? ` · ${EFFORT_LABEL[lane.effort] ?? lane.effort}` : '';
  return `${backendLabel} · ${modelLabel}${effortLabel}`;
}

/**
 * 레인 백엔드·모델 선택기(이슈 #398). 승인 대기 중에만 보인다. "세션과 같음"이 기본이고, 백엔드를 고르면
 * 대화 입력창과 같은 ModelPicker를 그 백엔드 기준으로 보여 준다. 바뀐 값은 고를 때마다 바로 서버에 저장된다.
 */
export function LaneBackendControl({
  plan,
  lane,
  laneBackends,
  onUpdate,
}: {
  plan: TaskPlanView;
  lane: TaskPlanLaneView;
  laneBackends: PlanBackend[];
  onUpdate: (plan: TaskPlanView) => void;
}) {
  const [picker, setPicker] = useState<ModelPickerView>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    // "세션과 같음"이면 부를 목록이 없다 — 아래 JSX가 lane.backend로 picker 절을 통째로 숨기므로 지난 값을 지울 필요가 없다
    if (!lane.backend) return;
    let cancelled = false;
    const params = new URLSearchParams({ backend: lane.backend });
    if (lane.model) params.set('current', lane.model);
    if (lane.effort) params.set('effort', lane.effort);
    fetch(`/api/task-plans/lane-backends?${params.toString()}`, { cache: 'no-store' })
      .then(async (response) => (response.ok ? ((await response.json()) as { picker?: ModelPickerView }) : undefined))
      .then((result) => {
        if (!cancelled) setPicker(result?.picker);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // 백엔드가 바뀔 때만 다시 불러온다. 모델·노력만 바뀐 뒤에는 save()가 서버가 돌려준 picker를 바로 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane.id, lane.backend]);

  async function save(next: { backend?: string; model?: string; effort?: string }) {
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/task-plans/${encodeURIComponent(plan.id)}/lanes/${encodeURIComponent(lane.id)}/backend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result && typeof result.error === 'string' ? result.error : '레인 백엔드를 바꾸지 못했습니다');
      onUpdate(result.plan as TaskPlanView);
      setPicker(result.picker as ModelPickerView | undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 border-t border-line pt-3">
      <label className="block text-xs font-medium text-muted" htmlFor={`lane-backend-${lane.id}`}>레인 백엔드</label>
      <select
        id={`lane-backend-${lane.id}`}
        value={lane.backend ?? ''}
        disabled={saving}
        onChange={(event) => void save({ backend: event.target.value })}
        className="mt-1 w-full rounded-control border border-line bg-panel px-2 py-1.5 text-xs disabled:opacity-50"
      >
        <option value="">세션과 같음</option>
        {laneBackends.map((backend) => (
          <option key={backend} value={backend}>
            {SESSION_BACKEND_LABEL[backend]}
          </option>
        ))}
      </select>
      {lane.backend && (
        <div className="mt-1.5">
          {picker ? (
            <ModelPicker
              picker={picker}
              disabled={saving}
              onChangeModel={(value) => void save({ backend: lane.backend, model: value, ...(lane.effort ? { effort: lane.effort } : {}) })}
              onChangeEffort={(value) => void save({ backend: lane.backend, ...(lane.model ? { model: lane.model } : {}), effort: value })}
            />
          ) : (
            <p className="text-xs text-muted">모델 목록을 불러오는 중…</p>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-fail">{error}</p>}
    </div>
  );
}

const STRATEGY_LABEL: Record<TaskPlanStrategy, string> = {
  S2: 'S2 계약 먼저',
  S3: 'S3 게시판',
  S4: 'S4 통합 후 수리',
  S5: 'S5 실패 서명만',
  S6: 'S6 전체 트레이스 공유',
  S7: 'S7 조정자 중계',
};

/**
 * 외부 에이전트(다른 Claude Code 세션·herdr·Codex CLI 등) 연결. 이 계획의 게시판에 쓸 고정 레인 이름으로
 * MCP 토큰을 내주고, 복사해 쓸 설정을 보여준다. 토큰 평문은 낸 직후 이 화면에만 있다 — plan.externalAgents
 * (서버가 돌려주는 계획 기록)에는 요약만 남으므로, 다시 불러오면 평문은 더 이상 어디에도 없다.
 * 이 화면에 뜨는 계획은 이미 이 사용자가 만든 것만 걸러져 있어(listTaskPlans) 따로 소유자 확인을 하지 않는다.
 */
function ExternalAgentsSection({ plan, onUpdate }: { plan: TaskPlanView; onUpdate: (plan: TaskPlanView) => void }) {
  const [lane, setLane] = useState('');
  const [group, setGroup] = useState('');
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string>();
  const [minted, setMinted] = useState<{ tokenId: string; token: string; lane: string; mcp: { url: string } }>();
  const [revealed, setRevealed] = useState(false);
  const [revokingId, setRevokingId] = useState<string>();

  async function mint() {
    const trimmedLane = lane.trim();
    if (!trimmedLane) return;
    setMinting(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/task-plans/${encodeURIComponent(plan.id)}/board/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lane: trimmedLane, ...(group.trim() ? { group: group.trim() } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : '토큰을 만들지 못했습니다');
      onUpdate(result.plan as TaskPlanView);
      setMinted({ tokenId: result.tokenId, token: result.token, lane: result.lane, mcp: result.mcp });
      setRevealed(false);
      setLane('');
      setGroup('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMinting(false);
    }
  }

  async function revoke(tokenId: string) {
    setRevokingId(tokenId);
    try {
      const response = await fetch(`/api/task-plans/${encodeURIComponent(plan.id)}/board/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' });
      const result = await response.json();
      if (response.ok) onUpdate(result as TaskPlanView);
      if (minted?.tokenId === tokenId) setMinted(undefined);
    } finally {
      setRevokingId(undefined);
    }
  }

  const agents = plan.externalAgents ?? [];
  const maskedToken = minted ? '•'.repeat(16) : '';
  const config = minted
    ? JSON.stringify({ mcpServers: { 'b-studio-board': { type: 'http', url: minted.mcp.url, headers: { Authorization: `Bearer ${revealed ? minted.token : maskedToken}` } } } }, null, 2)
    : '';

  return (
    <div className="mt-4 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">외부 에이전트 연결</h3>
      <p className="mt-1 text-xs text-muted">다른 Claude Code 세션·herdr·Codex CLI 등을 이 게시판에 고정 이름(레인)으로 붙입니다. 실패 메모는 여기서도 쓸 수 없습니다.</p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-muted">
          레인 이름
          <input
            value={lane}
            onChange={(event) => setLane(event.target.value)}
            placeholder="guest-codex"
            className="mt-1 rounded-control border border-line bg-panel px-2 py-1.5 text-sm text-ink placeholder:text-muted"
          />
        </label>
        <label className="flex flex-col text-xs text-muted">
          그룹(선택)
          <input
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            placeholder="web/a"
            className="mt-1 rounded-control border border-line bg-panel px-2 py-1.5 text-sm text-ink placeholder:text-muted"
          />
        </label>
        <button
          type="button"
          disabled={minting || !lane.trim()}
          onClick={() => void mint()}
          className="rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
        >
          토큰 만들기
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-fail">{error}</p>}

      {minted && (
        <div className="mt-3 rounded-md border border-line bg-panel p-3">
          <p className="text-xs font-medium">&quot;{minted.lane}&quot; 토큰 — 지금만 보여줍니다. 복사해 바로 붙여 넣으세요</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-ground p-2 font-mono text-xs leading-5">{config}</pre>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => setRevealed((value) => !value)} className="rounded-control border border-line px-2 py-1 text-xs hover:border-ink">
              {revealed ? '가리기' : '보기'}
            </button>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(config).catch(() => {})} className="rounded-control border border-line px-2 py-1 text-xs hover:border-ink">
              복사
            </button>
          </div>
        </div>
      )}

      {agents.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-xs">
          {agents.map((agent) => (
            <li key={agent.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-2 py-1.5">
              <span>
                <span className="font-mono">{agent.lane}</span>
                {agent.group ? ` · ${agent.group}` : ''} · {agent.revokedAt ? '거둠' : '쓰는 중'}
              </span>
              {!agent.revokedAt && (
                <button type="button" disabled={revokingId === agent.id} onClick={() => void revoke(agent.id)} className="font-medium text-fail hover:underline disabled:opacity-50">
                  거두기
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
  initialSelectedId,
  planner,
  limits,
  modelPicker,
  laneBackends,
}: {
  projects: ProjectSummary[];
  models: ModelOption[];
  initialPlans: TaskPlanView[];
  /** 먼저 열 계획(`?id=`). 목록에 없으면 가장 최근 것 */
  initialSelectedId?: string;
  planner: PlannerCapability;
  limits: PlanLimitView;
  /** "새 작업 분해" 폼의 모델·노력 선택(대화 입력창과 같은 ModelPicker를 쓴다). 서버가 이 백엔드에서 고를 수 있는 값으로 만든다.
   * 방금 이 화면으로 넘어온 계획(나눠서 병렬 제안 수락)이 있으면 그 계획이 이어받은 세션 값이 기본으로 들어 있다 */
  modelPicker: ModelPickerView;
  /** 이 서버에서 레인마다 고를 수 있는 백엔드(이슈 #398, "세션과 같음"은 화면이 따로 그린다) */
  laneBackends: PlanBackend[];
}) {
  const [projectId, setProjectId] = useState(projects.find((project) => !project.error)?.id ?? '');
  const [picker, setPicker] = useState<ModelPickerView>(modelPicker);
  const [request, setRequest] = useState('');
  const [plans, setPlans] = useState(initialPlans);
  const [selectedId, setSelectedId] = useState(initialPlans.some((plan) => plan.id === initialSelectedId) ? initialSelectedId : initialPlans[0]?.id);
  const [creating, setCreating] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string>();
  const selected = plans.find((plan) => plan.id === selectedId);
  // 승인 대기·중단됨·거부됨은 사람이 움직이기 전까지 바뀌지 않으므로 폴링하지 않는다
  const active = selected !== undefined && !['done', 'failed', 'rejected', 'awaiting_approval', 'interrupted'].includes(selected.status);
  // API 모드는 실제로 고른 모델이 있어야 계획을 만들 수 있다("자동(라우터)"로는 계획을 부를 수 없다). 로컬 CLI 모드는 "기본"도 된다
  const modelRequired = planner.mode === 'api';

  // 이 화면은 핸드오프 링크(`/task-plans?id=`)로 열릴 때가 많다. 스크롤이 아래로 내려온 채 열려 머리글이 잘리지 않도록 맨 위로 되돌린다
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

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
        body: JSON.stringify({
          projectId,
          request,
          modelId: picker.current ?? '',
          ...(picker.effort.supported && picker.effort.current ? { effort: picker.effort.current } : {}),
        }),
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

  /** 레인 백엔드 선택기가 계획을 바꾼 뒤(승인 전) 목록·선택 상태에 그대로 반영한다. decide·resume과 같은 모양이다 */
  function updatePlan(plan: TaskPlanView) {
    setPlans((current) => [plan, ...current.filter((entry) => entry.id !== plan.id)]);
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

          <p className="mt-4 text-sm font-medium">모델</p>
          <div className="mt-1">
            <ModelPicker
              picker={picker}
              disabled={!planner.enabled}
              onChangeModel={(value) => setPicker((current) => ({ ...current, current: value }))}
              onChangeEffort={(value) =>
                setPicker((current) => ({ ...current, effort: { ...current.effort, current: (value || undefined) as EffortPickerView['current'] } }))
              }
            />
          </div>
          {modelRequired && picker.options.every((option) => option.id === '') && (
            <p className="mt-1 text-xs text-fail">도구 호출을 지원하고 API 키가 설정된 모델이 없습니다</p>
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
            disabled={!planner.enabled || !projectId || (modelRequired && !picker.current) || !request.trim() || creating}
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
            models={models}
            canPublish={projects.find((project) => project.id === selected.projectId)?.canPublishIssues === true}
            deciding={deciding}
            onDecide={(approve, reason, publishIssues) => void decide(approve, reason, publishIssues)}
            onResume={() => void resume()}
            laneBackends={laneBackends}
            onUpdate={updatePlan}
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
  models,
  canPublish,
  deciding,
  onDecide,
  onResume,
  laneBackends,
  onUpdate,
}: {
  plan: TaskPlanView;
  /** 레인 카드의 모델 표시에 쓴다(API 모드 레지스트리 id → 라벨) */
  models: ModelOption[];
  /** 원격 저장소 + 토큰이 있어 "이슈로 올리기"를 고를 수 있는가 */
  canPublish: boolean;
  deciding: boolean;
  onDecide: (approve: boolean, reason?: string, publishIssues?: boolean) => void;
  onResume: () => void;
  /** 이 서버에서 레인마다 고를 수 있는 백엔드(이슈 #398) */
  laneBackends: PlanBackend[];
  /** 레인 백엔드 선택기가 계획을 바꾼 뒤(승인 전) 화면 상태를 갱신한다 */
  onUpdate: (plan: TaskPlanView) => void;
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
          {plan.board && <ExternalAgentsSection plan={plan} onUpdate={onUpdate} />}
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
                    <p className="mt-0.5 text-xs text-muted">{laneBackendLabel(plan, lane, models)}</p>
                  </div>
                  <span className={`shrink-0 text-sm font-medium ${STEP_COLOR[lane.status]}`}>{STEP_STATUS[lane.status]}</span>
                </div>
                {plan.status === 'awaiting_approval' && (
                  <LaneBackendControl plan={plan} lane={lane} laneBackends={laneBackends} onUpdate={onUpdate} />
                )}
                <ol className="mt-4 space-y-2">
                  {lane.tasks.map((task, index) => (
                    <li key={task.id} className="rounded-md border border-line bg-panel p-3 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium">{index + 1}. {task.title}</span>
                        <span className={`shrink-0 text-xs font-medium ${STEP_COLOR[task.status]}`}>{STEP_STATUS[task.status]}</span>
                      </div>
                      <p className="mt-1 break-all font-mono text-xs text-muted">{task.paths.join(', ')}{task.dependsOn.length > 0 ? ` · 선행: ${task.dependsOn.join(', ')}` : ''}</p>
                      {task.summary && (
                        <div className="mt-2 text-xs leading-5 text-muted [&_p]:leading-5">
                          <Markdown text={task.summary} />
                        </div>
                      )}
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
