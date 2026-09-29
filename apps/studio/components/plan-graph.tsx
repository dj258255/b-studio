'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { NoteKind } from '@b-studio/agent';
import type { TaskPlanLaneView, TaskPlanNoteView, TaskPlanTaskView, TaskPlanView } from '@/lib/task-plan-types';
import {
  buildPlanGraph,
  shortLabel,
  STATE_ICON,
  STATE_LABEL,
  STATE_TONE,
  type PlanGraphEdge,
  type PlanGraphNode,
  type PlanGraphTone,
} from '@/lib/plan-graph';
import { describeTokens, hasTokens } from '@/lib/usage';

const TONE_FILL: Record<PlanGraphTone, string> = { pass: 'fill-pass', fail: 'fill-fail', wait: 'fill-wait', idle: 'fill-muted' };

const NOTE_LABEL: Record<NoteKind, string> = { contract: '계약', failure: '실패', fact: '사실' };

type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string };

/**
 * 작업 분해를 관계 그래프로 보여 준다. 레인·작업·통합 노드와 그 사이의 의존·메모 간선을 SVG로 그린다.
 * 실행 중에는 부모(작업대)가 주기적으로 다시 받은 plan으로 다시 그린다(선택은 노드 id로 유지된다).
 */
export function PlanGraphView({ plan }: { plan: TaskPlanView }) {
  const graph = buildPlanGraph(plan);
  const [selection, setSelection] = useState<Selection>();
  const selectedNode = selection?.kind === 'node' ? graph.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === 'edge' ? graph.edges.find((edge) => edge.id === selection.id) : undefined;
  const nameOf = (id: string) => graph.nodes.find((node) => node.id === id)?.label ?? id;
  const taskCount = graph.nodes.filter((node) => node.kind === 'task').length;

  if (graph.nodes.length === 0) {
    return <p className="rounded-panel border border-line bg-panel p-5 text-sm text-muted">아직 그릴 레인이 없습니다. 계획을 승인하면 레인과 작업이 그려집니다.</p>;
  }

  return (
    <section className="space-y-3" aria-label="관계 그래프">
      <Legend />
      <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 overflow-x-auto rounded-panel border border-line bg-panel p-2">
          <svg
            role="img"
            aria-label={`작업 분해 관계 그래프. 레인 ${graph.laneCount}개, 작업 ${taskCount}개, 간선 ${graph.edges.length}개`}
            viewBox={`0 0 ${graph.width} ${graph.height}`}
            width={graph.width}
            height={graph.height}
            className="block"
          >
            <defs>
              {(['idle', 'pass', 'fail', 'wait'] as const).map((tone) => (
                <marker key={tone} id={`plan-graph-arrow-${tone}`} viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 8 4 L 0 8 z" className={TONE_FILL[tone]} />
                </marker>
              ))}
            </defs>
            {graph.edges.map((edge) => (
              <PlanEdge
                key={edge.id}
                edge={edge}
                selected={selection?.kind === 'edge' && selection.id === edge.id}
                onSelect={() => setSelection({ kind: 'edge', id: edge.id })}
              />
            ))}
            {graph.nodes.map((node) => (
              <PlanNode
                key={node.id}
                node={node}
                selected={selection?.kind === 'node' && selection.id === node.id}
                onSelect={() => setSelection({ kind: 'node', id: node.id })}
              />
            ))}
          </svg>
        </div>
        <aside className="min-w-0 2xl:sticky 2xl:top-4">
          <PlanDetail plan={plan} node={selectedNode} edge={selectedEdge} nameOf={nameOf} />
        </aside>
      </div>
    </section>
  );
}

function Legend() {
  return (
    <div className="glass flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel px-4 py-2.5 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block w-6 border-t border-muted" />
        작업 의존·통합
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block w-6 border-t-2 border-muted" />
        계약 메모
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block w-6 border-t-2 border-dashed border-fail" />
        실패 메모
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block w-6 border-t border-muted" />
        사실 메모(가는 선)
      </span>
      <span aria-hidden className="text-line">
        |
      </span>
      <span>{STATE_ICON.done} {STATE_LABEL.done}</span>
      <span>{STATE_ICON.running} {STATE_LABEL.running}</span>
      <span>{STATE_ICON.queued} {STATE_LABEL.queued}</span>
      <span className="text-fail">{STATE_ICON.failed} {STATE_LABEL.failed}</span>
      <span className="text-fail">{STATE_ICON.violation} {STATE_LABEL.violation}</span>
    </div>
  );
}

