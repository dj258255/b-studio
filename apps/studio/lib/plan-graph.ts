import type { NoteKind, Topology } from '@b-studio/agent';
import type { TaskPlanLaneView, TaskPlanNoteView, TaskPlanStepStatus, TaskPlanView } from './task-plan-types';

/**
 * 작업 분해를 관계 그래프로 배치한다(순수 함수, 라이브러리 없이 결정론적 격자).
 * 레인은 열 하나씩, 레인 안 작업은 위에서 아래로, 통합은 맨 오른쪽 한 칸이다.
 * 간선은 작업 의존(같은 레인이면 세로, 다른 레인이면 가로 곡선), 작업 → 통합, 게시판 메모(작성 레인 → 읽을 수 있는 레인)다.
 *
 * 서버 전용 모듈(레인 실행·샌드박스)을 화면에 끌어오지 않도록 여기서는 순수 함수만 쓴다.
 * 쓰기 범위 판정과 메모 읽기 규칙은 에이전트와 같은 규칙을 이 파일 안에서 다시 적는다(타입만 가져온다).
 */

/** 그래프 노드 상태. 화면은 색과 함께 글자·아이콘으로도 전한다(색만으로 상태를 전하지 않는다) */
export type PlanGraphState = 'queued' | 'booting' | 'running' | 'done' | 'failed' | 'skipped' | 'violation';
export type PlanGraphTone = 'pass' | 'fail' | 'wait' | 'idle';

export const STATE_LABEL: Record<PlanGraphState, string> = {
  queued: '대기',
  booting: '준비 중',
  running: '실행 중',
  done: '완료',
  failed: '실패',
  skipped: '건너뜀',
  violation: '범위 위반',
};

export const STATE_ICON: Record<PlanGraphState, string> = {
  queued: '○',
  booting: '◔',
  running: '◐',
  done: '●',
  failed: '✕',
  skipped: '–',
  violation: '!',
};

export const STATE_TONE: Record<PlanGraphState, PlanGraphTone> = {
  queued: 'idle',
  booting: 'wait',
  running: 'wait',
  done: 'pass',
  failed: 'fail',
  skipped: 'idle',
  violation: 'fail',
};

/** 노드 하나의 그래프 좌표. 겹치지 않도록 열과 행을 상수 간격으로 둔다 */
export interface PlanGraphNode {
  id: string;
  kind: 'lane' | 'task' | 'integration';
  /** 이 노드가 속한 레인(통합 노드는 없다) */
  lane?: string;
  taskId?: string;
  /** 노드 안에 적는 짧은 이름 */
  label: string;
  /** 상세 패널에 쓰는 전체 이름 */
  title: string;
  /** 쓰기 범위처럼 노드 아래에 붙는 설명 */
  detail?: string;
  /** 쓰기 범위 밖 파일(레인 노드에만 있다) */
  violation?: string[];
  state: PlanGraphState;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 이 노드가 쓴 메모 수 */
  noteWrote: number;
  /** 이 노드(레인)가 읽을 수 있는 메모 수 */
  noteRead: number;
}

export interface PlanGraphEdge {
  id: string;
  kind: 'depends' | 'integration' | 'note';
  from: string;
  to: string;
  /** 메모 간선이면 메모 종류(선 모양을 가른다: contract 실선, failure 점선, fact 가는 선) */
  noteKind?: NoteKind;
  /** 메모 간선이면 이 선이 나타내는 메모들의 board.notes 인덱스 */
  noteIndexes?: number[];
  /** 같은 (작성→읽기, 종류) 메모가 둘 이상일 때 선 위에 적는 수 */
  label?: string;
  /** 선 위에 라벨을 적을 자리 */
  labelAt?: { x: number; y: number };
  /** SVG path의 d */
  path: string;
  /** 같은 열(레인)을 잇는 세로 선인지 */
  vertical: boolean;
}

export interface PlanGraph {
  nodes: PlanGraphNode[];
  edges: PlanGraphEdge[];
  width: number;
  height: number;
  laneCount: number;
  /** 레인 하나에 든 작업 수의 최댓값 */
  maxTasks: number;
}

