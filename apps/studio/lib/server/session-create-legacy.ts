/**
 * 옛 `startSession`의 순서(ADR-206, 4f B2c 앞의 구현). 차등 시험의 기준으로만 남아 있고 4g에서 지운다.
 * 옛 구현은 단계를 이 순서로 한 번씩 부르고, 어느 단계가 던지면 거기서 멈추고 **아무것도 치우지 않고** 그 오류를 그대로 던졌다.
 * (세션 폴더는 `mkdir(dirname, { recursive: true })`로 부모만 만들고 복제·복사가 대상 폴더를 만들었다. 그래서 단계 목록에 `make_home`이 없다.)
 */
export const LEGACY_CREATE_STEPS = [
  'validate_start',
  'prepare_workdir',
  'load_project',
  'check_backend_ready',
  'describe_repository',
  'select_services',
  'prepare_evaluation_assets',
  'create_sandbox',
  'register_session',
  'remember_git',
  'start_gateway',
  'begin_boot',
] as const;

export type LegacyCreateStep = (typeof LEGACY_CREATE_STEPS)[number];

export async function legacyCreate(actions: Record<LegacyCreateStep, () => void | Promise<void>>): Promise<void> {
  for (const step of LEGACY_CREATE_STEPS) await actions[step]();
}