function PlanEdge({ edge, selected, onSelect }: { edge: PlanGraphEdge; selected: boolean; onSelect: () => void }) {
  if (edge.kind !== 'note') {
    return (
      <path
        d={edge.path}
        fill="none"
        markerEnd="url(#plan-graph-arrow-idle)"
        strokeWidth={edge.kind === 'integration' ? 1.6 : 1.2}
        className={edge.kind === 'integration' ? 'stroke-muted' : 'stroke-line'}
      />
    );
  }

  const kind = edge.noteKind ?? 'fact';
  const dashed = kind === 'failure';
  // 계약은 실선, 실패는 점선, 사실은 가는 선으로 모양을 가른다
  const stroke = dashed ? 'stroke-fail' : selected ? 'stroke-ink' : 'stroke-muted';
  const width = kind === 'fact' ? 0.9 : 1.6;
  const count = edge.noteIndexes?.length ?? 1;

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${NOTE_LABEL[kind]} 메모 ${count}개: 눌러서 본문 보기`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className="cursor-pointer"
    >
      {/* 누르기 쉬운 넓은 투명 선. 보이는 선은 아래에 있다 */}
      <path d={edge.path} fill="none" strokeWidth={12} className="stroke-transparent" />
      <path d={edge.path} fill="none" markerEnd={`url(#plan-graph-arrow-${dashed ? 'fail' : 'idle'})`} strokeWidth={width} strokeDasharray={dashed ? '5 4' : undefined} className={stroke} />
      {edge.label && edge.labelAt && (
        <text x={edge.labelAt.x} y={edge.labelAt.y} textAnchor="middle" className="fill-muted text-[9px]">
          {edge.label}
        </text>
      )}
    </g>
  );
}

function PlanNode({ node, selected, onSelect }: { node: PlanGraphNode; selected: boolean; onSelect: () => void }) {
  const tone = STATE_TONE[node.state];
  const badge = node.noteRead > 0 ? ` · 메모 ${node.noteRead}` : '';
  const aria = node.kind === 'lane' ? `레인 ${node.label}: ${STATE_LABEL[node.state]}${node.noteRead > 0 ? `, 메모 ${node.noteRead}개` : ''}${node.violation ? `, 쓰기 범위 밖 파일 ${node.violation.length}개` : ''}` : `${node.kind === 'integration' ? '통합' : '작업'} ${node.title}: ${STATE_LABEL[node.state]}${node.noteRead > 0 ? `, 메모 ${node.noteRead}개` : ''}`;

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={aria}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className="cursor-pointer"
    >
      <title>{`${node.title} · ${STATE_LABEL[node.state]}${node.detail ? ` · ${node.detail}` : ''}`}</title>
      <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={6} className={`fill-panel ${selected ? 'stroke-ink stroke-2' : 'stroke-line'}`} />
      {/* 색만으로 상태를 전하지 않도록 왼쪽 띠·아이콘·글자를 함께 둔다 */}
      <rect x={node.x} y={node.y} width={3} height={node.height} rx={1.5} className={TONE_FILL[tone]} />
      <text x={node.x + 11} y={node.y + 16} className="fill-ink text-[11px] font-medium">
        {node.label}
      </text>
      <text x={node.x + 11} y={node.y + 30} className={`text-[10px] ${TONE_FILL[tone]}`}>
        {STATE_ICON[node.state]} {STATE_LABEL[node.state]}
        {badge}
      </text>
    </g>
  );
}

function PlanDetail({
  plan,
  node,
  edge,
  nameOf,
}: {
  plan: TaskPlanView;
  node?: PlanGraphNode;
  edge?: PlanGraphEdge;
  nameOf: (id: string) => string;
}) {
  if (edge) return <NoteDetail plan={plan} edge={edge} nameOf={nameOf} />;
  if (node) return <NodeDetail plan={plan} node={node} />;
  return (
    <p className="rounded-panel border border-line bg-panel p-4 text-sm leading-6 text-muted">
      노드나 메모 선을 누르면 여기에 자세히 보여 줍니다. Tab으로 노드를 옮겨 다니고 Enter로 열 수 있습니다.
    </p>
  );
}

