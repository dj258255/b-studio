/**
 * 같은 프로젝트로 두 세션을 동시에 띄우는 회귀 확인. 트러블슈팅 36번(같은 프로젝트 두 세션 동시 기동 시
 * Gradle 캐시 잠금)이 다시 나지 않는지 본다.
 *
 *  - examples/orders를 임시 폴더로 복사해 두 세션을 동시에 만든다
 *  - 둘 다 api·web이 ready가 되는지, 서로 다른 작업 복사본을 쓰는지 확인한다
 *  - 샌드박스마다 자기 Gradle 홈을 써서 api 컨테이너 두 개가 동시에 뜨는지(잠금 충돌 없음) 확인한다
 *  - 끝나면 두 세션을 내리고 남은 컨테이너가 없는지 확인한다
 *
 * 실제 Docker가 필요하다. 개발 서버 없이 한 번 돌린다:
 *
 *   pnpm e2e:two-sessions
 *
 * 메모리가 6GiB인 VM에서는 두 샌드박스를 동시에 띄우면 가용 메모리가 크게 줄어든다(트러블슈팅 36번 참고).
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PROJECT = 'orders';
const CONTAINER_PREFIX = `studio-${PROJECT}-`;

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(homedir(), '.cache/b-studio/', 'two-sessions-e2e-'));
  const failures: string[] = [];
  const check = (ok: boolean, label: string) => {
    log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures.push(label);
  };
  let sessionIds: string[] = [];

  try {
    const projects = path.join(root, 'projects');
    await cp(path.resolve(import.meta.dirname, '../../../examples/orders'), path.join(projects, PROJECT), {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/.test(source),
    });
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    Object.assign(process.env, {
      B_STUDIO_MODE: 'api',
      B_STUDIO_AUTH: 'none',
      B_STUDIO_PROJECTS_DIR: projects,
      B_STUDIO_SESSIONS_DIR: path.join(root, 'sessions'),
      B_STUDIO_MODEL_OBSERVATIONS_FILE: path.join(root, 'model-observations.json'),
    });

    const sessions = await import('../lib/server/sessions');
    const { LOCAL_USER } = await import('../lib/server/auth');

    const started = Date.now();
    log('▶ 같은 프로젝트로 세션 두 개를 동시에 만든다');
    const [first, second] = await Promise.all([
      sessions.createSession(PROJECT, LOCAL_USER, 'copy', {}),
      sessions.createSession(PROJECT, LOCAL_USER, 'copy', {}),
    ]);
    sessionIds = [first.id, second.id];
    check(first.id !== second.id, `서로 다른 세션 id (${first.id}, ${second.id})`);
    check(first.workDir !== second.workDir, '서로 다른 작업 복사본');

    // 두 샌드박스가 동시에 기동한다. 첫 기동은 Gradle 배포판·의존성을 받느라 오래 걸린다
    await waitFor(
      () => sessionIds.every((id) => ['ready', 'failed', 'stopped'].includes(sessions.getSnapshot(id)?.status ?? '')),
      20 * 60_000,
      '두 세션이 20분 안에 준비되지 않았습니다',
    );

    log('\n▶ 두 세션의 서비스 상태');
    for (const [index, id] of sessionIds.entries()) {
      const snapshot = sessions.getSnapshot(id)!;
      const api = snapshot.services.find((service) => service.name === 'api');
      const web = snapshot.services.find((service) => service.name === 'web');
      check(snapshot.status === 'ready', `세션 ${index + 1}(${id}) 준비됨 (실제: ${snapshot.status}${snapshot.error ? ` · ${snapshot.error}` : ''})`);
      check(api?.state === 'ready', `세션 ${index + 1} api 컨테이너 running (실제: ${api?.state ?? '없음'}${api?.detail ? ` · ${api.detail}` : ''})`);
      check(web?.state === 'ready', `세션 ${index + 1} web 컨테이너 ready (실제: ${web?.state ?? '없음'})`);
    }

    // 샌드박스마다 API 컨테이너가 하나씩 떠 있어야 한다(트러블슈팅 36번은 두 번째 api가 캐시 잠금으로 죽었다)
    const apiContainers = runningContainers(CONTAINER_PREFIX).filter((name) => name.includes('-api-'));
    check(apiContainers.length === 2, `api 컨테이너 두 개 동시 실행 (${apiContainers.join(', ') || '없음'})`);
    log(`\n두 세션 준비까지 ${((Date.now() - started) / 1_000).toFixed(1)}초`);

    log('\n▶ 정리');
    for (const id of sessionIds) await sessions.stopSession(id).catch(() => {});
    sessionIds = [];
    await waitFor(() => runningContainers(CONTAINER_PREFIX).length === 0, 60_000, '세션을 내린 뒤에도 남은 컨테이너가 있습니다');
    check(runningContainers(CONTAINER_PREFIX).length === 0, '남은 컨테이너 0개');
  } finally {
    if (sessionIds.length > 0) {
      const { stopSession } = await import('../lib/server/sessions').catch(() => ({ stopSession: async () => {} }));
      for (const id of sessionIds) await stopSession(id).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    log(`\n❌ ${failures.length}개 실패`);
    process.exitCode = 1;
  } else {
    log('\n✅ 두 세션 동시 기동 확인 통과');
  }
}

function runningContainers(prefix: string): string[] {
  const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (ps.status !== 0) return [];
  return ps.stdout.split('\n').map((line) => line.trim()).filter((name) => name.startsWith(prefix));
}

async function waitFor(condition: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function log(message: string): void {
  console.log(message);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
