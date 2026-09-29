/**
 * 기준선 P0: 같은 과제를 b-studio 없이 Claude Code만으로 돌린다.
 *
 * 벤치가 만든 프로젝트 복사본에서 Claude Code를 한 번 돌려 과제 전체(전체 요청 + api 요청 + web 요청)를 맡긴다.
 * 도구는 파일 도구(Read·Edit·Write·Glob·Grep)만 준다. **Bash·WebFetch·WebSearch·Task가 없어** 모델이 스스로
 * 서비스를 띄우거나 명령을 돌려 확인할 수 없다. 그래서 인수 검사는 뒤에서 스튜디오가 세션만 띄워 확인한다(run.ts).
 * 이 모듈은 파일 변경과 토큰만 잰다 — 그래서 "Bash가 없어 스스로 실행해 볼 수 없다"는 한계가 결과에 그대로 남는다.
 */
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeUsageTracker, describeResultFailure, type AgentUsage } from '@b-studio/agent';
import { isRateLimited } from './classify';
import type { BenchTask } from './tasks';

/** P0가 모델에게 주는 도구. 파일 도구만 — Bash·WebFetch·WebSearch·Task는 주지 않는다 */
export const PLAIN_BASELINE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'] as const;

/** 러너와 같은 턴 상한 */
export const PLAIN_BASELINE_MAX_TURNS = 60;

/** 비교에서 빼는 생성물 폴더. 코드가 아니라 실행 산출물이라 변경으로 세지 않는다 */
const GENERATED = /[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/;

export interface PlainBaselineOptions {
  /** 벤치가 만든 프로젝트 복사본. 모델이 이 폴더를 직접 고친다 */
  projectDir: string;
  task: BenchTask;
  /** 넘기지 않으면 로그인 계정의 기본 모델을 쓴다 */
  model?: string;
  sdk?: PlainBaselineSdk;
  signal?: AbortSignal;
  maxTurns?: number;
}

export interface PlainBaselineResult {
  status: 'done' | 'failed' | 'rate_limited';
  usage: AgentUsage;
  /** 모델 이름별 토큰. 환산 비용을 모델별 단가로 계산할 때 쓴다 */
  usageByModel: Record<string, AgentUsage>;
  modelCalls: number;
  maxContextTokens: number;
  durationMs: number;
  turns: number;
  /** 실행 전후 복사본에서 더하거나 고치거나 지운 파일(정렬) */
  changedFiles: string[];
  summary: string;
}

/** 실제 SDK와 테스트용 가짜를 바꿔 끼우는 지점. P0는 MCP 서버를 만들지 않는다 */
export interface PlainBaselineSdk {
  query(params: { prompt: string; options: Options }): PlainBaselineQuery;
}

export interface PlainBaselineQuery extends AsyncIterable<SDKMessage> {
  close(): void;
}

const DEFAULT_SDK: PlainBaselineSdk = { query };

/**
 * 복사본에서 Claude Code를 한 번 돌린다. 사용 한도 문구는 backends/classify의 기존 규칙으로 rate_limited로 본다.
 * 예상하지 못한 오류(로그인 없음 등)는 삼키지 않고 던져, run.ts가 하네스 오류로 분류하게 한다.
 */
export async function runPlainBaseline({
  projectDir,
  task,
  model,
  sdk = DEFAULT_SDK,
  signal,
  maxTurns = PLAIN_BASELINE_MAX_TURNS,
}: PlainBaselineOptions): Promise<PlainBaselineResult> {
  // 'project' 설정을 싣기 때문에, 복사본에 훅·MCP 설정이 있으면 호스트에서 명령이 돌 수 있다. 그런 복사본은 돌리지 않는다
  const unsafe = await projectAgentSettings(projectDir);
  if (unsafe.length > 0) throw new Error(`기준선 P0는 에이전트 설정 파일이 있는 프로젝트를 돌리지 않습니다: ${unsafe.join(', ')}`);
  const started = performance.now();
  const before = await snapshotFiles(projectDir);
  const tracker = new ClaudeCodeUsageTracker();
  const abort = new AbortController();
  const onAbort = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  let summary = '';
  let status: PlainBaselineResult['status'] = 'done';
  let conversation: PlainBaselineQuery | undefined;
  try {
    conversation = sdk.query({
      prompt: buildPlainRequest(task),
      options: {
        // 벤치가 만든 프로젝트 복사본 안에서만 돈다
        cwd: projectDir,
        // 그냥 Claude Code와 같은 시스템 프롬프트
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        // 파일 도구만. Bash가 없어 스스로 실행해 확인할 수 없다
        tools: [...PLAIN_BASELINE_TOOLS],
        allowedTools: [...PLAIN_BASELINE_TOOLS],
        permissionMode: 'dontAsk',
        // 복사본 안의 CLAUDE.md·AGENTS.md는 그냥 Claude Code처럼 읽되, 사용자 전역 설정·훅·플러그인은 싣지 않는다
        settingSources: ['project'],
        // 프로젝트의 .mcp.json 등 다른 MCP 설정을 싣지 않는다
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        ...(model ? { model } : {}),
        maxTurns,
        abortController: abort,
      },
    });

    for await (const message of conversation) {
      signal?.throwIfAborted();
      if (message.type === 'assistant') {
        // 하위 에이전트 메시지는 본 대화로 세지 않는다
        if (message.parent_tool_use_id) continue;
        tracker.observeAssistant(message.message);
        const text = message.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').trim();
        if (text) summary = text;
      } else if (message.type === 'result') {
        tracker.observeResult(message);
        const failure = describeResultFailure(message);
        if (failure) {
          status = isRateLimited(failure) ? 'rate_limited' : 'failed';
          summary = failure;
          break;
        }
        if (message.subtype === 'success' && message.result) summary = message.result;
      }
    }
  } finally {
    conversation?.close();
    signal?.removeEventListener('abort', onAbort);
  }

  const after = await snapshotFiles(projectDir);
  return {
    status,
    usage: { ...tracker.usage },
    usageByModel: tracker.usageByModel,
    modelCalls: tracker.modelCalls,
    maxContextTokens: tracker.maxContextTokens,
    durationMs: Math.round(performance.now() - started),
    turns: tracker.modelCalls,
    changedFiles: diffFiles(before, after),
    summary,
  };
}

/** 과제 전체를 한 에이전트에게 한 번에 맡긴다: 전체 요청 + api 요청 + web 요청 */
export function buildPlainRequest(task: BenchTask): string {
  return [task.request, task.api.request, task.web.request].join('\n');
}

/** 파일 경로·내용 해시. 생성물 폴더는 뺀다 */
async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (GENERATED.test(absolute)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) files.set(relative, createHash('sha1').update(await readFile(absolute)).digest('hex'));
    }
  };
  await walk(root, '');
  return files;
}

/** 더하거나 고치거나 지운 파일. 추가·삭제도 변경으로 센다 */
function diffFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [file, hash] of after) if (before.get(file) !== hash) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

/** 복사본 안에서 훅·MCP 서버를 정의할 수 있는 에이전트 설정 파일(있으면 실행을 거부한다) */
export async function projectAgentSettings(projectDir: string): Promise<string[]> {
  const candidates = ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'];
  const found: string[] = [];
  for (const relative of candidates) {
    try {
      await access(path.join(projectDir, relative));
      found.push(relative);
    } catch {
      // 없으면 안전하다
    }
  }
  return found;
}
