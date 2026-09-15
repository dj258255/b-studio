/**
 * 워크플로 배포 조건의 실제 경로를 외부 과금 없이 검증한다.
 *
 *  1. 세션 시작 체크포인트(검증 기록 없음)를 배포 API로 배포하면 409로 거부된다
 *  2. 모델이 스크립트 예외가 나는 화면을 만들면 실제 컨테이너의 헤드리스 브라우저 확인이 실패시킨다
 *  3. 고친 뒤 게이트를 통과한 체크포인트에는 Workflow-Passed 트레일러가 남는다
 *  4. 그 체크포인트는 같은 배포 API로 받아들여지고 실제 운영 릴리스까지 끝난다
 *
 * 예제를 다른 이름(deploygate)으로 복사하고 배포 폴더도 따로 둬서, 이 PC에 있는 orders 배포와 이름·상태가 섞이지 않게 한다.
 *
 *   pnpm e2e:deploy-gate
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

const PROJECT = 'deploygate';
const PROBE_FILE = 'web/app/gate-probe/page.tsx';
const BROKEN_PAGE = `'use client';\nimport { useEffect } from 'react';\n\nexport default function GateProbe() {\n  useEffect(() => {\n    throw new Error('gate probe broken');\n  }, []);\n  return <p>게이트 확인 화면</p>;\n}\n`;
const FIXED_PAGE = `export default function GateProbe() {\n  return <p>게이트 확인 화면</p>;\n}\n`;
const GATE_FEEDBACK = '[b-studio 검증 게이트]';

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(homedir(), '.cache/b-studio/', 'deploy-gate-e2e-'));
  const provider = await fakeProvider();
  let sessionId: string | undefined;
  let deployedProjectRoot: string | undefined;
  const failures: string[] = [];
  const check = (ok: boolean, label: string) => {
    log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures.push(label);
  };

  try {
    const projects = path.join(root, 'projects');
    await cp(path.resolve(import.meta.dirname, '../../../examples/orders'), path.join(projects, PROJECT), {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/.test(source),
    });
    const specFile = path.join(projects, PROJECT, 'studio.yaml');
    const spec = (await readFile(specFile, 'utf8')).replace(/^name: orders$/m, `name: ${PROJECT}`).replace(
      /^  pageChecks:\n/m,
      '  pageChecks:\n    - { service: web, path: /gate-probe, mode: browser, expectText: 게이트 확인 화면 }\n',
    );
    if (!spec.includes(`name: ${PROJECT}`) || !spec.includes('/gate-probe')) throw new Error('예제 studio.yaml을 e2e용으로 바꾸지 못했습니다');
    await writeFile(specFile, spec);

    const registryFile = path.join(root, 'models.json');
    await writeFile(
      registryFile,
      JSON.stringify([
        {
          id: 'local-gate',
          provider: 'openai',
          model: 'gate-probe',
          label: 'Local gate probe',
          capabilities: ['tools', 'json'],
          contextWindow: 32_000,
          pricing: { inputPerMillion: 1, outputPerMillion: 2 },
          baselineQuality: 0.8,
          baselineLatencyMs: 100,
          baseUrl: provider.baseUrl,
        },
      ]),
      { mode: 0o600 },
    );
    await mkdir(path.join(root, 'sessions'), { recursive: true });

    Object.assign(process.env, {
      B_STUDIO_MODE: 'api',
      B_STUDIO_AUTH: 'none',
      B_STUDIO_MODEL_REGISTRY: registryFile,
      B_STUDIO_PROJECTS_DIR: projects,
      B_STUDIO_SESSIONS_DIR: path.join(root, 'sessions'),
      B_STUDIO_DEPLOYS_DIR: path.join(root, 'deploys'),
      B_STUDIO_MODEL_OBSERVATIONS_FILE: path.join(root, 'model-observations.json'),
    });

    const sessions = await import('../lib/server/sessions');
    const route = await import('../app/api/sessions/[id]/deploys/route');
    const { LOCAL_USER } = await import('../lib/server/auth');

    const started = Date.now();
    const created = await sessions.createSession(PROJECT, LOCAL_USER, 'copy', { modelId: 'local-gate' });
    sessionId = created.id;
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    sessions.subscribe(sessionId, (event) => events.push(event as never));
    await waitFor(() => sessions.getSnapshot(sessionId!)?.status === 'ready', 15 * 60_000, '샌드박스가 준비되지 않았습니다');
    log(`세션 ${sessionId} 준비 (${seconds(started)})`);

    const deploy = async (sha: string) => {
      const response = await route.POST(
        new Request(`http://studio.local/api/sessions/${sessionId}/deploys`, { method: 'POST', body: JSON.stringify({ sha }) }),
        { params: Promise.resolve({ id: sessionId! }) } as never,
      );
      return { status: response.status, body: (await response.json()) as { error?: string; started?: boolean } };
    };

    log('\n▶ 1. 검증 기록이 없는 세션 시작 체크포인트 배포');
    const start = sessions.getSnapshot(sessionId)!.checkpoints[0]!;
    const refused = await deploy(start.sha);
    check(start.passedStages === undefined, `세션 시작 체크포인트에는 통과 기록이 없음 (${start.shortSha})`);
    check(refused.status === 409, `배포 API가 409로 거부 (실제: ${refused.status})`);
    check(refused.body.error?.includes('contract_check, test, review') ?? false, `거부 사유에 빠진 단계 표시 (${refused.body.error})`);
    check(sessions.getSnapshot(sessionId)!.deploying === undefined, '거부된 요청은 배포 작업을 시작하지 않음');

    log('\n▶ 2~3. 깨진 화면 → 브라우저 확인 실패 → 수정 → 통과');
    const runStarted = Date.now();
    sessions.sendMessage(sessionId, '게이트 확인용 화면을 /gate-probe에 추가해줘', { allowBreaking: false, by: LOCAL_USER });
    await waitFor(() => sessions.getSnapshot(sessionId!)?.running === false, 15 * 60_000, '요청이 끝나지 않았습니다');
    const pageChecks = events.flatMap((event) =>
      event.type === 'agent' && (event.event as { type?: string })?.type === 'workflow_check' ? [(event.event as { check: { name: string; ok: boolean; detail?: string } }).check] : [],
    ).filter((item) => item.name.startsWith('web /gate-probe'));
    check(pageChecks.length === 2, `gate-probe 화면 확인 2회 실행 (실제: ${pageChecks.length})`);
    check(pageChecks[0]?.ok === false && /스크립트 예외|console\.error/.test(pageChecks[0]?.detail ?? ''), `첫 확인은 실제 브라우저에서 스크립트 예외로 실패 (${pageChecks[0]?.detail?.split('\n')[0]})`);
    check(pageChecks[1]?.ok === true, '고친 뒤 두 번째 확인은 통과');
    const verified = sessions.getSnapshot(sessionId)!.checkpoints[0]!;
    check(verified.sha !== start.sha && verified.files.includes(PROBE_FILE), `새 체크포인트에 ${PROBE_FILE} 포함 (${verified.shortSha})`);
    check(
      ['run', 'contract_check', 'browser_check', 'test', 'review'].every((stage) => verified.passedStages?.includes(stage as never)),
      `체크포인트 트레일러에 통과 단계 기록 (${verified.passedStages?.join(', ')}) · ${seconds(runStarted)}`,
    );

    log('\n▶ 4. 검증된 체크포인트 배포');
    const accepted = await deploy(verified.sha);
    check(accepted.status === 202, `배포 API가 202로 받아들임 (실제: ${accepted.status} ${accepted.body.error ?? ''})`);
    deployedProjectRoot = path.join(projects, PROJECT);
    if (accepted.status === 202) {
      await waitFor(() => events.some((event) => event.type === 'deploy_finished' || event.type === 'deploy_failed'), 30 * 60_000, '배포가 끝나지 않았습니다');
      const finished = events.find((event) => event.type === 'deploy_finished' || event.type === 'deploy_failed')!;
      check(finished.type === 'deploy_finished', `운영 릴리스 완료 (${finished.type === 'deploy_finished' ? `${finished.release} ${JSON.stringify(finished.urls)}` : `${finished.error}`})`);
      if (finished.type === 'deploy_failed') {
        // 빌드 실패의 원인(디스크 부족, 의존성 다운로드 실패 등)이 코드 문제인지 구분할 수 있게 마지막 로그를 남긴다
        const lines = events.flatMap((event) => (event.type === 'deploy_log' ? [String(event.line)] : []));
        log(String(finished.detail ?? lines.slice(-20).join('\n')).split('\n').slice(-20).map((line) => `    ${line}`).join('\n'));
      }
      const web = (finished.urls as Record<string, string> | undefined)?.web;
      if (web) {
        const page = await fetch(new URL('/gate-probe', web)).then((response) => response.text()).catch((error: unknown) => String(error));
        check(page.includes('게이트 확인 화면'), '운영 주소에서 배포한 화면 응답');
      }
    }
  } finally {
    if (sessionId) {
      const { stopSession } = await import('../lib/server/sessions');
      await stopSession(sessionId).catch(() => {});
    }
    if (deployedProjectRoot) {
      const [{ loadProject }, { DockerDeployer }] = await Promise.all([import('@b-studio/spec'), import('@b-studio/sandbox')]);
      await new DockerDeployer(await loadProject(deployedProjectRoot)).remove({ volumes: true }).catch((error: unknown) => log(`배포 정리 실패: ${String(error)}`));
    }
    await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    log(`\n❌ ${failures.length}개 실패`);
    process.exitCode = 1;
  } else {
    log('\n✅ 배포 조건 E2E 통과');
  }
}

/** 첫 턴에는 깨진 화면을, 게이트 피드백을 받으면 고친 화면을 쓰는 OpenAI 호환 모델 */
async function fakeProvider(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models/')) return json(response, 200, { id: 'gate-probe', object: 'model' });
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(response, 404, { error: { message: 'not found' } });
    const body = JSON.parse(await text(request)) as { messages?: Array<{ role?: string; content?: unknown }> };
    const messages = body.messages ?? [];
    const feedbackAt = messages.findLastIndex((message) => message.role === 'user' && JSON.stringify(message.content ?? '').includes(GATE_FEEDBACK));
    const toolAfterLastPrompt = messages.slice(feedbackAt + 1).some((message) => message.role === 'tool');
    if (!toolAfterLastPrompt) {
      const content = feedbackAt === -1 ? BROKEN_PAGE : FIXED_PAGE;
      return json(response, 200, {
        id: `write-${feedbackAt}`,
        model: 'gate-probe',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { content: null, tool_calls: [{ id: `call-${feedbackAt + 1}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: PROBE_FILE, content }) } }] },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    }
    return json(response, 200, {
      id: `done-${feedbackAt}`,
      model: 'gate-probe',
      choices: [{ finish_reason: 'stop', message: { content: feedbackAt === -1 ? '화면을 추가했습니다.' : '스크립트 예외를 고쳤습니다.' } }],
      usage: { prompt_tokens: 120, completion_tokens: 10 },
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function text(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function waitFor(condition: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1_000).toFixed(1)}s`;
}

function log(message: string): void {
  console.log(message);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
