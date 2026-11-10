// 테스트용 가짜 `claude` CLI. 진짜 CLI의 공개 입출력만 흉내 낸다: 받은 인자·표준 입력 줄·환경을 기록하고,
// 표준 입력의 사용자 메시지마다 정해 둔 stream-json 줄을 내며, 도구 단계는 --mcp-config의 HTTP MCP 서버를 실제로 부른다.
// 호출: node fake-claude-cli.mjs <시나리오.json> <기록 접두어> [러너가 붙인 인자...]
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [scenarioPath, prefix, ...args] = process.argv.slice(2);
// 멈춰 있는 CLI를 흉내 낼 때 이벤트 루프가 비어 프로세스가 저절로 끝나지 않게 한다
const hang = () => new Promise(() => setInterval(() => {}, 1000));
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

// `claude auth status`: 로그인 상태를 JSON으로 낸다
if (args[0] === 'auth' && args[1] === 'status') {
  const auth = scenario.auth ?? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'someone@example.com' };
  writeFileSync(`${prefix}.auth.json`, JSON.stringify({ args, env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null } }));
  if (scenario.authHang) await hang();
  process.stdout.write(`${JSON.stringify(auth)}\n`);
  process.exit(auth.loggedIn === false ? 1 : 0);
}

// 호출 번호. 러너는 한 번에 하나만 띄우므로 경쟁이 없다
const countFile = `${prefix}.count`;
const call = (existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0) + 1;
writeFileSync(countFile, String(call));
const inv = scenario.invocations?.[call - 1] ?? {};
const stateFile = `${prefix}.state.json`;
if (!existsSync(stateFile)) writeFileSync(stateFile, JSON.stringify({ turns: scenario.turns ?? [], modelUsages: scenario.modelUsages ?? [], apiDurations: scenario.apiDurations ?? [] }));
const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
// 턴 사이 상태도 기록과 같은 방식으로 쓴다(다음 호출이 읽는다). writeRecord는 아래에 있고 턴을 처리할 때 불린다
const writeState = (state) => writeRecord(stateFile, JSON.stringify(state));

const fileOf = (flag) => {
  const file = valueOf(flag);
  return file ? { text: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 } : undefined;
};
const log = {
  call,
  args,
  cwd: process.cwd(),
  env: {
    window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null,
    clientApp: process.env.CLAUDE_AGENT_SDK_CLIENT_APP ?? null,
    hasMcpToken: Boolean(process.env.B_STUDIO_MCP_TOKEN),
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  },
  mcp: fileOf('--mcp-config'),
  systemPrompt: fileOf('--system-prompt-file'),
  appendSystemPrompt: fileOf('--append-system-prompt-file'),
  stdin: [],
  tools: [],
  signals: [],
};
// 기록 파일 쓰기. 러너 시험은 SIGTERM 뒤 곧 SIGKILL을 보내므로, 쓰는 도중에 죽어도 읽는 쪽이 잘린 JSON을 보지 않게 임시 파일에 다 쓴 뒤
// rename으로 바꾼다(POSIX에서 통째로 바뀐다, 이슈 #1106). 시험이 `slowFlushMs`를 주면 반을 쓰고 쉬었다가 나머지를 쓴다(죽는 창을 넓혀 재현한다)
const writeRecord = (file, text) => {
  const tmp = `${file}.tmp`;
  if (!scenario.slowFlushMs) {
    writeFileSync(tmp, text);
  } else {
    const fd = openSync(tmp, 'w');
    writeSync(fd, text.slice(0, text.length >> 1));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, scenario.slowFlushMs);
    writeSync(fd, text.slice(text.length >> 1));
    closeSync(fd);
  }
  renameSync(tmp, file);
};
const flush = () => writeRecord(`${prefix}.${call}.json`, JSON.stringify(log));
flush();
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log.signals.push(signal);
    flush();
    if (!inv.ignoreSigterm) process.exit(signal === 'SIGTERM' ? 143 : 130);
  });
}

