import type { StudioEvent } from '@/lib/studio-events';
import type { PersistedBody } from './session-store';

/**
 * 세션 저장 차등 시험(ADR-203, 4f B1b)의 생성기. 제품 코드는 쓰지 않는다.
 * B1a의 `session-record.test.ts`와 같은 꼴(시드 있는 난수, 짝 없는 서로게이트, 예약 글자, NUL 키, NaN·Infinity·-0, 큰 이벤트)에 저장 상태와 닫기 시험용 이벤트를 더했다.
 */

export const as = (event: unknown): StudioEvent => event as StudioEvent;

/** 시드 있는 난수(mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

export const WEIRD_TEXTS = [
  'plain',
  '한글 요청',
  '짝 없는 앞 서로게이트 \ud83d 뒤',
  '짝 없는 뒤 서로게이트 \ude00 앞',
  '짝 있는 😀',
  '예약 글자  끝',
  '예약 모양  과 ',
  '제어 \u0000\u0001\n\t"\\ 글자',
  '  ',
  '',
];

const TYPES = ['login', 'logs', 'Log', 'log ', 'usage2', 'USAGE', 'run_finished', 'run_started_x', 'notice', 'status', 'service', 'snapshot', 'agent', 'checkpoint', 'chat', 'restored', 'boot_network', 'model'];
const TRANSIENT = ['usage', 'sandbox_link', 'files_changed', 'tests_changed', 'deploy_log', 'label'];
const NUMBERS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0, 1.5e300, 1e21, 1e-7, 123456789012345680000, 0.1, -5];

/** 이벤트 하나. 종류와 안의 값이 섞인다 */
export function randomEvent(random: () => number, index: number, options: { big?: boolean } = {}): StudioEvent {
  const roll = random();
  const text = pick(random, WEIRD_TEXTS);
  if (roll < 0.15) return as({ type: 'log', service: pick(random, ['web', 'api']), text: `${text} ${index}`, at: '2026-01-01T00:00:00.000Z' });
  if (roll < 0.22) return as({ type: pick(random, TRANSIENT), index, text });
  if (roll < 0.3) return as({ type: 'run_started', runId: `r${index}`, request: `${text} #${index}`, at: '2026-01-01T00:00:00.000Z' });
  if (roll < 0.34) return as({ type: pick(random, [5, null, true, undefined, ['log'], { type: 'log' }]), index });
  if (roll < 0.44) return as({ type: 'agent', runId: 'r', event: { type: 'tokens', value: pick(random, NUMBERS), list: [pick(random, NUMBERS), text] } });
  if (roll < 0.54) {
    return as({
      type: 'agent',
      runId: 'r',
      args: { '\u0000k': 1, '\u0000nfx': 2, '\u0000nf': pick(random, ['NaN', '-0', 'x', 'Infinity']), 'a\ud800b': text, nested: { '\u0000nf': 'NaN' }, ...(random() < 0.5 ? { [text]: index } : {}) },
    });
  }
  if (roll < 0.58) return as({ type: 'agent', runId: 'r', args: { '5': 1, '2': 2, b: 3, [`\u0000${index % 7}`]: 4 } });
  if (options.big && roll < 0.7) return as({ type: 'agent', runId: 'r', event: { type: 'tool_result', id: `t${index}`, content: `${text}${'x'.repeat(20_000)}${text}` } });
  return as({ type: pick(random, TYPES), index, text, nested: { list: [text, index, null, true], at: '2026-01-01T00:00:00.000Z' } });
}

/** 저장 상태(history 제외). 선택 필드가 있고 없고, 글자에 이상한 글자가 든다 */
export function randomBody(random: () => number, workDir: string, seed: number): PersistedBody {
  const text = pick(random, WEIRD_TEXTS);
  const body = {
    version: 1,
    savedAt: `2026-11-16T00:00:${String(seed % 60).padStart(2, '0')}.000Z`,
    owner: { pid: 4000 + seed },
    snapshot: { id: `s${seed}`, projectId: 'orders', projectName: text, workDir, status: 'ready', mode: 'demo', running: true, services: [], checkpoints: [], note: random() < 0.5 ? undefined : pick(random, NUMBERS) },
    conversation: [{ role: 'user', content: text }, { n: pick(random, NUMBERS) }],
    demoIndex: seed % 5,
    claudeCode: { notes: [text], ...(random() < 0.5 ? { sessionId: 'abc' } : {}) },
    design: random() < 0.5 ? undefined : { fileUrl: 'https://x', fileKey: 'k' },
    codex: random() < 0.5 ? undefined : { notes: [], recent: [] },
    commandCode: undefined,
    openCode: undefined,
    gemini: { notes: [] },
    sourceDirtyFiles: seed % 3,
    ...(random() < 0.5 ? { agentLedger: { main: [text] } } : {}),
    ...(random() < 0.5 ? { terminalConversation: { id: text } } : {}),
    sandbox: { id: `studio-orders-${seed}`, provider: 'local-docker' },
    previewToken: random() < 0.5 ? undefined : 'tok',
    git: random() < 0.5 ? undefined : { branch: 'b', lastCheckpoint: 'a'.repeat(40) },
  };
  return body as unknown as PersistedBody;
}
