import { native } from '@b-studio/sandbox';
import { StudioError } from './errors';

/**
 * 세션을 만드는 순서와, 만들다 실패했을 때 만든 것을 치우는 순서(ADR-206, 4f B2c). 순서와 실패 처리는 Rust `crates/bstudio-session`의 `create`가 정하고,
 * 여기는 단계마다 부수 효과(복제·프로젝트 읽기·로그인 확인·샌드박스 만들기)를 TS 콜백으로 잇는 껍데기다. 옛 순서는 지웠다(#1347).
 *
 * 세션 폴더(`make_home`)는 코어가 **배타적으로** 만들고(이미 있으면 만들지 않고 실패한다), 실패하면 이 호출이 만든 폴더만 B2a의 `removeSessionHome`과 같은 확인을 지나 지운다.
 * 샌드박스·맵·레지스트리는 단계가 끝난 만큼만 거꾸로 치운다. 치우기가 실패해도 원래 오류를 던지고, 치우기 오류는 `log`로 남긴다.
 */

/** 만들기의 단계 이름. 순서는 Rust `CREATE_STEPS`가 정한다. `make_home`은 코어가 직접 하므로 콜백이 없다 */
export type CreateStep =
  | 'validate_start'
  | 'make_home'
  | 'prepare_workdir'
  | 'load_project'
  | 'check_backend_ready'
  | 'describe_repository'
  | 'select_services'
  | 'prepare_evaluation_assets'
  | 'create_sandbox'
  | 'register_session'
  | 'remember_git'
  | 'start_gateway'
  | 'begin_boot';

/** 치우기 콜백 이름. 세션 폴더 지우기(`remove_home`)는 코어가 직접 한다 */
export type CreateUndo = 'destroy_sandbox' | 'unregister_session';

export type CreateActions = Record<Exclude<CreateStep, 'make_home'>, () => void | Promise<void>> & Record<CreateUndo, () => void | Promise<void>>;

export interface CreatePaths {
  /** 세션 저장소 */
  root: string;
  /** 만들 세션 폴더(`<root>/<프로젝트>-<id>`) */
  home: string;
  sessionId: string;
  /** 내 폴더 세션의 사용자 폴더. 이 폴더는 치우기가 건드리지 않는다 */
  userDir?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 만든다. 실패하면 치운 뒤 **원래 오류 객체**를 그대로 던진다(코어가 직접 만드는 세션 폴더의 실패만 `StudioError`(500)로 감싼다).
 * 콜백은 던지지 않고 이유를 돌려준다(Rust가 부르는 콜백이 던지면 Node가 경고한다, 트러블슈팅 210)
 */
export async function runCreate(paths: CreatePaths, actions: CreateActions, log: (message: string, undoErrors: ReadonlyArray<{ name: string; message: string }>) => void): Promise<void> {
  const errors = new Map<string, unknown>();
  const result = await native.createSessionRun({ root: paths.root, home: paths.home, sessionId: paths.sessionId, userDir: paths.userDir }, async (name) => {
    try {
      const action = (actions as Record<string, (() => void | Promise<void>) | undefined>)[name];
      if (!action) throw new Error(`알 수 없는 만들기 단계입니다: ${name}`);
      await action();
      return null;
    } catch (error) {
      errors.set(name, error);
      return describeError(error);
    }
  });
  if (result.undoErrors.length > 0) log(`세션 ${paths.sessionId}를 만들다 실패해 치우는 중에도 실패한 것이 있습니다`, result.undoErrors);
  if (result.ok) return;
  const step = result.step ?? '';
  if (step === 'make_home') throw new StudioError(500, result.message ?? '세션 폴더를 만들지 못했습니다');
  throw errors.get(step) ?? new Error(result.message ?? '세션을 만들지 못했습니다');
}
