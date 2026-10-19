import { describe, expect, it } from 'vitest';
import { startFailureHint, summarizeFailure } from './start-failure';

// 세션 화면에서 실제로 본 오류 문장(이슈 #718의 캡처). 끊기지 않는 긴 URL이 들어 있다
const TURBOPACK_EMFILE = [
  '앱이 켜지다가 종료됐습니다 (컨테이너 exited)',
  '앱 로그 마지막 줄:',
  'FATAL: An unexpected Turbopack error occurred. A panic log has been written to /tmp/next-panic-78016f5511c8b57d7d82b75ccedfe708.log.',
  'https://bugs.nextjs.org/search?category=turbopack-error-report&title=Turbopack%20Error%3A%20Too%20many%20open%20files%20%28os%20error%2024%29&body=Turbopack%20version%3A%20%60299180d3%60',
  'Error [TurbopackInternalError]: Too many open files (os error 24)',
  ' ELIFECYCLE  Command failed with exit code 1.',
].join('\n');

const GRADLEW_ENOENT = [
  '앱이 켜지다가 종료됐습니다 (컨테이너 exited)',
  '앱 로그 마지막 줄:',
  '/__cacert_entrypoint.sh: line 123: /app/gradlew: No such file or directory',
].join('\n');

describe('시작 실패의 원인과 조치 한 줄 (#718)', () => {
  it('파일 한도(EMFILE, Too many open files)는 Docker VM의 파일 감시 한도를 올리라고 안내한다', () => {
    const hint = startFailureHint(TURBOPACK_EMFILE);
    expect(hint?.cause).toContain('파일');
    expect(hint?.action).toContain('fs.inotify.max_user_instances');
    expect(hint?.action).toContain('다시 시작');

    expect(startFailureHint("Error: EMFILE: too many open files, watch '/app/src'")?.action).toContain('fs.inotify.max_user_instances');
  });

  it('컨테이너 안에서 파일이 없고 프로젝트가 홈 폴더 밖에 있으면 Docker VM이 폴더를 마운트하지 못했을 수 있다고 알린다', () => {
    const hint = startFailureHint(GRADLEW_ENOENT, { workDir: '/private/tmp/orders-s1' });
    expect(hint?.action).toContain('Docker VM이 이 폴더를 마운트하지 못했을 수 있습니다');
    expect(hint?.action).toContain('홈 폴더');

    expect(startFailureHint("Error: ENOENT: no such file or directory, open '/app/package.json'", { workDir: '/tmp/x' })?.action).toContain('마운트하지 못했을 수');
  });

  it('홈 폴더 안의 프로젝트에서 파일이 없으면 먼저 파일이 있는지 보라고 하고 마운트는 가능성으로만 적는다', () => {
    const hint = startFailureHint(GRADLEW_ENOENT, { workDir: '/Users/kim/projects/orders' });
    expect(hint?.action).toContain('프로젝트에 있는지');
    expect(hint?.action).not.toContain('홈 폴더 아래로');
  });

  it('알려진 꼴이 아니면 짐작하지 않는다', () => {
    expect(startFailureHint('이미지 빌드 실패')).toBeUndefined();
    expect(startFailureHint('')).toBeUndefined();
  });

  it('문구에 내부 문서 번호나 문장 안의 줄표를 넣지 않는다', () => {
    for (const hint of [startFailureHint(TURBOPACK_EMFILE), startFailureHint(GRADLEW_ENOENT, { workDir: '/private/tmp/a' }), startFailureHint(GRADLEW_ENOENT, { workDir: '/Users/a/b' })]) {
      const text = `${hint?.cause} ${hint?.action}`;
      expect(text).not.toMatch(/ADR-\d+/);
      expect(text).not.toContain('—');
    }
  });
});

describe('오류 원문의 요약 (#718)', () => {
  it('여러 줄 오류는 첫 줄만 요약으로 쓰고 나머지는 펼쳐 보게 한다', () => {
    const { summary, truncated } = summarizeFailure(TURBOPACK_EMFILE);
    expect(summary).toBe('앱이 켜지다가 종료됐습니다 (컨테이너 exited)');
    expect(truncated).toBe(true);
  });

  it('한 줄이라도 길면 잘라서 말줄임표를 붙인다', () => {
    const long = `요청이 실패했습니다: ${'https://bugs.nextjs.org/search?'.padEnd(400, 'x')}`;
    const { summary, truncated } = summarizeFailure(long, 120);
    expect(summary.length).toBeLessThanOrEqual(121);
    expect(summary.endsWith('…')).toBe(true);
    expect(truncated).toBe(true);
  });

  it('짧은 한 줄은 그대로 두고 펼칠 것이 없다고 알린다', () => {
    expect(summarizeFailure('  이미지 빌드 실패  ')).toEqual({ summary: '이미지 빌드 실패', truncated: false });
  });
});