function NoteDetail({ plan, edge, nameOf }: { plan: TaskPlanView; edge: PlanGraphEdge; nameOf: (id: string) => string }) {
  const notes = (edge.noteIndexes ?? []).map((index) => plan.board?.notes[index]).filter((note): note is TaskPlanNoteView => note !== undefined);
  return (
    <div className="space-y-3 rounded-panel border border-line bg-panel p-4">
      <div>
        <h3 className="text-sm font-semibold">
          {NOTE_LABEL[edge.noteKind ?? 'fact']} 메모 {notes.length}개
        </h3>
        <p className="mt-0.5 text-xs text-muted">
          {nameOf(edge.from)} → {nameOf(edge.to)}
        </p>
      </div>
      {notes.length === 0 ? (
        <p className="text-sm text-muted">메모 본문을 찾을 수 없습니다.</p>
      ) : (
        notes.map((note, index) => (
          <article key={`${note.at}-${index}`} className="rounded-md border border-line p-3">
            <p className="text-xs font-medium">
              [{note.kind}·{note.priority}] {note.lane}
              {note.task ? ` / ${note.task}` : ''} · {note.by === 'platform' ? '검증기' : '모델'}
            </p>
            <p className="mt-1 text-sm leading-5 whitespace-pre-wrap">{note.body}</p>
            {note.refs.length > 0 && <p className="mt-1 font-mono text-xs break-all text-muted">{note.refs.join(', ')}</p>}
            <p className="mt-1 text-xs text-muted">{note.at}</p>
          </article>
        ))
      )}
    </div>
  );
}

