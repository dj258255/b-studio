/**
 * Agent Fleet의 실제 실행 경로를 외부 과금 없이 검증한다.
 * 두 OpenAI 호환 HTTP 서버 → 제공자 어댑터 → 서로 다른 세션 복사본과 Docker 샌드박스
 * → 검증 게이트 → 체크포인트 → 승자 선택을 한 번에 지난다.
 *
 *   pnpm e2e:fleet
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

interface FakeProvider {
  id: string;
  server: Server;
  baseUrl: string;
}

const TERMINAL = new Set(['done', 'failed', 'error', 'cancelled']);

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(homedir(), '.cache/b-studio/', 'fleet-e2e-'));
  const providers: FakeProvider[] = [];
  let sessionIds: string[] = [];
  try {
    providers.push(await fakeProvider('alpha'), await fakeProvider('beta'));
    const registry = providers.map((provider, index) => ({
      id: `local-${provider.id}`,
      provider: 'openai',
      model: `fleet-${provider.id}`,
      label: `Local ${provider.id}`,
      capabilities: ['tools', 'json'],
      contextWindow: 32_000,
      pricing: { inputPerMillion: 1 + index, outputPerMillion: 2 + index },
      baselineQuality: 0.8,
      baselineLatencyMs: 100,
      baseUrl: provider.baseUrl,
    }));
    const registryFile = path.join(root, 'models.json');
    await writeFile(registryFile, JSON.stringify(registry, null, 2), { mode: 0o600 });
    await mkdir(path.join(root, 'sessions'), { recursive: true });

    process.env.B_STUDIO_MODE = 'api';
    process.env.B_STUDIO_MODEL_REGISTRY = registryFile;
    process.env.B_STUDIO_PROJECTS_DIR = path.resolve(import.meta.dirname, '../../../examples');
    process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
    process.env.B_STUDIO_FLEETS_DIR = path.join(root, 'fleets');
    process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE = path.join(root, 'model-observations.json');

    const [{ createFleet, getFleet, chooseFleetWinner }, { getSnapshot, stopSession }, { observations }] = await Promise.all([
      import('../lib/server/fleets'),
      import('../lib/server/sessions'),
      import('../lib/server/model-observations'),
    ]);

    const owner = 'fleet-e2e';
    const request = '각 후보 이름이 적힌 검증 메모 파일을 web 폴더에 추가해줘';
    const started = Date.now();
    const created = await createFleet({ projectId: 'orders', request, modelIds: registry.map((model) => model.id), owner });
    sessionIds = created.members.map((member) => member.sessionId);
    log(`Fleet ${created.id}: ${sessionIds.length}개 독립 세션 생성`);

    let fleet = created;
    let previous = '';
    while (!fleet.members.every((member) => TERMINAL.has(member.status))) {
      if (Date.now() - started > 10 * 60_000) throw new Error('Agent Fleet이 10분 안에 끝나지 않았습니다');
      await delay(1_000);
      fleet = getFleet(created.id, owner);
      const current = fleet.members.map((member) => `${member.label}=${member.status}`).join(', ');
      if (current !== previous) {
        log(current);
        previous = current;
      }
    }

    const failed = fleet.members.filter((member) => member.status !== 'done');
    if (failed.length) throw new Error(failed.map((member) => `${member.label}: ${member.status} ${member.summary ?? ''}`).join('\n'));
    if (new Set(fleet.members.map((member) => member.sessionId)).size !== 2) throw new Error('후보가 서로 다른 세션을 쓰지 않았습니다');
    if (fleet.members.some((member) => !member.checkpoint || !member.checkpoint.files.some((file) => file.startsWith('web/FLEET_')))) {
      throw new Error('후보 체크포인트에 독립 검증 파일이 없습니다');
    }
    if (fleet.members.some((member) => member.costUsd === undefined || member.usage === undefined)) throw new Error('Fleet 결과에 토큰과 비용이 없습니다');

    const selected = chooseFleetWinner(fleet.id, fleet.members[0]!.sessionId, owner);
    if (selected.winnerSessionId !== fleet.members[0]!.sessionId) throw new Error('통과한 후보를 승자로 기록하지 못했습니다');
    const measured = observations();
    if (measured.length !== 2 || measured.some((item) => !item.passed || item.costUsd === undefined)) {
      throw new Error(`모델 관측 기록이 올바르지 않습니다: ${JSON.stringify(measured)}`);
    }

    for (const member of fleet.members) {
      const note = member.checkpoint!.files.find((file) => file.startsWith('web/FLEET_'))!;
      const workDir = getSnapshot(member.sessionId)?.workDir;
      if (!workDir) throw new Error(`${member.label} 세션 작업 폴더를 찾지 못했습니다`);
      const content = await readFile(path.join(workDir, note), 'utf8');
      log(`✓ ${member.label}: ${member.turns}턴 · $${member.costUsd!.toFixed(6)} · ${member.checkpoint!.shortSha} · ${note} ${content.trim()}`);
    }
    log(`✅ 실제 Docker Agent Fleet E2E 통과 (${((Date.now() - started) / 1_000).toFixed(1)}초)`);

    for (const id of sessionIds) await stopSession(id).catch(() => {});
    sessionIds = [];
  } finally {
    if (sessionIds.length) {
      const { stopSession } = await import('../lib/server/sessions').catch(() => ({ stopSession: async () => {} }));
      for (const id of sessionIds) await stopSession(id).catch(() => {});
    }
    await Promise.all(providers.map((provider) => close(provider.server)));
    await rm(root, { recursive: true, force: true });
  }
}

async function fakeProvider(id: string): Promise<FakeProvider> {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models/')) {
      return json(response, 200, { id: `fleet-${id}`, object: 'model' });
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(response, 404, { error: { message: 'not found' } });
    const body = JSON.parse(await text(request)) as { messages?: Array<{ role?: string }> };
    const hasToolResult = body.messages?.some((message) => message.role === 'tool') ?? false;
    if (!hasToolResult) {
      return json(response, 200, {
        id: `message-${id}-tool`,
        model: `fleet-${id}`,
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: `call-${id}`,
                  type: 'function',
                  function: { name: 'write_file', arguments: JSON.stringify({ path: `web/FLEET_${id.toUpperCase()}.md`, content: `${id}\n` }) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    }
    return json(response, 200, {
      id: `message-${id}-done`,
      model: `fleet-${id}`,
      choices: [{ finish_reason: 'stop', message: { content: `${id} 후보의 검증 메모를 추가했습니다.` } }],
      usage: { prompt_tokens: 120, completion_tokens: 15 },
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return { id, server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function text(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  console.log(message);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
