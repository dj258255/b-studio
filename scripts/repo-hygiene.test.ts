import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * 확인용으로 잠깐 만든 파일(`.tmp-*`)이 커밋에 섞여 들어온 적이 있다(#998). 저장소가 추적하는 파일 목록에서 찾는다.
 * 작업 폴더를 훑지 않고 git의 목록을 읽어, 무시된 산출물이나 다른 사람의 임시 파일은 세지 않는다
 */
describe('저장소가 추적하는 파일', () => {
  it('임시 파일(.tmp로 시작하는 이름)이 없다', () => {
    // 하위 폴더에서 부른 ls-files는 그 폴더 아래만 나열한다 — 저장소 루트에서 부른다
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0);
    const temporary = tracked.filter((file) => /(^|\/)\.tmp[^/]*$/.test(file));
    expect(temporary).toEqual([]);
  });
});
