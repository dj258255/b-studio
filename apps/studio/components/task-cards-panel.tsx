'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { AgentUsage } from '@b-studio/agent';
import type { ProjectSummary } from '@/lib/studio-events';
import { summarizeTaskPlan } from '@/lib/task-plan-metrics';
import type { TaskPlanRunMetricsView, TaskPlanStepStatus, TaskPlanStatus, TaskPlanView } from '@/lib/task-plan-types';
import { terminalUsageText, type TerminalUsageSummary } from '@/lib/terminal';
import { totalTokens } from '@/lib/usage';

/** 미리보기 응답의 레인 하나(서버 previewTaskCards의 TaskCardPreviewLane과 같은 꼴) */
export interface PreviewLane {
  id: string;
  cards: Array<{ id: string; title: string }>;
  paths: string[];
}

/** 카드 하나가 서버로 나갈 때의 꼴(#B6a의 TaskCardInput과 같다). 빈 완료 명령은 필드를 두지 않는다 */
export interface TaskCardPayload {
  title: string;
  request: string;
  paths: string[];
  doneCommand?: string;
  doneService?: string;
}

/** 편집기가 들고 있는 카드 초안. 경로·완료 명령은 사람이 친 그대로(문자열) 두고 보낼 때 다듬는다 */
export interface TaskCardDraft {
  key: number;
  title: string;
  request: string;
  paths: string;
  doneCommand: string;
  doneService: string;
}

export const CARDS_STORAGE_KEY = 'b-studio:task-cards';

function emptyCard(key: number): TaskCardDraft {
  return { key, title: '', request: '', paths: '', doneCommand: '', doneService: '' };
}

