/**
 * 여러 에이전트·검증 작업을 의존성 그래프로 실행하는 작은 오케스트레이터.
 * 작업의 실제 실행(에이전트, 테스트, 브라우저 검사)은 호출자가 주입하므로
 * DBTower·Slack·특정 큐에 종속되지 않는다.
 */
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface TaskNode<T = unknown> {
  id: string;
  dependsOn?: readonly string[];
  maxAttempts?: number;
  run: (context: { attempt: number; signal: AbortSignal }) => Promise<T>;
}

export interface TaskResult<T = unknown> {
  id: string;
  status: Exclude<TaskStatus, 'queued' | 'running'>;
  attempts: number;
  value?: T;
  error?: string;
}

export interface TaskGraphOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onEvent?: (event: TaskEvent) => void;
}

export type TaskEvent =
  | { type: 'task_started'; id: string; attempt: number }
  | { type: 'task_succeeded'; id: string; attempts: number }
  | { type: 'task_failed'; id: string; attempts: number; error: string; retrying: boolean }
  | { type: 'task_skipped'; id: string; reason: string };

export class TaskGraphError extends Error {}

/** 의존성이 준비된 작업을 최대 concurrency개까지 병렬 실행한다. */
export async function runTaskGraph<T = unknown>(nodes: readonly TaskNode<T>[], options: TaskGraphOptions = {}): Promise<TaskResult<T>[]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new TaskGraphError('task id가 중복됩니다');
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (!byId.has(dependency)) throw new TaskGraphError(`${node.id}: 없는 의존성 '${dependency}'`);
    }
  }
  assertAcyclic(nodes);

  const limit = Math.max(1, Math.floor(options.concurrency ?? 2));
  const results = new Map<string, TaskResult<T>>();
  const running = new Map<string, Promise<void>>();
  const signal = options.signal ?? new AbortController().signal;
  const emit = options.onEvent ?? (() => {});

  while (results.size < nodes.length) {
    signal.throwIfAborted();
    // 실패한 의존성을 가진 작업은 실행하지 않고 명시적으로 남긴다.
    for (const node of nodes) {
      if (results.has(node.id) || running.has(node.id)) continue;
      const dependencies = node.dependsOn ?? [];
      const dependencyResults = dependencies.map((id) => results.get(id));
      if (dependencyResults.some((result) => result?.status === 'failed' || result?.status === 'skipped')) {
        const result = { id: node.id, status: 'skipped' as const, attempts: 0, error: '의존 작업이 실패해 건너뛰었습니다' };
        results.set(node.id, result);
        emit({ type: 'task_skipped', id: node.id, reason: result.error });
      }
    }

    for (const node of nodes) {
      if (running.size >= limit || results.has(node.id) || running.has(node.id)) continue;
      const dependencies = node.dependsOn ?? [];
      if (!dependencies.every((id) => results.get(id)?.status === 'succeeded')) continue;
      const job = executeNode(node, signal, emit).then((result) => {
        results.set(node.id, result);
        running.delete(node.id);
      });
      running.set(node.id, job);
    }

    if (running.size === 0) {
      if (results.size === nodes.length) break;
      throw new TaskGraphError('실행 가능한 작업이 없습니다');
    }
    await Promise.race(running.values());
  }

  return nodes.map((node) => results.get(node.id)!);
}

async function executeNode<T>(node: TaskNode<T>, signal: AbortSignal, emit: (event: TaskEvent) => void): Promise<TaskResult<T>> {
  const maxAttempts = Math.max(1, Math.floor(node.maxAttempts ?? 1));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal.throwIfAborted();
    emit({ type: 'task_started', id: node.id, attempt });
    try {
      const value = await node.run({ attempt, signal });
      emit({ type: 'task_succeeded', id: node.id, attempts: attempt });
      return { id: node.id, status: 'succeeded', attempts: attempt, value };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retrying = attempt < maxAttempts;
      emit({ type: 'task_failed', id: node.id, attempts: attempt, error: message, retrying });
      if (!retrying) return { id: node.id, status: 'failed', attempts: attempt, error: message };
    }
  }
  throw new TaskGraphError(`${node.id}: 실행 결과가 없습니다`);
}

function assertAcyclic<T>(nodes: readonly TaskNode<T>[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new TaskGraphError(`순환 의존성이 있습니다: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}
