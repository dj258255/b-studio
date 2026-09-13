'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { ModelProfile, RoutingDecision } from '@b-studio/agent';
import type { FleetMemberStatus, FleetView } from '@/lib/fleet-types';
import type { ProjectSummary } from '@/lib/studio-events';
import { formatTokenCount, totalTokens } from '@/lib/usage';

type ModelOption = ModelProfile & { configured: boolean };

const STATUS: Record<FleetMemberStatus, string> = {
  booting: '샌드박스 준비 중',
  running: '에이전트 실행 중',
  done: '검증 통과',
  failed: '검증 실패',
  error: '실행 오류',
  cancelled: '취소됨',
};

const STATUS_COLOR: Record<FleetMemberStatus, string> = {
  booting: 'text-wait',
  running: 'text-wait',
  done: 'text-pass',
  failed: 'text-fail',
  error: 'text-fail',
  cancelled: 'text-muted',
};

export function FleetWorkbench({
  projects,
  models,
  initialFleets,
}: {
  projects: ProjectSummary[];
  models: ModelOption[];
  initialFleets: FleetView[];
}) {
  const readyModels = models.filter((model) => model.configured && model.enabled !== false && model.capabilities.includes('tools'));
  const [projectId, setProjectId] = useState(projects.find((project) => !project.error)?.id ?? '');
  const [request, setRequest] = useState('');
  const [selectedModels, setSelectedModels] = useState<string[]>(readyModels.slice(0, 2).map((model) => model.id));
  const [allowBreaking, setAllowBreaking] = useState(false);
  const [decision, setDecision] = useState<RoutingDecision>();
  const [fleets, setFleets] = useState(initialFleets);
  const [selectedFleetId, setSelectedFleetId] = useState(initialFleets[0]?.id);
  const [loading, setLoading] = useState<'route' | 'fleet' | 'winner'>();
  const [error, setError] = useState<string>();
  const selectedFleet = fleets.find((fleet) => fleet.id === selectedFleetId);
  const active = selectedFleet?.members.some((member) => member.status === 'booting' || member.status === 'running');

  useEffect(() => {
    if (!selectedFleetId || !active) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/fleets/${encodeURIComponent(selectedFleetId)}`, { cache: 'no-store' });
        if (!response.ok) return;
        const fleet = (await response.json()) as FleetView;
        setFleets((current) => [fleet, ...current.filter((entry) => entry.id !== fleet.id)]);
      } catch {
        // 일시적인 폴링 실패는 다음 주기에 다시 시도한다
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [active, selectedFleetId]);

  const ranked = useMemo(() => decision?.candidates.filter((candidate) => candidate.eligible) ?? [], [decision]);

  async function previewRoute() {
    if (!request.trim()) return;
    setLoading('route');
    setError(undefined);
    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: request, intent: 'build' }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(messageOf(result));
      const next = result as RoutingDecision;
      setDecision(next);
      const top = next.candidates.filter((candidate) => candidate.eligible).slice(0, 2).map((candidate) => candidate.model.id);
      if (top.length >= 2) setSelectedModels(top);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setLoading(undefined);
    }
  }

  async function create() {
    setLoading('fleet');
    setError(undefined);
    try {
      const response = await fetch('/api/fleets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, request, modelIds: selectedModels, allowBreaking }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(messageOf(result));
      const fleet = result as FleetView;
      setFleets((current) => [fleet, ...current.filter((entry) => entry.id !== fleet.id)]);
      setSelectedFleetId(fleet.id);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setLoading(undefined);
    }
  }

  function toggleModel(id: string) {
    setSelectedModels((current) => (current.includes(id) ? current.filter((modelId) => modelId !== id) : current.length < 4 ? [...current, id] : current));
  }

  async function chooseWinner(sessionId: string) {
    if (!selectedFleet) return;
    setLoading('winner');
    setError(undefined);
    try {
      const response = await fetch(`/api/fleets/${encodeURIComponent(selectedFleet.id)}/winner`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(messageOf(result));
      const fleet = result as FleetView;
      setFleets((current) => [fleet, ...current.filter((entry) => entry.id !== fleet.id)]);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setLoading(undefined);
    }
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[24rem_minmax(0,1fr)]">
      <aside className="space-y-4 xl:sticky xl:top-5">
        <section className="glass rounded-2xl p-5">
          <h2 className="text-lg font-semibold">새 병렬 작업</h2>
          <p className="mt-1 text-sm leading-6 text-muted">모델마다 독립된 세션 브랜치와 샌드박스를 만듭니다. 실행 버튼을 누르면 선택한 모델 수만큼 비용이 발생합니다.</p>

          <label className="mt-5 block text-sm font-medium" htmlFor="fleet-project">프로젝트</label>
          <select
            id="fleet-project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="mt-1 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm"
          >
            {projects.filter((project) => !project.error).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>

          <label className="mt-4 block text-sm font-medium" htmlFor="fleet-request">같이 보낼 요청</label>
          <textarea
            id="fleet-request"
            value={request}
            onChange={(event) => { setRequest(event.target.value); setDecision(undefined); }}
            rows={7}
            placeholder="구현할 기능과 완료 조건을 함께 적어 주세요"
            className="mt-1 w-full resize-y rounded-xl border border-line bg-panel px-3 py-2 text-sm leading-6 placeholder:text-muted"
          />

          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-sm font-medium">비교 모델 2~4개</span>
            <button
              type="button"
              disabled={!request.trim() || loading !== undefined}
              onClick={() => void previewRoute()}
              className="rounded-full border border-line px-3 py-1.5 text-xs font-medium hover:border-ink disabled:opacity-50"
            >
              {loading === 'route' ? '분석 중' : '라우터 추천'}
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {models.map((model) => {
              const unavailable = !model.configured || model.enabled === false || !model.capabilities.includes('tools');
              return (
                <label key={model.id} className={`glass-soft flex items-start gap-3 rounded-xl px-3 py-2.5 text-sm ${unavailable ? 'opacity-50' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={selectedModels.includes(model.id)}
                    disabled={unavailable}
                    onChange={() => toggleModel(model.id)}
                    className="mt-0.5 accent-ink"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{model.label}</span>
                    <span className="block truncate text-xs text-muted">{model.provider} · {model.model}</span>
                    {!model.configured && <span className="block text-xs text-fail">{model.apiKeyEnv ?? 'API 키'} 미설정</span>}
                  </span>
                </label>
              );
            })}
          </div>

          {decision && (
            <div className="mt-4 rounded-xl border border-line bg-panel p-3 text-xs leading-5">
              <p className="font-medium">추천: {decision.selected.label}</p>
              <p className="text-muted">{complexityLabel(decision.complexity)} · {decision.risk === 'high' ? '고위험 요청' : '일반 위험'} · 입력 약 {formatTokenCount(decision.inputTokens)}</p>
              <ol className="mt-2 space-y-1">
                {ranked.map((candidate, index) => (
                  <li key={candidate.model.id} className="flex justify-between gap-2">
                    <span>{index + 1}. {candidate.model.label}</span>
                    <span className="font-mono text-muted">{candidate.score.toFixed(3)}{candidate.estimatedCostUsd === undefined ? '' : ` · $${candidate.estimatedCostUsd.toFixed(4)}`}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <label className="mt-4 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={allowBreaking} onChange={(event) => setAllowBreaking(event.target.checked)} className="accent-ink" />
            필드 삭제나 타입 변경 허용
          </label>
          <button
            type="button"
            disabled={!projectId || !request.trim() || selectedModels.length < 2 || loading !== undefined}
            onClick={() => void create()}
            className="mt-4 w-full rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-panel shadow-sm hover:bg-ink/85 disabled:opacity-50"
          >
            {loading === 'fleet' ? '세션을 만드는 중' : `${selectedModels.length}개 에이전트 병렬 실행`}
          </button>
          {error && <p className="mt-3 text-sm text-fail">{error}</p>}
        </section>

        {fleets.length > 0 && (
          <section className="glass rounded-2xl p-4">
            <h2 className="px-1 text-sm font-semibold">최근 Fleet</h2>
            <ul className="mt-2 max-h-72 space-y-1 overflow-auto">
              {fleets.map((fleet) => (
                <li key={fleet.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedFleetId(fleet.id)}
                    className={`w-full rounded-xl px-3 py-2 text-left text-sm ${selectedFleetId === fleet.id ? 'bg-panel shadow-sm ring-1 ring-line' : 'hover:bg-panel/60'}`}
                  >
                    <span className="block truncate font-medium">{fleet.request}</span>
                    <span className="mt-0.5 block text-xs text-muted">{fleet.projectName} · {fleet.members.length}개 · {time(fleet.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>

      <section className="min-w-0">
        {!selectedFleet ? (
          <div className="glass flex min-h-[30rem] items-center justify-center rounded-2xl p-8 text-center text-muted">
            <div><p className="font-medium text-ink">비교할 작업이 아직 없습니다</p><p className="mt-2 text-sm">동일한 요청을 두 모델 이상에 보내 결과를 나란히 확인하세요.</p></div>
          </div>
        ) : (
          <FleetResult fleet={selectedFleet} choosing={loading === 'winner'} onChoose={chooseWinner} />
        )}
      </section>
    </div>
  );
}

function FleetResult({ fleet, choosing, onChoose }: { fleet: FleetView; choosing: boolean; onChoose: (sessionId: string) => Promise<void> }) {
  const finished = fleet.members.filter((member) => !['booting', 'running'].includes(member.status)).length;
  return (
    <div className="space-y-4">
      <header className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted">{fleet.projectName} · Fleet {fleet.id}</p>
            <h2 className="mt-1 text-xl font-semibold leading-8 whitespace-pre-wrap">{fleet.request}</h2>
          </div>
          <span className="glass-soft rounded-full px-3 py-1.5 text-sm text-muted">{finished}/{fleet.members.length} 완료</span>
        </div>
        <p className="mt-3 text-sm text-muted">승자 선택은 결과를 표시할 뿐 원본에 병합하거나 PR을 만들지 않습니다. 세션에서 diff와 검증 근거를 확인한 뒤 내보내세요.</p>
      </header>
      <div className={`grid gap-4 ${fleet.members.length >= 3 ? '2xl:grid-cols-3' : 'lg:grid-cols-2'}`}>
        {fleet.members.map((member) => {
          const winner = fleet.winnerSessionId === member.sessionId;
          return (
            <article key={member.sessionId} className={`glass min-w-0 rounded-2xl p-5 ${winner ? 'ring-2 ring-pass' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold">{member.label}</p>
                  <p className="truncate font-mono text-xs text-muted">{member.provider} · {member.modelId}</p>
                </div>
                <span className={`shrink-0 text-sm font-medium ${STATUS_COLOR[member.status]}`}>{winner ? '선택됨' : STATUS[member.status]}</span>
              </div>

              <dl className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                <Metric label="턴" value={member.turns?.toLocaleString() ?? '—'} />
                <Metric label="토큰" value={member.usage ? formatTokenCount(totalTokens(member.usage)) : '—'} />
                <Metric label="비용" value={member.costUsd === undefined ? '—' : `$${member.costUsd.toFixed(4)}`} />
              </dl>

              <div className="mt-4 min-h-36 rounded-xl border border-line bg-panel p-3">
                {member.summary ? <p className="text-sm leading-6 whitespace-pre-wrap">{member.summary}</p> : <p className="text-sm text-muted motion-safe:animate-pulse">{member.status === 'booting' ? '독립 샌드박스를 준비하고 있습니다.' : '에이전트가 도구를 사용하고 검증 게이트를 통과하는 중입니다.'}</p>}
              </div>

              {member.checkpoint && (
                <p className="mt-3 text-xs text-muted">체크포인트 <span className="font-mono text-ink">{member.checkpoint.shortSha}</span> · 변경 {member.checkpoint.files.length}개</p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {!member.sessionId.startsWith('failed-') && (
                  <Link href={`/sessions/${member.sessionId}`} className="rounded-full border border-line px-3 py-1.5 text-sm font-medium hover:border-ink">세션·diff 보기</Link>
                )}
                {member.status === 'done' && !winner && (
                  <button type="button" disabled={choosing} onClick={() => void onChoose(member.sessionId)} className="rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-panel disabled:opacity-50">이 결과 선택</button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-line bg-panel px-2 py-2"><dt className="text-muted">{label}</dt><dd className="mt-0.5 font-mono font-medium text-ink">{value}</dd></div>;
}

function complexityLabel(value: RoutingDecision['complexity']): string {
  return value === 'complex' ? '복잡한 요청' : value === 'normal' ? '보통 요청' : '단순 요청';
}

function messageOf(value: unknown): string {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') return value.error;
  return '요청을 처리하지 못했습니다';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function time(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}