/** 쓸 수 있는 경로 칸을 줄바꿈과 쉼표로 나누고 앞뒤 빈칸과 빈 항목을 뺀다 */
export function splitPaths(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * 카드 초안을 서버로 보낼 꼴로 다듬는다. 완료 명령이 있으면 서비스를 싣되, **지금 프로젝트의 목록에 있는 이름만** 쓴다.
 * 옛 프로젝트의 이름이 남아 있으면 비워 보내 서버가 이 프로젝트의 첫 서비스를 쓰게 한다
 */
export function cardsPayload(cards: readonly TaskCardDraft[], serviceList: readonly string[]): TaskCardPayload[] {
  return cards.map((card) => {
    const doneCommand = card.doneCommand.trim();
    const payload: TaskCardPayload = { title: card.title.trim(), request: card.request.trim(), paths: splitPaths(card.paths) };
    if (doneCommand) {
      payload.doneCommand = doneCommand;
      const chosen = card.doneService.trim();
      if (chosen && serviceList.includes(chosen)) payload.doneService = chosen;
    }
    return payload;
  });
}

/** 완료 조건의 서비스 고르기 칸이 보여 줄 값. 고른 값이 지금 프로젝트 목록에 없으면 첫 서비스를 보인다 */
export function selectedService(doneService: string, serviceList: readonly string[]): string {
  const chosen = doneService.trim();
  return chosen && serviceList.includes(chosen) ? chosen : (serviceList[0] ?? '');
}

/**
 * 완료 명령이 어디서 도는지 알려 주는 한 줄. 명령은 그 서비스 컨테이너의 작업 폴더(그 서비스의 경로)에서 돌아
 * 저장소 루트 기준 경로를 못 찾을 수 있다. 돌릴 서비스가 없으면 그 사실을 알린다(미리보기·실행도 서버가 막는다)
 */
export function doneCommandHint(service: string): string {
  return service === ''
    ? '서비스가 없어 완료 명령을 돌릴 수 없습니다'
    : `${service} 컨테이너의 작업 폴더에서 돕니다(저장소 루트가 아닐 수 있습니다)`;
}

/** 보낼 카드가 모두 채워졌는가(제목·할 일·경로). 미리보기와 실행을 이 조건으로 막는다 */
function payloadReady(payload: readonly TaskCardPayload[]): boolean {
  return payload.length > 0 && payload.every((card) => card.title !== '' && card.request !== '' && card.paths.length > 0);
}

/** "카드 3"처럼 카드 id(card-3)를 사람이 읽는 번호로. 모양이 다르면 id 그대로 */
function cardLabel(id: string): string {
  const match = /^card-(\d+)$/.exec(id);
  return `카드 ${match ? match[1] : id}`;
}

/**
 * 레인 미리보기를 한 줄로. 예) "레인 2개 · 동시에 · 레인 1: 카드 1 → 카드 3(경로가 겹쳐 순서대로) · 레인 2: 카드 2"
 * 한 레인에 카드가 여럿이면 경로가 겹쳐 순서대로 도는 것이라 그 뜻을 덧붙인다
 */
export function lanePreviewText(lanes: readonly PreviewLane[]): string {
  const parts = lanes.map((lane, index) => {
    const labels = lane.cards.map((card) => cardLabel(card.id)).join(' → ');
    return `레인 ${index + 1}: ${labels}${lane.cards.length > 1 ? '(경로가 겹쳐 순서대로)' : ''}`;
  });
  return `레인 ${lanes.length}개 · 동시에 · ${parts.join(' · ')}`;
}

/** 사용량 하나를 활동 줄 꼴로. 토큰·시간·비용이 모두 없으면 없다(줄을 그리지 않는다) */
function usageLine(usage: AgentUsage, durationMs: number | undefined, costUsd: number | undefined): string | undefined {
  const tokens = totalTokens(usage);
  if (tokens === 0 && durationMs === undefined && costUsd === undefined) return undefined;
  const denominator = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const summary: TerminalUsageSummary = {
    tokens,
    cacheHitRatio: denominator === 0 ? 0 : usage.cacheReadTokens / denominator,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return terminalUsageText(summary);
}

const ZERO_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** 계획 전체의 비용 합(터미널 실행이 알려 온 값). 하나도 없으면 없다 — 0으로 채우지 않는다 */
function planCostUsd(plan: TaskPlanView): number | undefined {
  let cost: number | undefined;
  const add = (value: number | undefined): void => {
    if (value !== undefined) cost = (cost ?? 0) + value;
  };
  for (const lane of plan.lanes) for (const task of lane.tasks) add(task.run?.costUsd);
  add(plan.integration?.run?.costUsd);
  add(plan.integration?.repair?.run?.costUsd);
  return cost;
}

/** 계획 합계 한 줄(토큰 · 캐시 % · 시간 · 비용). 비용이 오지 않았으면 비용 칸을 그리지 않는다 */
export function planUsageLine(plan: TaskPlanView): string | undefined {
  const metrics = summarizeTaskPlan(plan);
  return usageLine(metrics.usage, metrics.endToEndMs, planCostUsd(plan));
}

/** 작업 하나의 사용량 한 줄(task.run). 실행 기록이 없으면 없다 */
export function taskUsageLine(run: TaskPlanRunMetricsView | undefined): string | undefined {
  if (!run) return undefined;
  return usageLine(run.usage ?? ZERO_USAGE, run.durationMs, run.costUsd);
}

function storageOrUndefined(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    // 저장소에 접근하지 못해도(사생활 보호 모드 등) 화면은 그대로 동작한다
    return undefined;
  }
}

/** 저장해 둔 카드 초안. 형식이 아니면(손상·빈 값) 없는 것으로 본다. 접근이 실패해도 던지지 않는다 */
export function readStoredCards(storage: Pick<Storage, 'getItem'> | undefined): TaskCardDraft[] | undefined {
  try {
    const raw = storage?.getItem(CARDS_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const cards = parsed.flatMap((entry, index) => (isStoredCard(entry) ? [{ key: index + 1, ...entry }] : []));
    return cards.length > 0 ? cards : undefined;
  } catch {
    return undefined;
  }
}

function isStoredCard(entry: unknown): entry is Omit<TaskCardDraft, 'key'> {
  if (typeof entry !== 'object' || entry === null) return false;
  const record = entry as Record<string, unknown>;
  return (
    typeof record.title === 'string' &&
    typeof record.request === 'string' &&
    typeof record.paths === 'string' &&
    typeof record.doneCommand === 'string' &&
    typeof record.doneService === 'string'
  );
}

/** 쓰던 카드를 임시로 남긴다. 실패해도 화면은 그대로 동작한다 */
export function writeStoredCards(storage: Pick<Storage, 'setItem'> | undefined, cards: readonly TaskCardDraft[]): void {
  try {
    storage?.setItem(
      CARDS_STORAGE_KEY,
      JSON.stringify(cards.map((card) => ({ title: card.title, request: card.request, paths: card.paths, doneCommand: card.doneCommand, doneService: card.doneService }))),
    );
  } catch {
    // 기억하지 못해도 화면은 그대로 쓴다
  }
}

/** 실행에 성공하면 임시로 남긴 카드를 지운다 */
export function clearStoredCards(storage: Pick<Storage, 'removeItem'> | undefined): void {
  try {
    storage?.removeItem(CARDS_STORAGE_KEY);
  } catch {
    // 지우지 못해도 화면은 그대로 쓴다
  }
}

/**
 * 나란히 보기 왼쪽 칸의 "작업 카드" 편집기(#B6b). 사람이 카드(제목·할 일·쓸 수 있는 경로·완료 조건)를 쓰면
 * 400ms 뒤 미리보기 API로 레인을 보여 주고, "실행"을 누르면 계획을 만들어 `/split?plan=<id>`로 간다.
 */
export function TaskCardsEditor({
  projects,
  defaultProjectId,
  limits,
  services,
}: {
  projects: ProjectSummary[];
  defaultProjectId?: string;
  limits: { maxTasks: number };
  services: Record<string, string[]>;
}) {
  const router = useRouter();
  const usable = projects.filter((project) => !project.error);
  const initialProject = usable.find((project) => project.id === defaultProjectId)?.id ?? usable[0]?.id ?? '';
  const [projectId, setProjectId] = useState(initialProject);
  const [cards, setCards] = useState<TaskCardDraft[]>(() => readStoredCards(storageOrUndefined()) ?? [emptyCard(1)]);
  const nextKey = useRef(cards.length + 1);
  // 마지막으로 반영한 미리보기와, 그것이 어느 카드 내용(요청 키)의 것인지. 실행은 이 키가 지금 내용과 같고 성공(레인 있음)일 때만 켠다
  const [preview, setPreview] = useState<{ key: string; lanes?: PreviewLane[]; error?: string }>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSeq = useRef(0);
  const [running, setRunning] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  const serviceList = services[projectId] ?? [];
  const payload = cardsPayload(cards, serviceList);
  const ready = projectId !== '' && payloadReady(payload);
  // 지금 카드 내용을 나타내는 키. 이 값이 바뀌면 이전 미리보기는 지금 내용의 것이 아니다
  const requestKey = JSON.stringify({ projectId, cards: payload });
  // 채워지기 전에는 오래된 미리보기를 보이지 않는다(효과가 지우지 않고 그리는 쪽에서 가린다)
  const shownPreview = ready ? preview : undefined;
  const previewBusy = ready && previewLoading;

  // 쓰던 카드는 브라우저 저장소에 임시로 남긴다(실행에 성공하면 지운다). 접근이 실패해도 화면은 그대로 동작한다
  useEffect(() => {
    writeStoredCards(storageOrUndefined(), cards);
  }, [cards]);

  // 카드를 고칠 때마다(입력이 멈추고 400ms 뒤) 레인을 미리 본다. 요청 중에는 이전 결과를 흐리게 보인다.
  // 응답이 늦게 와 순서가 뒤바뀌어도 마지막 요청(seq)의 응답만 쓴다
  useEffect(() => {
    if (!ready) return;
    const seq = ++previewSeq.current;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const response = await fetch('/api/task-plans/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, cards: payload }),
        });
        const data = (await response.json().catch(() => ({}))) as { lanes?: PreviewLane[]; error?: string };
        if (cancelled || seq !== previewSeq.current) return;
        setPreview(response.ok ? { key: requestKey, lanes: data.lanes } : { key: requestKey, error: typeof data.error === 'string' ? data.error : '미리보기를 만들지 못했습니다' });
      } catch {
        if (!cancelled && seq === previewSeq.current) setPreview({ key: requestKey, error: '미리보기를 만들지 못했습니다' });
      } finally {
        if (!cancelled && seq === previewSeq.current) setPreviewLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // payload는 cards·serviceList에서 나온다. requestKey가 그 내용을 담으므로 그것으로만 다시 돈다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, ready]);

  function addCard() {
    if (cards.length >= limits.maxTasks) return;
    setCards((current) => [...current, emptyCard(nextKey.current++)]);
  }

  function removeCard(key: number) {
    setCards((current) => (current.length <= 1 ? current : current.filter((card) => card.key !== key)));
  }

  function updateCard(key: number, patch: Partial<TaskCardDraft>) {
    setCards((current) => current.map((card) => (card.key === key ? { ...card, ...patch } : card)));
  }

  function changeProject(next: string) {
    setProjectId(next);
    // 서비스가 프로젝트마다 다르므로, 프로젝트를 바꾸면 고른 서비스를 비운다(첫 서비스로 다시 채워진다)
    setCards((current) => current.map((card) => ({ ...card, doneService: '' })));
  }

  // 미리보기가 지금 카드 내용의 것이고 성공(레인 있음)으로 와 있을 때만 실행을 켠다.
  // 기다리는 중이거나(400ms 디바운스 포함) 내용이 바뀌었거나(옛 응답) 오류면 끈다
  const previewMatches = preview?.key === requestKey;
  const canRun = ready && previewMatches && (preview?.lanes?.length ?? 0) > 0 && !running;

  async function run() {
    if (!canRun) return;
    setRunning(true);
    setSubmitError(undefined);
    try {
      const response = await fetch('/api/task-plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, cards: payload }),
      });
      const data = (await response.json().catch(() => ({}))) as { id?: unknown; error?: string };
      if (!response.ok || typeof data.id !== 'string') {
        setSubmitError(typeof data.error === 'string' ? data.error : '계획을 만들지 못했습니다');
        return;
      }
      clearStoredCards(storageOrUndefined());
      router.push(`/split?plan=${data.id}`);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : '계획을 만들지 못했습니다');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">프로젝트</span>
        <select value={projectId} onChange={(event) => changeProject(event.target.value)} className="rounded-control border border-line bg-panel px-2 py-1.5">
          {usable.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>

      {cards.map((card, index) => (
        <fieldset key={card.key} className="rounded-panel border border-line p-2.5">
          <legend className="px-1 text-xs font-medium text-muted">카드 {index + 1}</legend>
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">제목</span>
              <input
                value={card.title}
                onChange={(event) => updateCard(card.key, { title: event.target.value })}
                className="rounded-control border border-line bg-panel px-2 py-1.5"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">할 일</span>
              <textarea
                value={card.request}
                onChange={(event) => updateCard(card.key, { request: event.target.value })}
                rows={3}
                className="resize-y rounded-control border border-line bg-panel px-2 py-1.5 leading-5"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">쓸 수 있는 경로</span>
              <textarea
                value={card.paths}
                onChange={(event) => updateCard(card.key, { paths: event.target.value })}
                rows={2}
                placeholder="줄바꿈 또는 쉼표로 구분"
                className="resize-y rounded-control border border-line bg-panel px-2 py-1.5 font-mono text-xs leading-5"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">완료 조건 명령 (선택)</span>
              <input
                value={card.doneCommand}
                onChange={(event) => updateCard(card.key, { doneCommand: event.target.value })}
                placeholder="pnpm test -- order"
                className="rounded-control border border-line bg-panel px-2 py-1.5 font-mono text-xs"
              />
            </label>
            {card.doneCommand.trim() !== '' && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted">완료 조건을 돌릴 서비스</span>
                  <select
                    value={selectedService(card.doneService, serviceList)}
                    onChange={(event) => updateCard(card.key, { doneService: event.target.value })}
                    className="rounded-control border border-line bg-panel px-2 py-1.5"
                  >
                    {serviceList.length === 0 && <option value="">서비스 없음</option>}
                    {serviceList.map((service) => (
                      <option key={service} value={service}>
                        {service}
                      </option>
                    ))}
                  </select>
                </label>
                <p className={`text-xs ${serviceList.length === 0 ? 'text-fail' : 'text-muted'}`}>{doneCommandHint(selectedService(card.doneService, serviceList))}</p>
              </>
            )}
            <button
              type="button"
              onClick={() => removeCard(card.key)}
              disabled={cards.length <= 1}
              className="glass-soft self-start rounded-control px-2.5 py-1 text-xs font-medium hover:text-fail disabled:opacity-50"
            >
              빼기
            </button>
          </div>
        </fieldset>
      ))}

      <button
        type="button"
        onClick={addCard}
        disabled={cards.length >= limits.maxTasks}
        className="glass-soft rounded-control px-3 py-1.5 text-sm font-medium hover:bg-panel disabled:opacity-50"
      >
        카드 더하기 ({cards.length}/{limits.maxTasks})
      </button>

      <div aria-live="polite" className={previewBusy ? 'opacity-50' : undefined}>
        {shownPreview?.error ? (
          <p className="text-xs text-fail">{shownPreview.error}</p>
        ) : shownPreview?.lanes ? (
          <p className="text-xs text-muted">{lanePreviewText(shownPreview.lanes)}</p>
        ) : (
          <p className="text-xs text-muted">카드를 채우면 레인을 미리 보여 줍니다</p>
        )}
      </div>

      <button
        type="button"
        onClick={() => void run()}
        disabled={!canRun}
        className="rounded-control bg-ink px-4 py-2 text-sm font-semibold text-panel hover:bg-ink/85 disabled:opacity-50"
      >
        {running ? '실행하는 중' : '실행'}
      </button>
      {submitError && <p className="text-xs text-fail">{submitError}</p>}
    </div>
  );
}

const FINISHED_PLAN_STATUS = new Set<TaskPlanStatus>(['done', 'failed', 'rejected']);

/** 진행 폴링 간격. 정상은 2초, 5xx·네트워크로 실패하면 두 배씩 늘려 최대 30초까지 다시 시도한다 */
const PROGRESS_BASE_MS = 2_000;
const PROGRESS_MAX_MS = 30_000;

const PLAN_STATUS_LABEL: Record<TaskPlanStatus, string> = {
  planning: '계획 중',
  awaiting_approval: '승인 대기',
  running: '레인 실행 중',
  integrating: '결과 통합 중',
  interrupted: '중단됨 (이어서 가능)',
  done: '통합 검증 통과',
  failed: '실패',
  rejected: '거부됨',
};

const STEP_LABEL: Record<TaskPlanStepStatus, string> = {
  queued: '대기',
  booting: '도는 중',
  running: '도는 중',
  done: '통과',
  failed: '실패',
  skipped: '건너뜀',
};

const STEP_TONE: Record<TaskPlanStepStatus, string> = {
  queued: 'text-muted',
  booting: 'text-wait',
  running: 'text-wait',
  done: 'text-pass',
  failed: 'text-fail',
  skipped: 'text-muted',
};

/**
 * 계획 진행 보기(#B6b). `GET /api/task-plans/<id>`를 2초마다 불러 카드마다 상태·레인·기다리는 이유·완료 명령·
 * 사용량·체크포인트를 보여 준다. 계획이 끝나면(done·failed·rejected) 그만 부른다. 화면이 숨겨지면 쉰다.
 * 카드를 누르면 그 레인 세션을 고르라고 onSelectSession으로 알린다.
 */
export function TaskPlanProgress({
  planId,
  onSelectSession,
  onPlan,
}: {
  planId: string;
  onSelectSession: (sessionId: string) => void;
  onPlan?: (plan: TaskPlanView) => void;
}) {
  const [plan, setPlan] = useState<TaskPlanView>();
  const [error, setError] = useState<string>();
  // 5xx·네트워크로 다시 시도하는 중인가. 성공하면 꺼진다(화면에 "다시 연결하는 중"을 보인다)
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 다시 시도 사이의 간격. 실패마다 두 배로 늘리고 성공하면 2초로 되돌린다
    let retry = PROGRESS_BASE_MS;

    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const schedule = (ms: number) => {
      if (cancelled) return;
      clear();
      timer = setTimeout(() => void poll(), ms);
    };

    const poll = async () => {
      // 화면이 숨겨져 있으면 부르지 않는다. 다시 보일 때 visibilitychange가 부른다
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const response = await fetch(`/api/task-plans/${encodeURIComponent(planId)}`, { cache: 'no-store' });
        const data = (await response.json().catch(() => ({}))) as TaskPlanView & { error?: string };
        if (cancelled) return;
        if (response.status === 403 || response.status === 404) {
          // 권한이 없거나 없는 계획은 다시 시도해도 같다 → 멈추고 사유를 보인다
          setReconnecting(false);
          setError(typeof data.error === 'string' ? data.error : '계획을 불러올 수 없습니다');
          return;
        }
        if (!response.ok) {
          // 그 밖의 오류(5xx 등)는 잠시 뒤 다시 시도한다(간격을 늘려 가며)
          setReconnecting(true);
          schedule(retry);
          retry = Math.min(retry * 2, PROGRESS_MAX_MS);
          return;
        }
        setError(undefined);
        setReconnecting(false);
        retry = PROGRESS_BASE_MS;
        setPlan(data);
        // 끝난 계획은 더 부르지 않는다
        if (!FINISHED_PLAN_STATUS.has(data.status)) schedule(PROGRESS_BASE_MS);
      } catch {
        if (cancelled) return;
        setReconnecting(true);
        schedule(retry);
        retry = Math.min(retry * 2, PROGRESS_MAX_MS);
      }
    };

    const onVisible = () => {
      // 숨겨져 있는 동안에는 예약하지 않았다. 보이면 곧바로 한 번 부른다
      if (typeof document !== 'undefined' && !document.hidden) {
        clear();
        void poll();
      }
    };

    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    void poll();
    return () => {
      cancelled = true;
      clear();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [planId]);

  useEffect(() => {
    if (plan) onPlan?.(plan);
    // onPlan은 매 렌더 새로 만들어질 수 있다. 계획이 바뀔 때만 알린다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  if (!plan) return <div className="p-3 text-sm text-muted">{error ?? (reconnecting ? '다시 연결하는 중…' : '계획을 불러오는 중…')}</div>;

  const usage = planUsageLine(plan);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-sm">
      <header className="space-y-1.5">
        <p className="truncate font-semibold" title={plan.request}>
          {plan.request}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="glass-soft rounded-full px-2 py-0.5 font-medium">{PLAN_STATUS_LABEL[plan.status]}</span>
          {usage && <span className="text-muted">{usage}</span>}
        </div>
        {plan.integration && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`font-medium ${STEP_TONE[plan.integration.status]}`}>통합 {STEP_LABEL[plan.integration.status]}</span>
            {plan.integration.sessionId && (
              <Link href={`/sessions/${plan.integration.sessionId}`} className="glass-soft rounded-control px-2.5 py-1 font-medium hover:bg-panel">
                통합 결과 열기
              </Link>
            )}
          </div>
        )}
        {reconnecting && (
          <p role="status" className="text-xs text-wait">
            다시 연결하는 중
          </p>
        )}
        {plan.error && <p className="text-xs text-fail whitespace-pre-wrap">{plan.error}</p>}
      </header>

      {plan.lanes.map((lane) => (
        <section key={lane.id} className="rounded-panel border border-line p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-xs font-semibold">{lane.id}</span>
            <span className={`text-xs ${STEP_TONE[lane.status]}`}>{STEP_LABEL[lane.status]}</span>
          </div>
          {lane.waiting && <p className="mb-1.5 text-xs font-medium text-wait">{lane.waiting}</p>}
          <ol className="space-y-1.5">
            {lane.tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  disabled={!lane.sessionId}
                  onClick={() => lane.sessionId && onSelectSession(lane.sessionId)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-control border border-line px-2 py-1.5 text-left hover:border-ink disabled:cursor-default disabled:opacity-70"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
                    <span className={`shrink-0 text-xs font-medium ${STEP_TONE[task.status]}`}>{STEP_LABEL[task.status]}</span>
                  </span>
                  <span className="text-xs text-muted">{lane.id}</span>
                  {task.doneCommand && <span className="break-all font-mono text-xs text-muted">완료 {task.doneCommand}</span>}
                  {taskUsageLine(task.run) && <span className="text-xs text-muted">{taskUsageLine(task.run)}</span>}
                  {task.checkpoint && <span className="font-mono text-xs text-muted">체크포인트 {task.checkpoint.shortSha}</span>}
                  {task.status === 'failed' && task.summary && <span className="text-xs text-fail">{task.summary.split('\n')[0]}</span>}
                  {task.status === 'done' && task.mismatches?.length ? <span className="text-xs text-wait">확인 필요: 요청과 확인이 어긋난다고 알렸습니다</span> : null}
                </button>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
