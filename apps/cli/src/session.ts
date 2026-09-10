import { styleText } from 'node:util';
import { LocalDockerProvider, type Sandbox, type ServiceEndpoint } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { createLabeler, describe, once, pipeLogs, print, printEndpoints, reportStatus, type Label } from './ui';

export interface SessionContext {
  sandbox: Sandbox;
  endpoints: ServiceEndpoint[];
  /** Ctrl+C 등으로 중단되면 abort된다 */
  signal: AbortSignal;
  label: Label;
}

export interface SessionOptions {
  /** 끝나거나 실패해도 컨테이너를 남긴다 (디버깅용) */
  keep: boolean;
  /** 서비스 로그를 계속 출력할지 */
  followLogs: boolean;
}

/**
 * 샌드박스를 띄우고 본문을 실행한 뒤 정리한다. `up`과 `agent`가 같은 수명 주기를 공유한다.
 * 반환값은 프로세스 종료 코드다.
 */
export async function runSandboxSession(
  project: LoadedProject,
  { keep, followLogs }: SessionOptions,
  body: (context: SessionContext) => Promise<number>,
): Promise<number> {
  const sandbox = await new LocalDockerProvider().create(project);
  const label = createLabeler(project);
  const stop = new AbortController();

  const cleanup = once(async () => {
    stop.abort();
    print(label('studio'), `샌드박스를 정리합니다 (${sandbox.id})`);
    await sandbox.destroy().catch((error: unknown) => print(label('studio'), `정리 실패: ${describe(error)}`));
  });
  const leave = () => {
    stop.abort();
    print(label('studio'), `컨테이너를 남겨 둡니다. 정리: docker compose -p ${sandbox.id} down -v`);
  };

  // 터미널의 Ctrl+C는 pnpm, tsx, node에 동시에 전달돼 신호가 여러 번 올 수 있다.
  // once로 등록하면 두 번째 신호에서 기본 동작(즉시 종료)이 실행돼 정리가 중간에 끊긴다
  const onSignal = () => void cleanup();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // 컨테이너가 생긴 뒤에야 logs --follow가 붙을 수 있다
  const startLogs = once(async () => {
    if (followLogs) await pipeLogs(sandbox, stop.signal, label);
  });

  print(label('studio'), `${project.spec.name} 샌드박스를 시작합니다 (${sandbox.id})`);
  let code: number;
  try {
    const endpoints = await sandbox.start({ signal: stop.signal, onStatus: reportStatus(label, () => void startLogs()) });
    printEndpoints(project, endpoints);
    code = await body({ sandbox, endpoints, signal: stop.signal, label });
  } catch (error) {
    if (stop.signal.aborted) {
      await cleanup();
      return 130;
    }
    print(label('studio'), styleText('red', `실패: ${describe(error)}`));
    code = 1;
  }

  if (keep && !stop.signal.aborted) leave();
  else await cleanup();
  return code;
}
