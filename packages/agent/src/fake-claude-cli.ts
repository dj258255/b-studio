import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** 가짜 CLI(fixtures/fake-claude-cli.mjs)를 러너에 끼우는 테스트 도우미 */
const SCRIPT = path.join(__dirname, 'fixtures', 'fake-claude-cli.mjs');

export const FAKE_NEW_SESSION = '00000000-0000-4000-8000-000000000001';
export const FAKE_FORKED_SESSION = '00000000-0000-4000-8000-000000000002';
export const FAKE_PREVIOUS_SESSION = '00000000-0000-4000-8000-000000000003';

export type FakeStep = ({ tool: string; input: Record<string, unknown> } | { text: string } | { raw: Record<string, unknown> } | { hang: true }) & {
  /** 이 assistant 메시지의 usage. 주면 실행 지표(maxContextTokens) 계산에 쓰인다 */
  usage?: Record<string, number>;
  /** 같은 id를 여러 메시지에 쓰면 지표상 한 번의 호출로 센다 */
  id?: string;
  /** 도구 호출 앞에서 기다리는 시간(ms) */
  delay?: number;
};

export interface FakeInvocation {
  sessionId?: string;
  /** 첫 사용자 메시지에 이 글의 오류 결과를 내고 끝난다(네트워크 오류 흉내) */
  failFirst?: string;
  failApiMs?: number;
  /** init 직후에 내는 줄(압축 상태 등) */
  /** 문자열은 JSON이 아닌 줄 그대로 낸다 */
  pre?: Array<Record<string, unknown> | string>;
  initExtra?: Record<string, unknown>;
  noInit?: boolean;
  /** 입력을 받기 전에 이 종료 코드로 끝난다(결과 없이 끝나는 CLI) */
  exitWithoutResult?: number;
  stderr?: string;
  ignoreSigterm?: boolean;
  /** 표준 입력이 닫혀도 끝나지 않는다 */
  hangAfterEof?: boolean;
}

export interface FakeCliScenario {
  /** 사용자 메시지마다 모델이 할 일. 프로세스를 다시 띄워도 이어서 꺼낸다 */
  turns?: FakeStep[][];
  /** result에 덮어쓸 필드 */
  result?: Record<string, unknown>;
  modelUsages?: Array<Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>>;
  apiDurations?: number[];
  /** 프로세스를 띄운 순서대로 적용하는 개별 설정 */
  invocations?: FakeInvocation[];
  /** 결과를 낸 뒤 이 코드로 끝난다(오류 결과 뒤에 0이 아닌 코드로 끝나는 진짜 CLI) */
  exitCodeAfterResult?: number;
  stderrAfterResult?: string;
  /** `claude auth status`의 출력 */
  auth?: Record<string, unknown>;
  authHang?: boolean;
}

export interface FakeCliLog {
  call: number;
  args: string[];
  cwd: string;
  env: { window: string | null; clientApp: string | null; hasMcpToken: boolean; configDir: string | null };
  mcp?: { text: string; mode: number };
  systemPrompt?: { text: string; mode: number };
  appendSystemPrompt?: { text: string; mode: number };
  /** 표준 입력으로 받은 줄(JSON) */
  stdin: Array<{ type?: string; message?: { role?: string; content?: unknown }; parent_tool_use_id?: unknown }>;
  tools: Array<{ name: string; input: unknown; status: number; isError: boolean | null; error: string | null }>;
  signals: string[];
  stdinClosed?: boolean;
}

export function fakeClaudeCli(scenario: FakeCliScenario = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-claude-cli-'));
  const scenarioPath = path.join(dir, 'scenario.json');
  const prefix = path.join(dir, 'log');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const logs = (): FakeCliLog[] =>
    readdirSync(dir)
      .filter((name) => /^log\.\d+\.json$/.test(name))
      .sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
      .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as FakeCliLog);
  const authLog = (): { args: string[]; env: { CLAUDE_CONFIG_DIR: string | null } } => JSON.parse(readFileSync(`${prefix}.auth.json`, 'utf8'));
  return {
    /** 러너·preflight에 그대로 펼쳐 넣는다 */
    cli: { command: process.execPath, commandArgs: [SCRIPT, scenarioPath, prefix] },
    logs,
    authLog,
    /** 사용자 메시지 글. 모든 프로세스의 표준 입력을 순서대로 모았다 */
    prompts: (): string[] => logs().flatMap((log) => log.stdin.map((line) => String(line.message?.content))),
    /** 프로세스 하나의 인자에서 플래그의 값 */
    argOf: (log: FakeCliLog, flag: string): string | undefined => (log.args.includes(flag) ? log.args[log.args.indexOf(flag) + 1] : undefined),
  };
}
