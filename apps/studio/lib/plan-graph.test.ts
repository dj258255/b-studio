import { canRead, type Note, type Topology } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import type { TaskPlanLaneView, TaskPlanNoteView, TaskPlanTaskView, TaskPlanView } from './task-plan-types';
import { buildPlanGraph, canLaneRead, INTEGRATION_NODE_ID, laneNodeId, NODE_HEIGHT, NODE_WIDTH, shortLabel, STATE_TONE, taskNodeId, type PlanGraphNode } from './plan-graph';

function task(id: string, extra: Partial<TaskPlanTaskView> = {}): TaskPlanTaskView {
  return { id, title: `${id} 작업`, request: `${id} 요청`, paths: ['src'], dependsOn: [], status: 'queued', ...extra };
}

function lane(id: string, paths: string[], tasks: TaskPlanTaskView[], extra: Partial<TaskPlanLaneView> = {}): TaskPlanLaneView {
  return { id, paths, status: 'queued', tasks, ...extra };
}

function plan(overrides: Partial<TaskPlanView> & { lanes: TaskPlanLaneView[] }): TaskPlanView {
  return {
    id: 'plan-1',
    owner: 'me',
    projectId: 'orders',
    request: '여러 화면에 걸친 요청',
    modelId: 'claude',
    status: 'awaiting_approval',
    createdAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function note(overrides: Partial<TaskPlanNoteView> = {}): TaskPlanNoteView {
  return { kind: 'fact', body: '본문', refs: [], lane: 'lane-1', by: 'model', priority: 1, at: '2026-09-28T00:00:00.000Z', ...overrides };
}

function board(notes: TaskPlanNoteView[]) {
  return { notes, stats: { posts: notes.length, rejected: 0, reads: 0, bytesRead: 0, byKind: { contract: 0, failure: 0, fact: 0 } } };
}

function integration(): NonNullable<TaskPlanView['integration']> {
  return { status: 'queued', files: ['src/a.ts'], deleted: [] };
}

function overlaps(a: PlanGraphNode, b: PlanGraphNode): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('buildPlanGraph 좌표', () => {
  // 상한을 설정으로 올릴 수 있게 되면서(B_STUDIO_MAX_LANES·B_STUDIO_MAX_PLAN_TASKS) 배치가 최대치까지 버티는지 본다
  it('레인 1~8개·작업 레인당 1~16개까지 노드가 겹치지 않고 크기 안에 들어간다', () => {
    for (let laneCount = 1; laneCount <= 8; laneCount++) {
      for (let perLane = 1; perLane <= 16; perLane++) {
        const where = `${laneCount}레인 × ${perLane}작업`;
        const lanes = Array.from({ length: laneCount }, (_, index) =>
          lane(
            `lane-${index + 1}`,
            [`dir-${index + 1}`],
            Array.from({ length: perLane }, (_, taskIndex) => task(`t-${index + 1}-${taskIndex + 1}`, { paths: [`dir-${index + 1}`] })),
          ),
        );
        const graph = buildPlanGraph(plan({ lanes, integration: integration() }));

        const outside = graph.nodes
          .filter((node) => node.x < 0 || node.y < 0 || node.x + node.width > graph.width || node.y + node.height > graph.height)
          .map((node) => node.id);
        expect(outside, `${where}: 그림 밖으로 나간 노드`).toEqual([]);

        const collisions: string[] = [];
        for (let a = 0; a < graph.nodes.length; a++) {
          for (let b = a + 1; b < graph.nodes.length; b++) {
            if (overlaps(graph.nodes[a]!, graph.nodes[b]!)) collisions.push(`${graph.nodes[a]!.id} ↔ ${graph.nodes[b]!.id}`);
          }
        }
        expect(collisions, `${where}: 겹친 노드`).toEqual([]);

        expect(graph.laneCount, where).toBe(laneCount);
        expect(graph.maxTasks, where).toBe(perLane);
        // 레인 열 하나 + 통합 한 칸
        expect(graph.nodes.filter((node) => node.kind === 'lane'), where).toHaveLength(laneCount);
        expect(graph.nodes.find((node) => node.id === INTEGRATION_NODE_ID)!.x, where).toBeGreaterThan(
          graph.nodes.find((node) => node.id === laneNodeId(`lane-${laneCount}`))!.x,
        );
      }
    }
  });

  it('모든 간선은 있는 노드를 가리키고 스스로를 잇지 않는다', () => {
    const graph = buildPlanGraph(
      plan({
        lanes: [
          lane('lane-1', ['api'], [task('a1', { paths: ['api'] }), task('a2', { paths: ['api'], dependsOn: ['a1'] })]),
          lane('lane-2', ['web'], [task('b1', { paths: ['web'], dependsOn: ['a1'] })]),
        ],
        integration: integration(),
        coordination: { strategy: 'S3', topology: 'mesh' },
        board: board([note({ lane: 'lane-1' })]),
      }),
    );
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect(graph.edges.some((edge) => edge.kind === 'note')).toBe(true);
    for (const edge of graph.edges) {
      expect(ids.has(edge.from), `${edge.id} from`).toBe(true);
      expect(ids.has(edge.to), `${edge.id} to`).toBe(true);
      expect(edge.from, `${edge.id} 자기 자신`).not.toBe(edge.to);
      expect(edge.path.startsWith('M ')).toBe(true);
    }
  });

  it('작업이 없는 계획도 그릴 수 있다', () => {
    const graph = buildPlanGraph(plan({ lanes: [] }));
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.width).toBeGreaterThan(0);
    expect(graph.height).toBeGreaterThan(0);
  });
});

describe('의존 간선', () => {
  it('같은 레인이면 세로, 다른 레인이면 가로 곡선으로 잇는다', () => {
    const lanes = [
      lane('lane-1', ['api'], [task('a1', { paths: ['api'] }), task('a2', { paths: ['api'], dependsOn: ['a1'] })]),
      lane('lane-2', ['web'], [task('b1', { paths: ['web'], dependsOn: ['a1'] })]),
    ];
    const graph = buildPlanGraph(plan({ lanes }));

    const same = graph.edges.find((edge) => edge.kind === 'depends' && edge.from === taskNodeId('a1') && edge.to === taskNodeId('a2'));
    expect(same?.vertical).toBe(true);
    const a1 = graph.nodes.find((node) => node.id === taskNodeId('a1'))!;
    const a2 = graph.nodes.find((node) => node.id === taskNodeId('a2'))!;
    expect(same?.path).toBe(`M ${a1.x + NODE_WIDTH / 2} ${a1.y + NODE_HEIGHT} L ${a1.x + NODE_WIDTH / 2} ${a2.y}`);

    const cross = graph.edges.find((edge) => edge.kind === 'depends' && edge.from === taskNodeId('a1') && edge.to === taskNodeId('b1'));
    expect(cross?.vertical).toBe(false);
    expect(cross?.path.startsWith('M ')).toBe(true);
    expect(cross?.path).toContain(' C ');
  });

  it('없는 작업을 가리키는 의존은 간선을 만들지 않는다', () => {
    const graph = buildPlanGraph(plan({ lanes: [lane('lane-1', ['api'], [task('a1', { dependsOn: ['없는작업'] })])] }));
    expect(graph.edges.filter((edge) => edge.kind === 'depends')).toHaveLength(0);
  });
});

describe('통합 간선', () => {
  it('레인마다 마지막 작업에서 통합으로 하나씩 잇는다', () => {
    const lanes = [
      lane('lane-1', ['api'], [task('a1', { paths: ['api'] }), task('a2', { paths: ['api'] })]),
      lane('lane-2', ['web'], [task('b1', { paths: ['web'] })]),
    ];
    const graph = buildPlanGraph(plan({ lanes, integration: integration() }));

    const edges = graph.edges.filter((edge) => edge.kind === 'integration');
    expect(edges).toHaveLength(2);
    expect(edges.map((edge) => edge.from).sort()).toEqual([taskNodeId('a2'), taskNodeId('b1')].sort());
    expect(edges.every((edge) => edge.to === INTEGRATION_NODE_ID)).toBe(true);

    // 통합 단계가 아직 없으면 통합 노드도 간선도 없다
    expect(buildPlanGraph(plan({ lanes })).nodes.some((node) => node.id === INTEGRATION_NODE_ID)).toBe(false);
  });
});

describe('게시판 메모 간선', () => {
  const lanes = [
    lane('lane-1', ['api'], [task('a1', { paths: ['api'] })]),
    lane('lane-2', ['web'], [task('b1', { paths: ['web'] })]),
    lane('lane-3', ['db'], [task('c1', { paths: ['db'] })]),
  ];
  const withBoard = (topology: 'star' | 'hierarchical' | 'mesh', notes: TaskPlanNoteView[]) =>
    buildPlanGraph(plan({ lanes, integration: integration(), coordination: { strategy: 'S3', topology }, board: board(notes) }));

  it('mesh는 레인끼리 모두 잇는다', () => {
    const graph = withBoard('mesh', [note({ kind: 'fact', lane: 'lane-1' })]);
    const edges = graph.edges.filter((edge) => edge.kind === 'note');
    expect(edges.map((edge) => edge.to).sort()).toEqual([laneNodeId('lane-2'), laneNodeId('lane-3')].sort());
    expect(edges.every((edge) => edge.from === laneNodeId('lane-1') && edge.noteKind === 'fact')).toBe(true);
    // 쓴 메모/읽을 수 있는 메모 수
    expect(graph.nodes.find((node) => node.id === laneNodeId('lane-1'))!.noteWrote).toBe(1);
    expect(graph.nodes.find((node) => node.id === laneNodeId('lane-2'))!.noteRead).toBe(1);
    expect(graph.nodes.find((node) => node.id === INTEGRATION_NODE_ID)!.noteRead).toBe(1);
  });

  it('star는 레인끼리 직접 잇지 않고 허브(통합)를 거친다', () => {
    const graph = withBoard('star', [note({ kind: 'contract', lane: 'lane-1', refs: ['src/api.ts'] })]);
    const edges = graph.edges.filter((edge) => edge.kind === 'note');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: laneNodeId('lane-1'), to: INTEGRATION_NODE_ID, noteKind: 'contract' });
  });

  it('hierarchical은 같은 그룹(첫 쓰기 범위) 레인까지 잇고, 그룹이 다르면 허브를 거친다', () => {
    const sameGroup = [
      lane('lane-1', ['api'], [task('a1', { paths: ['api'] })]),
      lane('lane-2', ['api'], [task('b1', { paths: ['api'] })]),
    ];
    const direct = buildPlanGraph(
      plan({
        lanes: sameGroup,
        integration: integration(),
        coordination: { strategy: 'S3', topology: 'hierarchical' },
        board: board([note({ lane: 'lane-1' })]),
      }),
    );
    expect(direct.edges.filter((edge) => edge.kind === 'note').map((edge) => edge.to)).toEqual([laneNodeId('lane-2')]);

    const different = buildPlanGraph(
      plan({
        lanes,
        integration: integration(),
        coordination: { strategy: 'S3', topology: 'hierarchical' },
        board: board([note({ lane: 'lane-1' })]),
      }),
    );
    expect(different.edges.filter((edge) => edge.kind === 'note').map((edge) => edge.to)).toEqual([INTEGRATION_NODE_ID]);
  });

  it('검증기(플랫폼)가 쓴 메모는 어느 topology에서도 모든 레인이 읽는다', () => {
    for (const topology of ['star', 'hierarchical', 'mesh'] as const) {
      const graph = withBoard(topology, [note({ kind: 'failure', lane: 'lane-2', by: 'platform', priority: 3 })]);
      const edges = graph.edges.filter((edge) => edge.kind === 'note');
      expect(edges.map((edge) => edge.to).sort(), topology).toEqual([laneNodeId('lane-1'), laneNodeId('lane-3')].sort());
      expect(edges.every((edge) => edge.noteKind === 'failure')).toBe(true);
    }
  });

  it('허브가 쓴 메모는 통합 노드에서 모든 레인으로 간다', () => {
    const graph = withBoard('star', [note({ kind: 'contract', lane: 'plan', by: 'platform', refs: ['src/api.ts'] })]);
    const edges = graph.edges.filter((edge) => edge.kind === 'note');
    expect(edges.map((edge) => edge.to).sort()).toEqual([laneNodeId('lane-1'), laneNodeId('lane-2'), laneNodeId('lane-3')].sort());
    expect(edges.every((edge) => edge.from === INTEGRATION_NODE_ID)).toBe(true);
    expect(graph.nodes.find((node) => node.id === INTEGRATION_NODE_ID)!.noteWrote).toBe(1);
  });

  it('같은 짝·같은 종류의 메모 여러 개는 간선 하나로 묶고 수를 적는다', () => {
    const graph = withBoard('mesh', [note({ lane: 'lane-1' }), note({ lane: 'lane-1', body: '다른 본문', at: '2026-09-28T00:01:00.000Z' })]);
    const edges = graph.edges.filter((edge) => edge.kind === 'note' && edge.to === laneNodeId('lane-2'));
    expect(edges).toHaveLength(1);
    expect(edges[0]!.noteIndexes).toEqual([0, 1]);
    expect(edges[0]!.label).toBe('사실 2');
  });

  it('메모가 없으면 메모 간선도 배지도 없다', () => {
    const graph = withBoard('mesh', []);
    expect(graph.edges.filter((edge) => edge.kind === 'note')).toHaveLength(0);
    expect(graph.nodes.every((node) => node.noteWrote === 0 && node.noteRead === 0)).toBe(true);
  });

  it('조율이 꺼져 있으면(게시판 없음) 메모 간선이 없다', () => {
    const graph = buildPlanGraph(plan({ lanes, integration: integration() }));
    expect(graph.edges.filter((edge) => edge.kind === 'note')).toHaveLength(0);
  });
});