const sessionId = inv.sessionId ?? (args.includes('--resume') ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001');

/** 모델이 부른 도구를 HTTP MCP 서버에 실제로 요청한다(진짜 CLI가 --mcp-config로 하는 일) */
async function callTool(name, input) {
  const config = JSON.parse(log.mcp.text).mcpServers['b-studio'];
  const token = process.env.B_STUDIO_MCP_TOKEN ?? '';
  const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, String(value).replaceAll('${B_STUDIO_MCP_TOKEN}', token)]));
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }),
  });
  const body = await response.text();
  const data = body.startsWith('event:') || body.includes('\ndata:') ? body.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).at(-1) : body;
  let parsed;
  try { parsed = JSON.parse(data); } catch { parsed = { unparsed: body }; }
  log.tools.push({ name, input, status: response.status, isError: parsed.result?.isError ?? null, error: parsed.error?.message ?? null });
  flush();
}

let ids = 0;
let turnInThisProcess = 0;
async function handleTurn() {
  turnInThisProcess += 1;
  if (inv.failFirst && turnInThisProcess === 1) {
    emit({ type: 'result', subtype: 'success', is_error: true, result: inv.failFirst, stop_reason: 'end_turn', errors: [], modelUsage: {}, duration_api_ms: inv.failApiMs ?? 1000, session_id: sessionId });
    process.exit(0);
  }
  const state = readState();
  const steps = state.turns.shift();
  if (!steps) {
    process.stderr.write('스크립트에 남은 턴이 없습니다\n');
    process.exit(1);
  }
  let lastText = '';
  for (const step of steps) {
    const id = step.id ?? `msg_${++ids}`;
    const usage = step.usage ? { usage: step.usage } : {};
    if (step.raw) emit(step.raw);
    else if (step.hang) await hang();
    else if (step.delay && !step.tool) await new Promise((r) => setTimeout(r, step.delay));
    else if (step.tool) {
      if (step.delay) await new Promise((r) => setTimeout(r, step.delay));
      const content = [{ type: 'tool_use', id: `toolu_${ids}`, name: `mcp__b-studio__${step.tool}`, input: step.input }];
      emit({ type: 'assistant', message: { id, content, ...usage }, parent_tool_use_id: null, session_id: sessionId });
      await callTool(step.tool, step.input);
    } else {
      lastText = step.text;
      emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: step.text }], ...usage }, parent_tool_use_id: null, session_id: sessionId });
    }
  }
  const modelUsage = state.modelUsages.shift() ?? { 'test-model': { inputTokens: 10 * ids, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 } };
  const apiDuration = state.apiDurations.length > 0 ? { duration_api_ms: state.apiDurations.shift() } : {};
  writeState(state);
  emit({ type: 'result', subtype: 'success', is_error: false, result: lastText, stop_reason: 'end_turn', errors: [], modelUsage, session_id: sessionId, ...apiDuration, ...(scenario.result ?? {}) });
  // 진짜 CLI는 오류 결과를 낸 뒤 0이 아닌 종료 코드로 끝날 수 있다
  if (scenario.exitCodeAfterResult !== undefined) {
    if (scenario.stderrAfterResult) process.stderr.write(`${scenario.stderrAfterResult}\n`);
    process.exit(scenario.exitCodeAfterResult);
  }
}

// 진짜 CLI처럼 --mcp-config의 서버 상태를 싣는다(https://code.claude.com/docs/en/headless 의 mcp_servers). 시험이 initExtra로 덮어쓴다
if (!inv.noInit) emit({ type: 'system', subtype: 'init', claude_code_version: '9.9.9', model: 'test-model', session_id: sessionId, mcp_servers: [{ name: 'b-studio', status: 'connected' }], ...(inv.initExtra ?? {}) });
for (const raw of inv.pre ?? []) (typeof raw === 'string' ? process.stdout.write(`${raw}\n`) : emit(raw));
if (inv.exitWithoutResult !== undefined) {
  if (inv.stderr) process.stderr.write(`${inv.stderr}\n`);
  process.exit(inv.exitWithoutResult);
}

let queue = Promise.resolve();
createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { message = { unparsed: line }; }
    log.stdin.push(message);
    flush();
    queue = queue.then(handleTurn).catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exit(1);
    });
  })
  .on('close', () => {
    // 표준 입력이 닫히면 하던 턴을 마치고 끝난다
    log.stdinClosed = true;
    flush();
    queue.then(() => (inv.hangAfterEof ? hang() : process.exit(0)));
  });
