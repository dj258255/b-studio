import { run } from './cli-exec';
import { cliPreflightFailure, type CliPreflightFailure } from './cli-failure';

/** 실제 실행할 CLI. 이 PC에 로그인돼 있는 `cmd`를 그대로 쓴다 */
export const COMMAND = 'cmd';

/**
 * 샌드박스를 띄우기 전에 이 PC의 Command Code CLI가 로그인돼 있는지 확인한다.
 * `cmd status`만 부르므로 모델 호출도, 사용량도 쓰지 않는다. 토큰·계정 정보는 읽지 않는다.
 * (0단계 실측: 로그인 상태면 종료 코드 0, 아니면 1)
 */
export async function preflightCommandCode(
  { command = COMMAND, timeoutMs = 60_000 }: { command?: string; timeoutMs?: number } = {},
): Promise<{ ok: true } | CliPreflightFailure> {
  try {
    await run(command, ['status'], timeoutMs);
    return { ok: true };
  } catch (error) {
    return cliPreflightFailure(`Command Code CLI에 로그인돼 있지 않습니다. 터미널에서 "${command}"를 실행해 로그인하세요.`, error);
  }
}

export interface CommandCodeModel {
  id: string;
  description: string;
  group: string;
  free: boolean;
  isDefault: boolean;
}

/** `cmd --list-models` 텍스트를 파싱한다. 그룹 헤더와 `id  설명` 줄만 골라낸다(순수 함수). 같은 id가 여러 그룹에 나오면 첫 줄을 남기고, Decision models 그룹은 뺀다 */
export function parseCommandCodeModels(text: string): CommandCodeModel[] {
  const models = new Map<string, CommandCodeModel>();
  let group = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    // 첫 줄·꼬리말·사용 예시는 모델이 아니다
    if (line.startsWith('Available models')) continue;
    if (line.startsWith('Docs:')) continue;
    if (line.startsWith('cmd ')) continue;
    if (line.includes('Pass the full id')) continue;
    const match = /^(\S+)\s{2,}(.+)$/.exec(line);
    if (!match) {
      group = line.trim();
      continue;
    }
    const id = match[1]!;
    const description = match[2]!.trim();
    // Decision models(예: typesafe/jev)은 채팅·도구 호출 모델이 아니라 헤드리스 전용이라 목록에서 뺀다
    if (group.startsWith('Decision models')) continue;
    if (!models.has(id)) {
      models.set(id, { id, description, group, free: description.startsWith('FREE') || id.includes(':free') || group === 'Stealth', isDefault: /\(default\)$/.test(description) });
    }
  }
  return [...models.values()];
}

/** 이 PC에서 쓸 수 있는 모델 목록. `cmd --list-models` 텍스트를 파싱한다(모델 호출 없음) */
export async function listCommandCodeModels({ command = COMMAND, timeoutMs = 60_000 }: { command?: string; timeoutMs?: number } = {}): Promise<CommandCodeModel[]> {
  return parseCommandCodeModels(await run(command, ['--list-models'], timeoutMs));
}
