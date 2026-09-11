import { describe, expect, it } from 'vitest';
import { highlightLines, highlightStyleRules, languageFor, parsePatch, SUPPORTED_LANGUAGES } from './highlight';

describe('languageFor', () => {
  it('확장자와 파일 이름으로 언어를 고르고, 모르는 파일은 평문으로 둔다', () => {
    expect(languageFor('web/app/orders/page.tsx')).toBe('tsx');
    expect(languageFor('api/src/main/java/com/example/api/orders/OrderController.java')).toBe('java');
    expect(languageFor('api/build.gradle.kts')).toBe('kotlin');
    expect(languageFor('api/build.gradle')).toBe('groovy');
    expect(languageFor('api/src/main/resources/db/migration/V1__create_orders.sql')).toBe('sql');
    expect(languageFor('web/Dockerfile')).toBe('docker');
    expect(languageFor('Dockerfile.dev')).toBe('docker');
    expect(languageFor('.env.example')).toBe('dotenv');
    expect(languageFor('studio.yaml')).toBe('yaml');
    expect(languageFor('LICENSE')).toBeUndefined();
    expect(languageFor('web/public/logo.png')).toBeUndefined();
  });
});

describe('highlightLines', () => {
  it('지원하는 언어는 모두 WASM 없이 불러오고, 줄마다 밝은·어두운 테마 색을 붙인다', async () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(await highlightLines('value = 1\nnext', lang), lang).toHaveLength(2);
    }
    const [line] = (await highlightLines('const answer = 42;', 'typescript'))!;
    expect(line!.map((token) => token.content).join('')).toBe('const answer = 42;');
    const className = line![0]!.className!;
    expect(className).toMatch(/^shiki-\d+$/);
    expect(highlightStyleRules()).toContainEqual(expect.stringMatching(new RegExp(`^\\.${className}\\{--shiki-light:#[0-9A-Fa-f]{6};--shiki-dark:#[0-9A-Fa-f]{6}\\}$`)));
  });

  it('색이 같은 이웃 토큰과 공백 토큰을 합쳐 그릴 요소 수를 줄이고, 내용은 그대로 둔다', async () => {
    const code = 'export const row0 = { id: 0, label: "item 0", enabled: true }; // row 0';
    const [line] = (await highlightLines(code, 'tsx'))!;

    expect(line!.map((token) => token.content).join('')).toBe(code);
    // 합치기 전 Shiki는 이 줄을 15개 토큰으로 나눈다
    expect(line!.length).toBeLessThan(15);
    for (let index = 1; index < line!.length; index++) {
      expect(line![index]!.className).not.toBe(line![index - 1]!.className);
    }
  });

  it('모르는 언어는 평문으로 둔다', async () => {
    expect(await highlightLines('x', undefined)).toBeUndefined();
    expect(await highlightLines('x', 'cobol')).toBeUndefined();
  });

  it('조각으로 나눠 강조해도 한 번에 강조한 것과 같고, 조각을 끝낼 때마다 진행 상황을 알린다', async () => {
    const code = ['const a = 1;', '/* 주석이', '조각 경계를 넘는다 */', 'const text = `첫 줄', '둘째 줄`;', 'export default a;'].join('\n');
    const progress: number[] = [];

    const chunked = await highlightLines(code, 'tsx', { linesPerChunk: 2, onProgress: (lines) => progress.push(lines.length) });
    const whole = await highlightLines(code, 'tsx', { linesPerChunk: 100 });

    expect(chunked).toEqual(whole);
    expect(progress).toEqual([2, 4, 6]);
  });

  it('파일이 바뀌어 중단하면 남은 조각을 강조하지 않는다', async () => {
    const controller = new AbortController();
    const progress: number[] = [];

    await expect(
      highlightLines('a\nb\nc\nd', 'typescript', {
        linesPerChunk: 1,
        signal: controller.signal,
        onProgress: (lines) => {
          progress.push(lines.length);
          controller.abort();
        },
      }),
    ).rejects.toThrow();
    expect(progress).toEqual([1]);
  });

  it('압축한 코드처럼 아주 긴 줄은 토큰화하지 않고 한 덩어리로 둔다', async () => {
    const long = `const value = "${'x'.repeat(3_000)}";`;
    const [line] = (await highlightLines(long, 'typescript'))!;
    expect(line!.map((token) => token.content).join('')).toBe(long);
    expect(line).toHaveLength(1);
  });
});

describe('parsePatch', () => {
  it('파일마다 바꾸기 전과 바꾼 뒤 코드를 모으고, 훙크 안의 "---"는 삭제한 줄로 본다', () => {
    const patch = [
      'diff --git a/api/V1.sql b/api/V1.sql',
      'index 1111111..2222222 100644',
      '--- a/api/V1.sql',
      '+++ b/api/V1.sql',
      '@@ -1,3 +1,3 @@',
      ' create table orders (',
      '--- 오래된 주석',
      '+-- 새 주석',
      ' );',
      '\\ No newline at end of file',
      'diff --git a/web/page.tsx b/web/page.tsx',
      'new file mode 100644',
      '@@ -0,0 +1 @@',
      '+export default function Page() {}',
      '',
    ].join('\n');

    const { lines, files } = parsePatch(patch);

    expect(files).toEqual([
      { path: 'api/V1.sql', before: ['create table orders (', '-- 오래된 주석', ');'], after: ['create table orders (', '-- 새 주석', ');'] },
      { path: 'web/page.tsx', before: [], after: ['export default function Page() {}'] },
    ]);
    expect(lines.map((line) => line.kind)).toEqual([
      'file',
      'meta',
      'meta',
      'meta',
      'hunk',
      'context',
      'removed',
      'added',
      'context',
      'other',
      'file',
      'meta',
      'hunk',
      'added',
      'other',
    ]);
    expect(lines[6]).toMatchObject({ file: 0, index: 1 });
    expect(lines[8]).toMatchObject({ file: 0, index: 2 });
    expect(lines[13]).toMatchObject({ file: 1, index: 0 });
  });
});
