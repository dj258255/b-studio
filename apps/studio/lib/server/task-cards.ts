import { isProtectedPath } from '@b-studio/agent';
import { z } from 'zod';
import { StudioError } from './errors';

/** 사람이 쓴 작업 카드 하나. b-studio가 레인으로 묶어 터미널 레인에서 돌린다 */
export interface TaskCardInput {
  title: string;
  request: string;
  paths: string[];
  /** 이 카드의 완료 조건 명령(선택). 있으면 그 카드의 실행 동안 게이트의 test 단계에 더한다 */
  doneCommand?: string;
  /** 완료 조건을 돌릴 서비스(선택). 없으면 이 프로젝트의 첫 관리형 서비스를 쓴다 */
  doneService?: string;
}

/** 카드 하나의 완료 검사. gate의 workflow.tests에 넣을 test 하나의 꼴 */
export interface TaskCardDone {
  name: string;
  service: string;
  command: string[];
}

const CardSchema = z
  .object({
    title: z.string().min(1).max(80),
    request: z.string().min(1).max(4_000),
    // 형식(상대 경로인지)은 planLanes가 TaskPlanSchema로 본다. 여기서는 개수만 막는다
    paths: z.array(z.string().min(1)).min(1).max(8),
    doneCommand: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => !/[\r\n]/.test(value), '한 줄이어야 합니다')
      .optional(),
    doneService: z.string().min(1).optional(),
  })
  .strict();

interface CardTask {
  id: string;
  title: string;
  request: string;
  paths: string[];
  dependsOn: string[];
}

/** 두 카드의 쓰기 범위가 겹치는가. planLanes가 병렬 레인의 겹침을 보는 것과 같은 함수를 쓴다 */
function overlaps(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => isProtectedPath(a, b) || isProtectedPath(b, a)));
}

/**
 * 카드들을 planLanes가 받는 계획(tasks)과 카드별 완료 검사로 바꾼다. 형식이 틀리면 StudioError(400).
 *  - 작업 id는 카드 순서대로 card-1, card-2, …
 *  - 앞선 카드와 쓰기 범위가 겹치는 카드는 그 카드들 모두에 의존한다 → planLanes가 한 레인에 카드 순서대로 묶는다
 *  - doneCommand가 있으면 그 카드의 완료 검사를 만든다(['sh','-c', 명령])
 */
export function cardsToPlan(cards: unknown, services: readonly string[]): { plan: { tasks: CardTask[] }; done: Record<string, TaskCardDone> } {
  const parsed = z.array(CardSchema).min(1).safeParse(cards);
  if (!parsed.success) {
    throw new StudioError(400, `작업 카드 형식이 올바르지 않습니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  const list = parsed.data;
  const tasks: CardTask[] = list.map((card, index) => ({ id: `card-${index + 1}`, title: card.title, request: card.request, paths: card.paths, dependsOn: [] }));
  // 겹치는 쓰기 범위의 카드는 순서대로 돈다: 카드 j는 앞선 카드 i 중 겹치는 것 모두에 의존한다
  for (let j = 0; j < list.length; j++) {
    for (let i = 0; i < j; i++) {
      if (overlaps(list[i]!.paths, list[j]!.paths)) tasks[j]!.dependsOn.push(tasks[i]!.id);
    }
  }
  const done: Record<string, TaskCardDone> = {};
  for (const [index, card] of list.entries()) {
    if (card.doneCommand === undefined) continue;
    const task = tasks[index]!;
    const service = card.doneService ?? services[0];
    if (service === undefined) {
      throw new StudioError(400, `완료 조건을 돌릴 서비스가 없습니다: 이 프로젝트에는 관리형 서비스가 없습니다`);
    }
    if (!services.includes(service)) {
      throw new StudioError(400, `완료 조건의 서비스를 찾을 수 없습니다: ${service} (이 프로젝트의 서비스: ${services.join(', ') || '없음'})`);
    }
    done[task.id] = { name: `done-${task.id}`, service, command: ['sh', '-c', card.doneCommand] };
  }
  return { plan: { tasks }, done };
}
