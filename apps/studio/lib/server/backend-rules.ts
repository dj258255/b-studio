/**
 * 내가 정한 규칙(#822)을 스튜디오 상태 폴더에 두고, 요청마다 쓸 백엔드를 고른다.
 *
 * 파일은 `~/.cache/b-studio/backend-rules.json`(바꿀 때 `B_STUDIO_BACKEND_RULES_FILE`)이고, model-defaults.ts와 같이
 * 임시 파일에 쓴 뒤 이름을 바꾸며 0600으로 둔다. 사용자의 저장소에는 아무것도 남기지 않는다.
 *
 * 고르기: 맞는 규칙을 위에서부터 보고, 지금 서버가 허용하고 로그인돼 있는 첫 후보를 쓴다. 맞는 규칙이 로그인 전이면 까닭을 남기고
 * 다음으로 간다. 규칙도 기본값도 없으면 서버의 기본 백엔드(B_STUDIO_MODE)다.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { classifyTask } from '@b-studio/agent';
import { describeWhen, matchCandidates, parseBackendRules, type BackendRules, type RuleCandidate, type RuleIntent } from '../backend-rules';
import type { TaskKind } from '../routing-types';
import type { SessionMode } from '../studio-events';
import { StudioError } from './errors';
import { allowedBackends, assertBackendReady, resolveSessionBackend } from './sessions';

export interface RoutingDeps {
  /** 지금 서버가 허용하는 백엔드(B_STUDIO_MODE + B_STUDIO_BACKENDS) */
  allowed(): readonly string[];
  /** 규칙이 없을 때 쓰는 서버의 기본 백엔드 */
  defaultBackend(): string;
  /** 로그인돼 있지 않으면 StudioError를 던진다 */
  ready(backend: string, cwd: string): Promise<void>;
}

export interface RoutingSkip {
  rule: RuleCandidate['rule'] | 'default';
  backend: string;
  reason: string;
}

export interface RoutingDecision {
  backend: string;
  model?: string;
  /** 고른 규칙의 순서(0부터), 기본값(fallback), 서버 기본(default), 사람이 이번 요청만 직접 고름(direct) */
  rule: RuleCandidate['rule'] | 'default' | 'direct';
  /** 고른 규칙의 조건을 사람이 읽는 말로 */
  matched: string;
  kind: TaskKind;
  /** 맞았지만 쓰지 못하고 건너뛴 후보 */
  skipped: RoutingSkip[];
}

let cache: { rules: BackendRules; error?: string } | undefined;

function filePath(): string {
  return path.resolve(/* turbopackIgnore: true */ process.env.B_STUDIO_BACKEND_RULES_FILE ?? path.join(homedir(), '.cache', 'b-studio', 'backend-rules.json'));
}

/**
 * 저장한 규칙. 파일이 없으면 빈 규칙이다. 파일이 깨졌거나 이제 허용하지 않는 백엔드를 가리키면 규칙 없이 고르고
 * 그 까닭을 error로 돌려준다(화면이 알린다). 그 때문에 요청을 막지 않는다
 */
export function readBackendRules(deps: RoutingDeps = defaultDeps()): { rules: BackendRules; error?: string } {
  if (cache) return cache;
  let raw: string;
  try {
    raw = readFileSync(/* turbopackIgnore: true */ filePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (cache = { rules: { rules: [] } });
    return { rules: { rules: [] }, error: `규칙 파일을 읽지 못했습니다: ${(error as Error).message}` };
  }
  try {
    cache = { rules: parseBackendRules(JSON.parse(raw), deps.allowed()) };
  } catch (error) {
    cache = { rules: { rules: [] }, error: `저장한 규칙을 쓰지 못해 규칙 없이 고릅니다: ${(error as Error).message}` };
  }
  return cache;
}

/** 화면에서 고친 규칙을 검사해 저장한다. 틀리면 400이고 파일을 바꾸지 않는다 */
export function saveBackendRules(value: unknown, deps: RoutingDeps = defaultDeps()): BackendRules {
  let rules: BackendRules;
  try {
    rules = parseBackendRules(value, deps.allowed());
  } catch (error) {
    throw new StudioError(400, (error as Error).message);
  }
  const file = filePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(rules, null, 2), { mode: 0o600 });
  renameSync(temp, file);
  cache = { rules };
  return rules;
}

function candidatesFor(input: { request: string; intent: RuleIntent }, deps: RoutingDeps): { kind: TaskKind; rules: BackendRules; candidates: Array<RuleCandidate | (Omit<RuleCandidate, 'rule'> & { rule: 'default' })> } {
  const kind = classifyTask(input.request);
  const { rules } = readBackendRules(deps);
  const matched = matchCandidates(rules, { request: input.request, intent: input.intent, kind });
  const candidates: Array<RuleCandidate | (Omit<RuleCandidate, 'rule'> & { rule: 'default' })> = [...matched];
  if (!rules.fallback) candidates.push({ rule: 'default', backend: deps.defaultBackend() });
  return { kind, rules, candidates };
}

