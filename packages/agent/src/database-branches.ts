import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';

export type DatabaseAction = 'saved' | 'restored' | 'unchanged' | 'missing' | 'failed';

export interface DatabaseState {
  /** compose 서비스 이름 */
  service: string;
  action: DatabaseAction;
  detail?: string;
  elapsedMs?: number;
}

type Database = LoadedProject['databases'][number][1];

/**
 * 체크포인트마다 개발용 데이터베이스 상태를 덤프로 남기고, 파일을 되돌릴 때 같은 시점으로 되돌린다.
 * 파일만 되돌리면 "DB에는 적용됐지만 코드에는 없는 마이그레이션"이 남아 서비스가 기동하지 못한다.
 *
 * 덤프는 작업 복사본의 .git 아래에 둔다. 에이전트 도구는 .git에 접근할 수 없고, 커밋에도 들어가지 않는다.
 */
export class DatabaseBranches {
  readonly #sandbox: Sandbox;
  readonly #databases: ReadonlyArray<[string, Database]>;
  readonly #dir: string;

  constructor(sandbox: Sandbox, project: LoadedProject, dir: string) {
    this.#sandbox = sandbox;
    this.#databases = project.databases ?? [];
    this.#dir = dir;
  }

  get enabled(): boolean {
    return this.#databases.length > 0;
  }

  /** 지금 상태를 체크포인트에 묶어 저장한다 */
  async save(sha: string, signal?: AbortSignal): Promise<DatabaseState[]> {
    return Promise.all(
      this.#databases.map(async ([service, database]): Promise<DatabaseState> => {
        const started = Date.now();
        const dump = await this.#dump(service, database, signal);
        if ('error' in dump) return { service, action: 'failed', detail: dump.error };
        await mkdir(path.join(this.#dir, service), { recursive: true });
        await writeFile(this.#file(service, sha), dump.sql);
        return { service, action: 'saved', elapsedMs: Date.now() - started };
      }),
    );
  }

  /** 체크포인트 이후 데이터베이스가 바뀌었는지. 파일은 그대로인데 데이터만 바꾼 요청을 알아보는 데 쓴다 */
  async changedSince(sha: string, signal?: AbortSignal): Promise<boolean> {
    for (const [service, database] of this.#databases) {
      const saved = await readFile(this.#file(service, sha), 'utf8').catch(() => undefined);
      const current = await this.#dump(service, database, signal);
      if (saved === undefined || 'error' in current) continue;
      if (normalizeDump(saved) !== normalizeDump(current.sql)) return true;
    }
    return false;
  }

  /**
   * 체크포인트 시점으로 되돌린다. 지금 상태가 이미 같으면 건드리지 않는다.
   * 되돌린 데이터베이스에 기대는 서비스는 커넥션을 다시 맺도록 재시작해야 한다.
   */
  async restore(sha: string, signal?: AbortSignal): Promise<{ states: DatabaseState[]; dependents: string[] }> {
    const states = await Promise.all(
      this.#databases.map(async ([service, database]): Promise<DatabaseState> => {
        const started = Date.now();
        const saved = await readFile(this.#file(service, sha), 'utf8').catch(() => undefined);
        if (saved === undefined) return { service, action: 'missing', detail: '이 체크포인트의 데이터베이스 상태가 저장되지 않았습니다' };

        const current = await this.#dump(service, database, signal);
        if (!('error' in current) && normalizeDump(current.sql) === normalizeDump(saved)) {
          return { service, action: 'unchanged', elapsedMs: Date.now() - started };
        }

        // DROP DATABASE는 트랜잭션 안에서 실행할 수 없으므로 명령을 나눠 보낸다. WITH (FORCE)가 남은 커넥션을 끊는다
        const recreate = await this.#sandbox.exec(
          service,
          [
            'psql', '-U', database.user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q',
            '-c', `DROP DATABASE IF EXISTS "${database.database}" WITH (FORCE)`,
            '-c', `CREATE DATABASE "${database.database}" OWNER "${database.user}"`,
          ],
          { signal },
        );
        if (recreate.exitCode !== 0) return { service, action: 'failed', detail: firstLines(recreate.stderr) };

        const load = await this.#sandbox.exec(
          service,
          ['psql', '-U', database.user, '-d', database.database, '-v', 'ON_ERROR_STOP=1', '-q'],
          { signal, input: saved },
        );
        if (load.exitCode !== 0) return { service, action: 'failed', detail: firstLines(load.stderr) };
        return { service, action: 'restored', elapsedMs: Date.now() - started };
      }),
    );

    const restored = new Set(states.filter((state) => state.action === 'restored' || state.action === 'failed').map((state) => state.service));
    const dependents = this.#databases.filter(([service]) => restored.has(service)).flatMap(([, database]) => database.dependents);
    return { states, dependents: [...new Set(dependents)] };
  }

  async #dump(service: string, database: Database, signal?: AbortSignal): Promise<{ sql: string } | { error: string }> {
    const result = await this.#sandbox.exec(
      service,
      ['pg_dump', '-U', database.user, '-d', database.database, '--no-owner', '--no-privileges'],
      { signal },
    );
    return result.exitCode === 0 ? { sql: result.stdout } : { error: firstLines(result.stderr) || `pg_dump exit ${result.exitCode}` };
  }

  #file(service: string, sha: string): string {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`체크포인트 ID 형식이 올바르지 않습니다: ${sha}`);
    return path.join(this.#dir, service, `${sha}.sql`);
  }
}

/**
 * 최신 pg_dump는 덤프마다 무작위 키로 `\restrict`, `\unrestrict` 줄을 넣는다.
 * 내용이 같은지 비교할 때는 이 줄을 뺀다.
 */
export function normalizeDump(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\\(un)?restrict\s/.test(line))
    .join('\n');
}

export function describeDatabaseState(state: DatabaseState): string {
  switch (state.action) {
    case 'saved':
      return `${state.service} 상태를 저장했습니다`;
    case 'restored':
      return `${state.service} 스키마와 데이터를 되돌렸습니다`;
    case 'unchanged':
      return `${state.service}는 바뀌지 않았습니다`;
    case 'missing':
      return `${state.service}는 저장된 상태가 없어 되돌리지 못했습니다`;
    case 'failed':
      return `${state.service} 처리에 실패했습니다: ${state.detail ?? ''}`;
  }
}

function firstLines(text: string): string {
  return text.trim().split('\n').slice(0, 5).join('\n');
}
