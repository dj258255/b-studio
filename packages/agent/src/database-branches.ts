import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
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
        const folder = path.join(this.#dir, service);
        await mkdir(folder, { recursive: true });
        // 죽은 프로세스가 남긴 임시 덤프를 먼저 치운다. 덤프는 커서 쌓이면 디스크를 먹는다
        await sweepStaleTemp(folder);
        const file = this.#file(service, sha);
        const temp = this.#tempFile(service, sha, 'save');
        const dump = await this.#dumpToFile(service, database, temp, signal);
        if (dump) return { service, action: 'failed', detail: dump.error };
        await rename(temp, file);
        return { service, action: 'saved', elapsedMs: Date.now() - started };
      }),
    );
  }

  /** 체크포인트 이후 데이터베이스가 바뀌었는지. 파일은 그대로인데 데이터만 바꾼 요청을 알아보는 데 쓴다 */
  async changedSince(sha: string, signal?: AbortSignal): Promise<boolean> {
    for (const [service, database] of this.#databases) {
      const saved = this.#file(service, sha);
      if (!(await exists(saved))) continue;
      const current = this.#tempFile(service, sha, 'changed');
      const dumped = await this.#dumpToFile(service, database, current, signal);
      if (dumped) continue;
      try {
        if ((await normalizedDumpHash(saved)) !== (await normalizedDumpHash(current))) return true;
      } finally {
        await rm(current, { force: true });
      }
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
        const saved = this.#file(service, sha);
        if (!(await exists(saved))) return { service, action: 'missing', detail: '이 체크포인트의 데이터베이스 상태가 저장되지 않았습니다' };

        const current = this.#tempFile(service, sha, 'restore');
        const dumped = await this.#dumpToFile(service, database, current, signal);
        try {
          if (!dumped && (await normalizedDumpHash(current)) === (await normalizedDumpHash(saved))) {
            return { service, action: 'unchanged', elapsedMs: Date.now() - started };
          }
        } finally {
          await rm(current, { force: true });
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

        const load = await this.#sandbox.execFromFile(
          service,
          ['psql', '-U', database.user, '-d', database.database, '-v', 'ON_ERROR_STOP=1', '-q'],
          saved,
          { signal, raw: true },
        );
        if (load.exitCode !== 0) return { service, action: 'failed', detail: firstLines(load.stderr) };
        return { service, action: 'restored', elapsedMs: Date.now() - started };
      }),
    );

    const restored = new Set(states.filter((state) => state.action === 'restored' || state.action === 'failed').map((state) => state.service));
    const dependents = this.#databases.filter(([service]) => restored.has(service)).flatMap(([, database]) => database.dependents);
    return { states, dependents: [...new Set(dependents)] };
  }

  async #dumpToFile(service: string, database: Database, file: string, signal?: AbortSignal): Promise<{ error: string } | undefined> {
    const result = await this.#sandbox.execToFile(
      service,
      ['pg_dump', '-U', database.user, '-d', database.database, '--no-owner', '--no-privileges'],
      // 덤프는 파일로만 옮기고 보여 주지 않는다. 가리면 복원할 데이터가 바뀐다
      file,
      { signal, raw: true },
    );
    if (result.exitCode === 0) return undefined;
    await rm(file, { force: true });
    return { error: firstLines(result.stderr) || `pg_dump exit ${result.exitCode}` };
  }

  #file(service: string, sha: string): string {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`체크포인트 ID 형식이 올바르지 않습니다: ${sha}`);
    return path.join(this.#dir, service, `${sha}.sql`);
  }

  #tempFile(service: string, sha: string, reason: string): string {
    return path.join(this.#dir, service, `${sha}.${reason}.${process.pid}.${Date.now()}.tmp`);
  }
}

/**
 * 최신 pg_dump는 덤프마다 무작위 키로 `\restrict`, `\unrestrict` 줄을 넣는다.
 * 내용이 같은지 비교할 때는 이 줄을 뺀다. 규칙이 갈라지지 않게 한 곳에만 둔다
 */
const RESTRICT_LINE = /^\\(un)?restrict\s/;

/** 덤프는 크기가 커서 문자열로 올리지 않고, 줄 단위로 읽어 해시만 비교한다 */
export async function normalizedDumpHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (RESTRICT_LINE.test(line)) continue;
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
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

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/**
 * 덤프 중에 프로세스가 죽으면 임시 파일이 남는다. 이름에 만든 프로세스의 pid가 들어 있으므로,
 * 그 프로세스가 이미 없는 파일만 지운다. 지금 돌고 있는 덤프의 임시 파일은 건드리지 않는다.
 */
async function sweepStaleTemp(folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => name.endsWith('.tmp') && !isRunning(tempPid(name))).map((name) => rm(path.join(folder, name), { force: true })));
}

/** `<체크포인트>.<이유>.<pid>.<시각>.tmp` */
function tempPid(name: string): number | undefined {
  const pid = Number(name.split('.').at(-3));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isRunning(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM은 남의 프로세스여서 신호를 못 보낸 것이므로 살아 있다고 본다
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