describe('상태 매핑', () => {
  it('단계 상태를 그대로 옮기고 색과 글자를 함께 준다', () => {
    const lanes = [
      lane('lane-1', ['api'], [task('a1', { paths: ['api'], status: 'done' }), task('a2', { paths: ['api'], status: 'skipped' })], { status: 'failed' }),
      lane('lane-2', ['web'], [task('b1', { paths: ['web'], status: 'running' })], { status: 'booting' }),
    ];
    const graph = buildPlanGraph(plan({ lanes, integration: { status: 'done', files: [], deleted: [] } }));
    const node = (id: string) => graph.nodes.find((candidate) => candidate.id === id)!;

    expect(node(laneNodeId('lane-1')).state).toBe('failed');
    expect(node(laneNodeId('lane-2')).state).toBe('booting');
    expect(node(taskNodeId('a1')).state).toBe('done');
    expect(node(taskNodeId('a2')).state).toBe('skipped');
    expect(node(taskNodeId('b1')).state).toBe('running');
    expect(node(INTEGRATION_NODE_ID).state).toBe('done');
    expect(STATE_TONE.done).toBe('pass');
    expect(STATE_TONE.failed).toBe('fail');
    expect(STATE_TONE.skipped).toBe('idle');
  });

  it('쓰기 범위 밖 파일을 바꾼 레인은 범위 위반으로 표시한다', () => {
    const lanes = [
      lane('lane-1', ['api'], [task('a1', { paths: ['api'], status: 'done' })], { status: 'done', changedFiles: ['api/src/Order.java', 'web/src/App.tsx'] }),
      lane('lane-2', ['web'], [task('b1', { paths: ['web'], status: 'done' })], { status: 'done', changedFiles: ['web/src/App.tsx'] }),
    ];
    const graph = buildPlanGraph(plan({ lanes, integration: integration() }));
    const laneNode = graph.nodes.find((candidate) => candidate.id === laneNodeId('lane-1'))!;
    expect(laneNode.state).toBe('violation');
    expect(laneNode.violation).toEqual(['web/src/App.tsx']);
    expect(graph.nodes.find((candidate) => candidate.id === laneNodeId('lane-2'))!.state).toBe('done');
  });
});

