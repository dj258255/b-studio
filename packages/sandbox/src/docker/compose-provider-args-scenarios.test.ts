import { describe, expect, it } from 'vitest';
import * as now from './compose-provider';

/**
 * compose-provider의 인자 조립과 오류 글(ADR-195 4f A4c-4) 시험. 새 껍데기(Rust, crates/bstudio-guard/src/compose_args.rs)가 만든 docker 인자 배열과 오류 글을 본다.
 * 옛 TS 사본과 경계값을 견주던 시험(#1347에서 사본을 지웠다)에서, 대표 입력의 기대값은 옛 TS가 낸 값을 지우기 전에 한 번 재어 아래에 적었다.
 */

describe('compose 인자 조립: 대표 입력의 고정 기대값(옛 TS가 낸 값)', () => {
  it('composeCommandArgs: 하위 명령 앞에 붙는 compose 인자', () => {
    expect(now.composeCommandArgs('studio-p', '/proj', '/proj/compose.yaml', '/w/override.yaml', ['up', '--detach'])).toEqual([
      'compose', '--project-name', 'studio-p', '--project-directory', '/proj', '--file', '/proj/compose.yaml', '--file', '/w/override.yaml', 'up', '--detach',
    ]);
  });

  it('composeCommandArgs: 따옴표·공백·개행·빈 값도 문자열로 잇지 않고 그대로 인자로 넘긴다', () => {
    expect(now.composeCommandArgs("a'b", '', 'x y', '\n', ['', '--'])).toEqual([
      'compose', '--project-name', "a'b", '--project-directory', '', '--file', 'x y', '--file', '\n', '', '--',
    ]);
  });

  it('지우기·서비스·조회 인자', () => {
    expect(now.sandboxCleanupArgs('studio-p')).toEqual(['compose', '--project-name', 'studio-p', 'down', '--volumes', '--remove-orphans', '--rmi', 'local']);
    expect(now.serviceRunningArgs('web', true)).toEqual(['up', '--detach', '--build', '--no-deps', 'web']);
    expect(now.serviceRunningArgs('web', false)).toEqual(['stop', 'web']);
    expect(now.serviceRecreateArgs('web')).toEqual(['up', '--detach', '--build', '--no-deps', '--force-recreate', 'web']);
    expect(now.composePsArgs('web')).toEqual(['ps', '--all', '--format', 'json', 'web']);
  });

  it('edgePortArgs: JS 수 표기(String)를 그대로 옮긴다', () => {
    expect(now.edgePortArgs('edge', String(80))).toEqual(['port', 'edge', '80']);
    expect(now.edgePortArgs('edge', String(1e21))).toEqual(['port', 'edge', '1e+21']);
  });

  it('composeLogsArgs: 따라가기·tail 표기·서비스 순서', () => {
    expect(now.composeLogsArgs(['web', 'api'], true, String(200))).toEqual(['logs', '--follow', '--no-color', '--timestamps', '--tail', '200', 'web', 'api']);
    expect(now.composeLogsArgs([], false, String(1.5))).toEqual(['logs', '--no-color', '--timestamps', '--tail', '1.5']);
  });

  it('composeExecArgs: 명령을 문자열로 잇지 않고 인자로 넘긴다', () => {
    expect(now.composeExecArgs('web', ['sh', '-c', 'echo hi'])).toEqual(['exec', '-T', 'web', 'sh', '-c', 'echo hi']);
  });

  it('sandboxBuildArgs·composeUpRemoveOrphansArgs', () => {
    expect(now.sandboxBuildArgs(true, undefined)).toEqual(['build', '--no-cache']);
    expect(now.sandboxBuildArgs(false, ['web', 'api'])).toEqual(['build', 'web', 'api']);
    expect(now.composeUpRemoveOrphansArgs(['up', '--detach', '--no-deps', 'web'])).toEqual(['up', '--detach', '--remove-orphans', 'up', '--detach', '--no-deps', 'web']);
  });
});

describe('오류 글은 바이트까지 옛 글과 같다(옛 TS가 낸 값)', () => {
  it('compose 오류 글', () => {
    expect(now.composeFailureMessage('up', 'studio-p')).toBe('docker compose up 실패 (studio-p)');
    expect(now.composeServiceRequiredMessage('web', 'studio-p')).toBe("'web'은(는) 이 프로젝트의 compose 서비스가 아닙니다 (studio-p)");
    expect(now.managedServiceRequiredMessage('web')).toBe("'web'은(는) 이 프로젝트의 managed 서비스가 아닙니다");
    expect(now.readinessStoppedMessage('web')).toBe('web 서비스가 준비에 실패해 확인을 멈췄습니다');
    expect(now.composeConfigUnreadableMessage('web')).toBe('compose 설정을 읽지 못했습니다 (web)');
  });
});

describe('의도한 차이', () => {
  it('짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다. docker에 넘기는 argv 바이트는 옛 쪽과 같다(Node의 UTF-8 인코딩도 같은 치환을 한다)', () => {
    const command = ['a\ud83d', '\ude00b', '😀'];
    // 옛 쪽은 글자를 그대로 두었다
    const old = ['exec', '-T', 'web', ...command];
    const fresh = now.composeExecArgs('web', command);
    // 짝을 이룬 😀는 그대로이고, 짝이 없는 단위만 U+FFFD가 된다
    expect(fresh).toEqual(['exec', '-T', 'web', 'a�', '�b', '😀']);
    // 배열 글자는 다르지만 docker가 받는 바이트는 같다
    expect(fresh.map((part) => Buffer.from(part, 'utf8'))).toEqual(old.map((part) => Buffer.from(part, 'utf8')));
  });

  it('오류 글에 든 짝 없는 서로게이트는 U+FFFD로 바뀐다(글자를 화면에 쓸 때 Node도 같은 치환을 한다)', () => {
    const name = 'we\ud83db';
    const old = `'${name}'은(는) 이 프로젝트의 managed 서비스가 아닙니다`;
    const fresh = now.managedServiceRequiredMessage(name);
    expect(fresh).toBe(old.replace('\ud83d', '�'));
    expect(Buffer.from(fresh, 'utf8')).toEqual(Buffer.from(old, 'utf8'));
  });
});