export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 38;
export const ROW_GAP = 10;
export const COLUMN_GAP = 72;
export const PADDING = 20;
/** 메모 간선이 노드 위쪽으로 휘어 지나갈 자리 */
export const NOTE_SPACE = 54;
const ROW_STEP = NODE_HEIGHT + ROW_GAP;
/** star·hierarchical에서 허브로 보는 레인. 서버(Board)가 'plan'으로 둔다 */
const HUB = 'plan';

export function laneNodeId(lane: string): string {
  return `lane:${lane}`;
}

export function taskNodeId(task: string): string {
  return `task:${task}`;
}

export const INTEGRATION_NODE_ID = 'integration';

const STATE_BY_STEP: Record<TaskPlanStepStatus, PlanGraphState> = {
  queued: 'queued',
  booting: 'booting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

export function graphState(status: TaskPlanStepStatus): PlanGraphState {
  return STATE_BY_STEP[status];
}

/** 노드 안에 넣을 짧은 이름. 넘치면 자른다(전체 이름은 상세 패널에 있다) */
export function shortLabel(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export function buildPlanGraph(plan: TaskPlanView): PlanGraph {
  const lanes = plan.lanes ?? [];
  const topology: Topology = plan.coordination?.topology ?? 'mesh';
  const notes = plan.board?.notes ?? [];
  const top = PADDING + NOTE_SPACE;
  const nodes: PlanGraphNode[] = [];
  const edges: PlanGraphEdge[] = [];
  const laneNodes = new Map<string, PlanGraphNode>();
  const taskNodes = new Map<string, PlanGraphNode>();

  lanes.forEach((lane, column) => {
    const violation = laneViolation(lane);
    const laneNode: PlanGraphNode = {
      id: laneNodeId(lane.id),
      kind: 'lane',
      lane: lane.id,
      label: lane.id,
      title: `${lane.id} 레인`,
      detail: lane.paths.join(', '),
      ...(violation ? { violation } : {}),
      state: violation ? 'violation' : graphState(lane.status),
      x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
      y: top,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      noteWrote: 0,
      noteRead: 0,
    };
    laneNodes.set(lane.id, laneNode);
    nodes.push(laneNode);

    lane.tasks.forEach((task, index) => {
      const taskNode: PlanGraphNode = {
        id: taskNodeId(task.id),
        kind: 'task',
        lane: lane.id,
        taskId: task.id,
        label: `${index + 1}. ${shortLabel(task.title, 20)}`,
        title: task.title,
        detail: task.paths.join(', '),
        state: graphState(task.status),
        x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
        y: top + ROW_STEP * (index + 1),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        noteWrote: 0,
        noteRead: 0,
      };
      taskNodes.set(task.id, taskNode);
      nodes.push(taskNode);
    });
  });

  const maxTasks = lanes.reduce((most, lane) => Math.max(most, lane.tasks.length), 0);

  // 통합은 맨 오른쪽 한 칸. 아직 통합 단계가 없으면 그리지 않는다
  const integration = plan.integration;
  let integrationNode: PlanGraphNode | undefined;
  if (integration) {
    integrationNode = {
      id: INTEGRATION_NODE_ID,
      kind: 'integration',
      label: '통합',
      title: '통합',
      detail: integration.files.join(', '),
      state: graphState(integration.status),
      x: PADDING + lanes.length * (NODE_WIDTH + COLUMN_GAP),
      y: top,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      noteWrote: 0,
      noteRead: 0,
    };
    nodes.push(integrationNode);
  }

  // 작업 의존: 같은 레인이면 세로, 다른 레인이면 가로 곡선
  for (const lane of lanes) {
    for (const task of lane.tasks) {
      for (const dependency of task.dependsOn) {
        const from = taskNodes.get(dependency);
        const to = taskNodes.get(task.id);
        if (!from || !to) continue;
        const vertical = from.lane === to.lane;
        edges.push({
          id: `depends:${from.id}->${to.id}`,
          kind: 'depends',
          from: from.id,
          to: to.id,
          path: vertical ? verticalPath(from, to) : curvePath(from, to),
          vertical,
        });
      }
    }
  }

  // 작업 → 통합: 레인의 마지막 작업 결과가 통합으로 간다(작업이 없으면 레인 머리에서)
  if (integrationNode) {
    for (const lane of lanes) {
      const last = lane.tasks.length > 0 ? taskNodes.get(lane.tasks[lane.tasks.length - 1]!.id) : laneNodes.get(lane.id);
      if (!last) continue;
      edges.push({
        id: `integration:${last.id}`,
        kind: 'integration',
        from: last.id,
        to: integrationNode.id,
        path: curvePath(last, integrationNode),
        vertical: false,
      });
    }
  }

  // 게시판 메모: 작성 노드 → 읽을 수 있는 노드. topology 규칙은 에이전트(Board)와 같다.
  // 허브(계획)가 쓴 메모는 통합 노드에서 나가고, 레인이 쓴 메모가 레인끼리 직접 닿지 못하면 통합 노드로 간다
  const nodeFor = (lane: string): PlanGraphNode | undefined => laneNodes.get(lane) ?? integrationNode;
  const grouped = new Map<string, PlanGraphEdge>();
  const pairCount = new Map<string, number>();
  notes.forEach((note, index) => {
    const author = nodeFor(note.lane);
    // 허브는 어느 topology에서도 모든 메모를 읽는다. 통합 노드의 읽기 수는 따로 센다
    if (author) author.noteWrote += 1;
    for (const lane of lanes) {
      if (canLaneRead(topology, lane, note, lanes)) laneNodes.get(lane.id)!.noteRead += 1;
    }
    if (!author) return;

    const readers = noteReaders(topology, lanes, note, integrationNode !== undefined);
    for (const reader of readers) {
      const target = nodeFor(reader);
      if (!target || target.id === author.id) continue;
      const key = `${author.id}->${target.id}:${note.kind}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.noteIndexes!.push(index);
        existing.label = `${NOTE_KIND_LABEL[note.kind]} ${existing.noteIndexes!.length}`;
        continue;
      }
      // 같은 두 노드를 잇는 메모(방향이 반대인 것 포함)는 높이를 달리해 선이 겹치지 않게 한다
      const pairKey = [author.id, target.id].sort().join('<->');
      const pair = pairCount.get(pairKey) ?? 0;
      pairCount.set(pairKey, pair + 1);
      const geometry = notePath(author, target, pair);
      grouped.set(key, {
        id: `note:${key}`,
        kind: 'note',
        from: author.id,
        to: target.id,
        noteKind: note.kind,
        noteIndexes: [index],
        path: geometry.path,
        labelAt: geometry.labelAt,
        vertical: false,
      });
    }
  });
  if (integrationNode) integrationNode.noteRead = notes.length;
  edges.push(...grouped.values());

  return { nodes, edges, width: graphWidth(nodes), height: graphHeight(nodes), laneCount: lanes.length, maxTasks };
}

const NOTE_KIND_LABEL: Record<NoteKind, string> = { contract: '계약', failure: '실패', fact: '사실' };

/**
 * 그 레인이 이 메모를 읽을 수 있는가. 에이전트의 canRead와 같은 규칙이다:
 * 검증기(플랫폼)가 쓴 메모는 어느 topology에서도 읽고, 자기 메모·허브 메모는 읽고,
 * mesh는 전부, hierarchical은 같은 그룹(첫 쓰기 범위)까지, star는 레인끼리 직접 보지 않는다
 */
export function canLaneRead(topology: Topology, lane: TaskPlanLaneView, note: TaskPlanNoteView, lanes: readonly TaskPlanLaneView[]): boolean {
  if (note.by === 'platform') return true;
  if (note.lane === lane.id) return true;
  if (topology === 'mesh') return true;
  if (note.lane === HUB) return true;
  if (topology === 'hierarchical') {
    const group = laneGroup(lane);
    const authorGroup = authorLaneGroup(lanes, note.lane);
    return group !== undefined && authorGroup !== undefined && group === authorGroup;
  }
  // star: 허브와 자기 것, 플랫폼 메모만 읽는다
  return false;
}

/**
 * 메모가 어느 레인에 닿는가. 읽을 수 있는 레인이 하나도 없고 허브로만 갈 수 있으면
 * 허브(통합 노드)로 가는 화살표 하나를 그린다(star면 허브 경유 — 화면에서 보이게 한다)
 */
function noteReaders(topology: Topology, lanes: readonly TaskPlanLaneView[], note: TaskPlanNoteView, hasHub: boolean): string[] {
  const direct = lanes.filter((lane) => lane.id !== note.lane && canLaneRead(topology, lane, note, lanes)).map((lane) => lane.id);
  if (direct.length > 0) return direct;
  // 레인이 쓴 메모가 레인끼리 직접 닿지 못하면(star, 그리고 그룹이 없는 hierarchical) 허브를 거친다
  if (hasHub && note.by === 'model' && note.lane !== HUB) return [HUB];
  return direct;
}

/** 레인의 그룹: 첫 쓰기 범위. 서버(laneGroup)와 같은 규칙이다 */
function laneGroup(lane: TaskPlanLaneView): string | undefined {
  return lane.paths[0];
}

function authorLaneGroup(lanes: readonly TaskPlanLaneView[], laneId: string): string | undefined {
  const lane = lanes.find((candidate) => candidate.id === laneId);
  return lane ? laneGroup(lane) : undefined;
}

/** 레인이 쓴 파일 중 쓰기 범위 밖에 있는 것. 통합 전에 서버가 다시 거르는 것과 같은 규칙(isWithinScope)이다 */
export function laneViolation(lane: TaskPlanLaneView): string[] | undefined {
  if (!lane.changedFiles || lane.changedFiles.length === 0) return undefined;
  const outside = lane.changedFiles.filter((file) => !lane.paths.some((scope) => inScope(file, scope)));
  return outside.length > 0 ? outside : undefined;
}

/** 서버의 isWithinScope(packages/agent/src/policy.ts)와 같은 규칙: 표기만 정리하고 이름은 글자 그대로 비교한다. 화면 표시용 사본이다 */
function inScope(file: string, scope: string): boolean {
  const tidy = (value: string): string | undefined => {
    const parts: string[] = [];
    for (const part of value.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (parts.length === 0) return undefined;
        parts.pop();
      } else parts.push(part);
    }
    return parts.join('/');
  };
  const target = file.startsWith('/') ? undefined : tidy(file);
  const rule = tidy(scope.replaceAll('\\', '/'));
  if (target === undefined || rule === undefined) return false;
  return rule === '' || target === rule || target.startsWith(`${rule}/`);
}

function verticalPath(from: PlanGraphNode, to: PlanGraphNode): string {
  const x = from.x + from.width / 2;
  return `M ${x} ${from.y + from.height} L ${x} ${to.y}`;
}

/** 왼쪽 노드의 오른쪽 변에서 오른쪽 노드의 왼쪽 변으로 휘어 지나간다. 오른쪽에서 왼쪽으로 가면 반대다 */
function curvePath(from: PlanGraphNode, to: PlanGraphNode): string {
  const forward = from.x <= to.x;
  const a = forward ? { x: from.x + from.width, y: from.y + from.height / 2 } : { x: from.x, y: from.y + from.height / 2 };
  const b = forward ? { x: to.x, y: to.y + to.height / 2 } : { x: to.x + to.width, y: to.y + to.height / 2 };
  const bend = Math.max(24, Math.abs(b.x - a.x) / 2) * (forward ? 1 : -1);
  return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
}

/** 메모 간선은 노드 위쪽으로 휘어 작업 노드를 가로지르지 않는다. 같은 짝이 여러 개면 조금씩 높이를 달리한다 */
function notePath(from: PlanGraphNode, to: PlanGraphNode, stack: number): { path: string; labelAt: { x: number; y: number } } {
  const ax = from.x + from.width / 2;
  const bx = to.x + to.width / 2;
  const lift = 16 + 10 * (stack % 4);
  return {
    path: `M ${ax} ${from.y} C ${ax} ${from.y - lift}, ${bx} ${to.y - lift}, ${bx} ${to.y}`,
    labelAt: { x: (ax + bx) / 2, y: (from.y + to.y) / 2 - lift * 0.75 },
  };
}

function graphWidth(nodes: readonly PlanGraphNode[]): number {
  if (nodes.length === 0) return PADDING * 2;
  return Math.max(...nodes.map((node) => node.x + node.width)) + PADDING;
}

function graphHeight(nodes: readonly PlanGraphNode[]): number {
  if (nodes.length === 0) return PADDING * 2;
  return Math.max(...nodes.map((node) => node.y + node.height)) + PADDING;
}