describe('shortLabel', () => {
  it('공백을 하나로 접고 길면 자른다', () => {
    expect(shortLabel('  주문   목록  ', 20)).toBe('주문 목록');
    expect(shortLabel('가'.repeat(30), 10)).toBe(`${'가'.repeat(10)}…`);
  });
});

describe('canLaneRead와 에이전트 canRead', () => {
  // 화면은 서버 전용 모듈을 번들에 넣지 않으려고 규칙을 따로 적었다. 두 규칙이 어긋나면 그래프가 조용히 틀리므로 모든 경우를 맞춰 본다.
  // 그룹은 서버의 laneGroup(첫 쓰기 범위)과 같게 둔다
  it('모든 topology·작성자·읽는 레인 조합에서 같은 답을 낸다', () => {
    const lanes = [lane('lane-1', ['api/'], []), lane('lane-2', ['web/'], []), lane('lane-3', ['api/'], [])];
    const hub = 'plan';
    const authors: Array<{ lane: string; by: 'model' | 'platform' }> = [
      ...lanes.map((candidate) => ({ lane: candidate.id, by: 'model' as const })),
      { lane: hub, by: 'model' },
      { lane: 'lane-1', by: 'platform' },
    ];
    for (const topology of ['star', 'hierarchical', 'mesh'] as Topology[]) {
      for (const author of authors) {
        const view = note({ lane: author.lane, by: author.by });
        const group = lanes.find((candidate) => candidate.id === author.lane)?.paths[0];
        const agentNote: Note = {
          id: 'n1',
          kind: view.kind,
          body: view.body,
          refs: view.refs,
          author: { lane: author.lane, by: author.by },
          ...(group !== undefined ? { group } : {}),
          priority: view.priority,
          at: view.at,
        };
        for (const reader of lanes) {
          const expected = canRead(topology, { lane: reader.id, group: reader.paths[0] }, agentNote, hub);
          expect(canLaneRead(topology, reader, view, lanes), `${topology} ${author.by}:${author.lane} → ${reader.id}`).toBe(expected);
        }
      }
    }
  });
});
