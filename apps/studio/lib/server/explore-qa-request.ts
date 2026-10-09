import { z } from 'zod';

const GOAL_MAX = 500;
const PATH_MAX = 300;

const startSchema = z.object({
  action: z.literal('start'),
  service: z.string().min(1).max(63),
  goal: z.string().min(1).max(GOAL_MAX),
  startPath: z.string().min(1).max(PATH_MAX),
  confirmText: z.string().min(1).max(GOAL_MAX).optional(),
  maxActions: z.number().int().min(1).max(60).optional(),
  maxMs: z.number().int().min(10_000).max(15 * 60_000).optional(),
});

/** action 값으로 갈래를 먼저 고른다. 합집합(z.union)은 어느 갈래에서 틀렸는지 잃고 "Invalid input"만 남긴다 */
const requestSchema = z.discriminatedUnion('action', [startSchema, z.object({ action: z.literal('stop') }), z.object({ action: z.literal('save'), service: z.string().min(1).max(63) })]);

export type ExploreQaRequest = z.infer<typeof requestSchema>;

const ACTIONS = ['start', 'stop', 'save'];

/** 어느 필드가 왜 틀렸는지 한 줄로 만든다(예: `startPath: 필수 항목입니다`) */
export function describeExploreQaRequestIssues(error: z.ZodError): string {
  const raw = error.issues[0];
  if (!raw) return '형식 오류';
  const field = raw.path.length > 0 ? raw.path.join('.') : '요청 본문';
  if (raw.code === 'invalid_union' && raw.path[0] === 'action') return `action: ${ACTIONS.join('·')} 중 하나여야 합니다`;
  if (raw.code === 'invalid_type' && String((raw as { input?: unknown }).input) === 'undefined') return `${field}: 필수 항목입니다`;
  if (raw.code === 'invalid_type') return `${field}: 형식이 맞지 않습니다(${raw.message})`;
  return `${field}: ${raw.message}`;
}

/** 본문을 검사해 데이터 또는 어느 필드가 틀렸는지 알려 주는 문구를 돌려준다 */
export function parseExploreQaRequest(body: unknown): { ok: true; data: ExploreQaRequest } | { ok: false; message: string } {
  const parsed = requestSchema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, message: `탐색형 QA 요청이 올바르지 않습니다: ${describeExploreQaRequestIssues(parsed.error)}` };
}
