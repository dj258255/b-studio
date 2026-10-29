/**
 * #820 마지막 항목: 규칙표로 Claude Code와 Codex에 요청을 나눠 보내고, 실행 기록(AI·모델·작업 종류·게이트 결과)이 쌓이는지 본다.
 * 실제 Docker와 실제 로그인한 두 CLI가 필요하다. examples/orders를 임시 폴더로 복사해 쓰고, 끝나면 세션을 내리고 지운다.
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PROJECT = 'orders';
const REQUESTS = [
  { request: 'api의 GET /api/ping 응답 JSON에 version 필드(문자열 "1")를 더하고, 그 응답을 확인하는 테스트를 하나 더해 줘.', expect: 'codex' },
  { request: 'web 홈 화면(/)의 맨 위 제목 바로 아래에 "주문 예제" 문구를 한 줄 더해 줘.', expect: 'claude-code' },
];

async function main(): Promise<void> {
  await mkdir(path.join(homedir(), '.cache/b-studio'), { recursive: true });
  const root = await mkdtemp(path.join(homedir(), '.cache/b-studio/', 'routing-two-ai-'));
  const out: Record<string, unknown> = { startedAt: new Date().toISOString(), sessions: [] };
  const ids: string[] = [];
  try {
    const projects = path.join(root, 'projects');
    await cp(path.resolve(import.meta.dirname, '../../../../examples/orders'), path.join(projects, PROJECT), {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/.test(source),
    });
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    const rulesFile = path.join(root, 'backend-rules.json');
    await writeFile(rulesFile, JSON.stringify({ rules: [{ when: { keywords: ['api의'] }, backend: 'codex' }], fallback: { backend: 'claude-code', model: 'sonnet' } }));
    Object.assign(process.env, {
      B_STUDIO_MODE: 'claude-code',
      B_STUDIO_BACKENDS: 'codex',
      B_STUDIO_AUTH: 'none',
      B_STUDIO_PROJECTS_DIR: projects,
      B_STUDIO_SESSIONS_DIR: path.join(root, 'sessions'),
      B_STUDIO_BACKEND_RULES_FILE: rulesFile,
      B_STUDIO_MODEL_OBSERVATIONS_FILE: path.join(root, 'model-observations.json'),
      B_STUDIO_TASK_PLANS_DIR: path.join(root, 'task-plans'),
      B_STUDIO_USAGE_DIR: path.join(root, 'usage'),
    });
    const sessions = await import('../../../../apps/studio/lib/server/sessions');
    const { startRoutedSession } = await import('../../../../apps/studio/lib/server/routed-session');
    const { routingStats } = await import('../../../../apps/studio/lib/server/routing-stats');
    const { LOCAL_USER } = await import('../../../../apps/studio/lib/server/auth');

    // 메모리를 아끼려고 하나씩: 보내고, 끝나기를 기다리고, 내린다
    for (const item of REQUESTS) {
      const started = Date.now();
      const routed = await startRoutedSession({ projectId: PROJECT, user: LOCAL_USER, workspace: 'copy', request: item.request, intent: 'build' });
      ids.push(routed.session.id);
      log(`▶ ${routed.routing.backend} (기대 ${item.expect}) · ${`규칙 ${routed.routing.rule}: ${routed.routing.matched} · 종류 ${JSON.stringify(routed.routing.kind)}`} · ${routed.session.id}${routed.sendError ? ` · 보내기 실패: ${routed.sendError}` : ''}`);
      await waitFor(() => {
        const snap = sessions.getSnapshot(routed.session.id);
        return !!snap && !snap.running && ['ready', 'failed', 'stopped', 'idle'].includes(snap.status) && Date.now() - started > 20_000;
      }, 40 * 60_000);
      const snap = sessions.getSnapshot(routed.session.id)!;
      (out.sessions as unknown[]).push({ backend: routed.routing.backend, expect: item.expect, rule: routed.routing.rule, matched: routed.routing.matched, kind: routed.routing.kind, model: routed.routing.model, status: snap.status, checkpoints: snap.checkpoints.length, seconds: Math.round((Date.now() - started) / 1000) });
      log(`  끝: ${snap.status}, 체크포인트 ${snap.checkpoints.length}, ${Math.round((Date.now() - started) / 1000)}초`);
      await sessions.stopSession(routed.session.id).catch(() => {});
    }
    out.stats = await routingStats({ projectId: PROJECT });
  } finally {
    const { stopSession } = await import('../../../../apps/studio/lib/server/sessions').catch(() => ({ stopSession: async (_: string) => {} }));
    for (const id of ids) await stopSession(id).catch(() => {});
    console.log(`RESULT ${JSON.stringify(out)}`);
    await rm(root, { recursive: true, force: true });
    const left = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout.split('\n').filter((name) => name.startsWith(`studio-${PROJECT}-`));
    log(`남은 컨테이너 ${left.length}개`);
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('시간 안에 끝나지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

function log(message: string): void {
  console.log(message);
}

main().then(() => process.exit(process.exitCode ?? 0), (error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