function matchedText(rules: BackendRules, rule: RoutingDecision['rule']): string {
  if (rule === 'fallback') return '기본값';
  if (rule === 'default') return '맞는 규칙 없음';
  if (rule === 'direct') return '직접 고름';
  return describeWhen(rules.rules[rule]!.when);
}

/** 보내기 전 미리보기. 로그인은 확인하지 않는다(CLI를 띄우는 데 몇 초 걸린다). 보낼 때 chooseBackend가 확인한다 */
export function previewBackend(input: { request: string; intent: RuleIntent }, deps: RoutingDeps = defaultDeps()): Omit<RoutingDecision, 'skipped'> {
  const { kind, rules, candidates } = candidatesFor(input, deps);
  const allowed = new Set(deps.allowed());
  const first = candidates.find((candidate) => allowed.has(candidate.backend)) ?? candidates[candidates.length - 1]!;
  return { backend: first.backend, ...(first.model ? { model: first.model } : {}), rule: first.rule, matched: matchedText(rules, first.rule), kind };
}

/** 요청을 보낼 때. 허용하고 로그인된 첫 후보를 고른다. 모두 쓸 수 없으면 409로 각 까닭을 알린다 */
/**
 * 고르는 쪽이 따로 거르는 조건(#836). 그 백엔드를 이번 요청에 쓸 수 없으면 까닭을, 쓸 수 있으면 undefined를 돌려준다.
 * 터미널로 보낼 때 터미널에서 띄울 수 없는 AI를 거른다
 */
export type BackendFilter = (backend: string) => string | undefined;

export async function chooseBackend(input: { request: string; intent: RuleIntent; cwd: string; only?: BackendFilter }, deps: RoutingDeps = defaultDeps()): Promise<RoutingDecision> {
  const { kind, rules, candidates } = candidatesFor(input, deps);
  const allowed = new Set(deps.allowed());
  const skipped: RoutingSkip[] = [];
  const failed = new Map<string, string>();
  for (const candidate of candidates) {
    if (!allowed.has(candidate.backend)) {
      skipped.push({ rule: candidate.rule, backend: candidate.backend, reason: `이 스튜디오가 허용하지 않는 백엔드입니다(B_STUDIO_BACKENDS)` });
      continue;
    }
    const unusable = input.only?.(candidate.backend);
    if (unusable !== undefined) {
      skipped.push({ rule: candidate.rule, backend: candidate.backend, reason: unusable });
      continue;
    }
    let reason = failed.get(candidate.backend);
    if (reason === undefined) {
      try {
        await deps.ready(candidate.backend, input.cwd);
      } catch (error) {
        if (!(error instanceof StudioError)) throw error;
        reason = error.message;
        failed.set(candidate.backend, reason);
      }
    }
    if (reason !== undefined) {
      skipped.push({ rule: candidate.rule, backend: candidate.backend, reason });
      continue;
    }
    return { backend: candidate.backend, ...(candidate.model ? { model: candidate.model } : {}), rule: candidate.rule, matched: matchedText(rules, candidate.rule), kind, skipped };
  }
  throw new StudioError(409, `규칙에 맞는 AI를 쓸 수 없어 요청을 보내지 않았습니다. ${skipped.map((skip) => `${skip.backend}: ${skip.reason}`).join(' / ')}`);
}

/**
 * 이번 요청만 사람이 고른 AI로 보낸다(#827). 규칙은 보지 않는다. 허용과 로그인은 chooseBackend와 같이 확인하지만,
 * 사람이 고른 것이므로 안 되면 다른 AI로 넘어가지 않고 거절한다(허용 밖 400, 로그인 전 409)
 */
export async function chooseDirect(input: { backend: string; model?: string; request: string; intent: RuleIntent; cwd: string; only?: BackendFilter }, deps: RoutingDeps = defaultDeps()): Promise<RoutingDecision> {
  if (!deps.allowed().includes(input.backend)) throw new StudioError(400, `이 스튜디오가 허용하지 않는 백엔드입니다(B_STUDIO_BACKENDS): ${input.backend}`);
  const unusable = input.only?.(input.backend);
  if (unusable !== undefined) throw new StudioError(400, `${input.backend}: ${unusable}`);
  try {
    await deps.ready(input.backend, input.cwd);
  } catch (error) {
    if (!(error instanceof StudioError)) throw error;
    throw new StudioError(409, `고른 AI를 쓸 수 없어 요청을 보내지 않았습니다. ${input.backend}: ${error.message}`);
  }
  const model = input.model?.trim();
  return { backend: input.backend, ...(model ? { model } : {}), rule: 'direct', matched: matchedText({ rules: [] }, 'direct'), kind: classifyTask(input.request), skipped: [] };
}

function defaultDeps(): RoutingDeps {
  return {
    allowed: () => [...allowedBackends()],
    defaultBackend: () => resolveSessionBackend(undefined),
    ready: (backend, cwd) => assertBackendReady(backend as SessionMode, cwd),
  };
}

/** 테스트 전용: 캐시를 비워 다음 호출이 파일을 다시 읽게 한다 */
export function resetBackendRulesCache(): void {
  cache = undefined;
}