function NodeDetail({ plan, node }: { plan: TaskPlanView; node: PlanGraphNode }) {
  if (node.kind === 'task') {
    const found = findTask(plan, node.taskId);
    if (!found) return <p className="rounded-panel border border-line bg-panel p-4 text-sm text-muted">작업을 찾을 수 없습니다.</p>;
    const { lane, task } = found;
    const notes = (plan.board?.notes ?? []).filter((note) => note.task === task.id);
    return (
      <div className="space-y-3 rounded-panel border border-line bg-panel p-4">
        <div>
          <p className="text-xs text-muted">
            {lane.id} 레인 · 작업 {task.id}
          </p>
          <h3 className="mt-0.5 text-sm font-semibold">{task.title}</h3>
          <p className="mt-1 text-xs font-medium">
            {STATE_ICON[node.state]} {STATE_LABEL[node.state]}
          </p>
        </div>
        <Section title="요청">
          <p className="text-sm leading-5 whitespace-pre-wrap">{shortLabel(task.request, 400)}</p>
        </Section>
        <Section title="쓰기 범위">
          <p className="font-mono text-xs break-all text-muted">{task.paths.join(', ')}</p>
        </Section>
        {task.dependsOn.length > 0 && (
          <Section title="선행 작업">
            <p className="text-xs text-muted">{task.dependsOn.join(', ')}</p>
          </Section>
        )}
        <Section title="실행 결과">
          {task.run ? (
            <>
              <p className="text-sm">
                {task.run.status === 'done' ? '통과' : task.run.status}
                {task.run.durationMs !== undefined && <span className="text-muted"> · {formatDuration(task.run.durationMs)}</span>}
              </p>
              {task.run.usage && hasTokens(task.run.usage) && <p className="mt-0.5 text-xs text-muted">{describeTokens(task.run.usage)}</p>}
              {task.summary && <p className="mt-1 text-xs leading-5 whitespace-pre-wrap text-muted">{task.summary}</p>}
            </>
          ) : (
            <p className="text-sm text-muted">아직 실행 기록이 없습니다.</p>
          )}
        </Section>
        {task.checkpoint && (
          <Section title="체크포인트">
            <p className="text-xs text-muted">
              <span className="font-mono text-ink">{task.checkpoint.shortSha}</span> · 파일 {task.checkpoint.files.length}개
            </p>
          </Section>
        )}
        <NoteList notes={notes} empty="이 작업이 쓴 메모가 없습니다." />
        {lane.sessionId && <SessionLink sessionId={lane.sessionId} label="레인 세션 보기" />}
      </div>
    );
  }

  if (node.kind === 'lane') {
    const lane = plan.lanes.find((candidate) => candidate.id === node.lane);
    if (!lane) return <p className="rounded-panel border border-line bg-panel p-4 text-sm text-muted">레인을 찾을 수 없습니다.</p>;
    const wrote = (plan.board?.notes ?? []).filter((note) => note.lane === lane.id);
    return (
      <div className="space-y-3 rounded-panel border border-line bg-panel p-4">
        <div>
          <p className="text-xs text-muted">레인</p>
          <h3 className="mt-0.5 text-sm font-semibold">{lane.id}</h3>
          <p className="mt-1 text-xs font-medium">
            {STATE_ICON[node.state]} {STATE_LABEL[node.state]}
            {lane.bootMs !== undefined && <span className="text-muted"> · 준비 {formatDuration(lane.bootMs)}</span>}
          </p>
        </div>
        <Section title="쓰기 범위">
          <p className="font-mono text-xs break-all text-muted">{lane.paths.join(', ')}</p>
        </Section>
        <Section title="작업">
          <p className="text-xs text-muted">
            {lane.tasks.filter((task) => task.status === 'done').length}개 완료 / 전체 {lane.tasks.length}개
          </p>
        </Section>
        {lane.changedFiles && lane.changedFiles.length > 0 && (
          <Section title={`바꾼 파일 ${lane.changedFiles.length}개`}>
            <p className="font-mono text-xs break-all text-muted">{lane.changedFiles.slice(0, 12).join(', ')}{lane.changedFiles.length > 12 ? ' 외' : ''}</p>
          </Section>
        )}
        {node.violation && (
          <p className="rounded-md border border-fail/40 bg-fail/10 px-3 py-2 text-xs text-fail">
            쓰기 범위 밖 파일을 바꿨습니다: <span className="font-mono break-all">{node.violation.join(', ')}</span>
          </p>
        )}
        {lane.error && <p className="text-sm text-fail whitespace-pre-wrap">{lane.error}</p>}
        <NoteList notes={wrote} empty="이 레인이 쓴 메모가 없습니다." />
        {lane.sessionId && <SessionLink sessionId={lane.sessionId} label="레인 세션 보기" />}
      </div>
    );
  }

  const integration = plan.integration;
  if (!integration) return <p className="rounded-panel border border-line bg-panel p-4 text-sm text-muted">통합 단계가 아직 없습니다.</p>;
  return (
    <div className="space-y-3 rounded-panel border border-line bg-panel p-4">
      <div>
        <p className="text-xs text-muted">맨 오른쪽 한 칸 · 허브</p>
        <h3 className="mt-0.5 text-sm font-semibold">통합</h3>
        <p className="mt-1 text-xs font-medium">
          {STATE_ICON[node.state]} {STATE_LABEL[node.state]}
          {integration.bootMs !== undefined && <span className="text-muted"> · 준비 {formatDuration(integration.bootMs)}</span>}
        </p>
      </div>
      <Section title="다시 적용한 파일">
        <p className="font-mono text-xs break-all text-muted">{integration.files.length > 0 ? integration.files.join(', ') : '없음'}</p>
      </Section>
      {integration.deleted.length > 0 && (
        <Section title={`지운 파일 ${integration.deleted.length}개`}>
          <p className="font-mono text-xs break-all text-fail">{integration.deleted.join(', ')}</p>
        </Section>
      )}
      {integration.repair && (
        <p className={`text-sm ${integration.repair.status === 'done' ? 'text-pass' : 'text-fail'}`}>S4 수리 요청 {integration.repair.status === 'done' ? '성공' : '실패'}</p>
      )}
      {integration.run && (
        <Section title="실행 결과">
          <p className="text-sm">
            {integration.run.status}
            {integration.run.durationMs !== undefined && <span className="text-muted"> · {formatDuration(integration.run.durationMs)}</span>}
          </p>
          {integration.run.usage && hasTokens(integration.run.usage) && <p className="mt-0.5 text-xs text-muted">{describeTokens(integration.run.usage)}</p>}
        </Section>
      )}
      {integration.error && <p className="text-sm text-fail whitespace-pre-wrap">{integration.error}</p>}
      {integration.checkpoint && (
        <Section title="체크포인트">
          <p className="text-xs text-muted">
            <span className="font-mono text-ink">{integration.checkpoint.shortSha}</span> · 파일 {integration.checkpoint.files.length}개
          </p>
        </Section>
      )}
      {integration.sessionId && <SessionLink sessionId={integration.sessionId} label="통합 세션·diff 보기" />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-muted">{title}</h4>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function NoteList({ notes, empty }: { notes: TaskPlanNoteView[]; empty: string }) {
  return (
    <Section title={`쓴 메모 ${notes.length}개`}>
      {notes.length === 0 ? (
        <p className="text-xs text-muted">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {notes.map((note, index) => (
            <li key={`${note.at}-${index}`} className="rounded-md border border-line px-2 py-1.5">
              <p className="text-xs font-medium">
                [{NOTE_LABEL[note.kind]}·{note.priority}] {note.by === 'platform' ? '검증기' : '모델'}
              </p>
              <p className="mt-0.5 text-xs leading-5 whitespace-pre-wrap">{shortLabel(note.body, 160)}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SessionLink({ sessionId, label }: { sessionId: string; label: string }) {
  return (
    <Link href={`/sessions/${sessionId}`} className="inline-block rounded-control border border-line px-3 py-1.5 text-sm font-medium hover:border-ink">
      {label}
    </Link>
  );
}

function findTask(plan: TaskPlanView, taskId: string | undefined): { lane: TaskPlanLaneView; task: TaskPlanTaskView } | undefined {
  if (!taskId) return undefined;
  for (const lane of plan.lanes) {
    const task = lane.tasks.find((candidate) => candidate.id === taskId);
    if (task) return { lane, task };
  }
  return undefined;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '-';
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}초`;
  return `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1_000)}초`;
}
