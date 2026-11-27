import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointStore } from './checkpoints';
import { reviewChanges, type TestChangeEntry, type WorkflowCheck } from './workflow';

vi.setConfig({ testTimeout: 30_000 });

const execFileAsync = promisify(execFile);

/**
 * 시험 약화 검사를 넓힌 네 길(이슈 #1451): 시험 설정으로 빼기, package.json의 test 스크립트 약하게 바꾸기, 스냅샷 지우기, 단언을 더한 것보다 많이 지우기.
 * 실제 git 저장소에서 `pendingTestChanges`로 읽어 `reviewChanges`(Rust 판정)에 넣는다. 정당한 변경(별칭·플러그인 더하기, 단언 바꾸기)은 통과해야 한다.
 */

const project = { spec: { name: 'x' } } as unknown as LoadedProject;

function review(entries: TestChangeEntry[], extra: { allowed?: boolean; incomplete?: string } = {}): WorkflowCheck | undefined {
  return reviewChanges(project, [], [], { entries, ...extra }).find((check) => check.name === 'test-weakening');
}

describe('시험 약화 검사: 설정·스크립트·스냅샷·단언', () => {
  let root: string;
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'test-weakening-config-'));
    const globalConfig = path.join(root, '..', `${path.basename(root)}.gitconfig`);
    await writeFile(globalConfig, '');
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['GIT_CONFIG_GLOBAL', saved.global],
      ['GIT_CONFIG_NOSYSTEM', saved.nosystem],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const write = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };

  async function started(files: Record<string, string>): Promise<CheckpointStore> {
    for (const [file, content] of Object.entries(files)) await write(file, content);
    const store = new CheckpointStore(root);
    await store.init();
    return store;
  }

  /** 바꾼 뒤의 검사 결과. 통과면 undefined */
  async function verdict(store: CheckpointStore, extra: { allowed?: boolean } = {}): Promise<WorkflowCheck | undefined> {
    return review(await store.pendingTestChanges(), extra);
  }

  const VITEST = ['export default {', '  test: {', '    include: ["src/**/*.test.ts"],', '  },', '};', ''].join('\n');
  const VITEST_EXCLUDE = ['export default {', '  test: {', '    exclude: [', '      "node_modules/**",', '      "dist/**",', '    ],', '  },', '};', ''].join('\n');

  describe('길 1: 시험 설정으로 시험 빼기', () => {
    it('vitest 설정에 exclude를 더하면 돌려보낸다', async () => {
      const store = await started({ 'vitest.config.ts': VITEST });
      await write('vitest.config.ts', VITEST.replace('  },\n};', '    exclude: ["src/cart.test.ts"],\n  },\n};'));
      const check = await verdict(store);
      expect(check).toMatchObject({ stage: 'review', ok: false });
      expect(check?.detail).toContain('vitest.config.ts');
      expect(check?.detail).toContain('확인 선언 변경 허용');
    });

    it('이미 있는 exclude 배열에 항목 한 줄만 더해도(배열 안의 줄) 돌려보낸다', async () => {
      const store = await started({ 'vitest.config.ts': VITEST_EXCLUDE });
      await write('vitest.config.ts', VITEST_EXCLUDE.replace('      "dist/**",', '      "dist/**",\n      "src/cart.test.ts",'));
      expect((await verdict(store))?.ok).toBe(false);
    });

    it('jest 설정의 testPathIgnorePatterns·modulePathIgnorePatterns, playwright의 testIgnore를 돌려보낸다', async () => {
      for (const [file, line] of [
        ['jest.config.js', 'module.exports = { testPathIgnorePatterns: ["/cart/"] };\n'],
        ['jest.config.ts', 'export default { modulePathIgnorePatterns: ["<rootDir>/cart"] };\n'],
        ['playwright.config.ts', 'export default { testIgnore: "**/cart.spec.ts" };\n'],
      ] as const) {
        const store = await started({ [file]: 'export default {};\n' });
        await write(file, line);
        expect((await verdict(store))?.ok, file).toBe(false);
        await rm(path.join(root, '.git'), { recursive: true, force: true });
      }
    });

    it('별칭이나 플러그인을 더하는 정당한 설정 변경은 통과한다', async () => {
      const store = await started({ 'vitest.config.ts': VITEST });
      await write(
        'vitest.config.ts',
        ['import react from "@vitejs/plugin-react";', 'export default {', '  plugins: [react()],', '  resolve: { alias: { "@": "/src" } },', '  test: {', '    include: ["src/**/*.test.ts"],', '    environment: "jsdom",', '  },', '};', ''].join('\n'),
      );
      expect(await verdict(store)).toBeUndefined();
    });

    it('pytest 설정의 --ignore·--deselect·-k "not"을 돌려보낸다', async () => {
      for (const addopts of ['-q --ignore=tests/test_cart.py', '-q --deselect tests/test_cart.py::test_a', '-q -k "not cart"', '-q --ignore-glob=tests/slow*']) {
        const store = await started({ 'pytest.ini': '[pytest]\naddopts = -q\n' });
        await write('pytest.ini', `[pytest]\naddopts = ${addopts}\n`);
        expect((await verdict(store))?.ok, addopts).toBe(false);
        await rm(path.join(root, '.git'), { recursive: true, force: true });
      }
    });

    it('pyproject.toml·setup.cfg·tox.ini도 본다. -k 없이 -q나 --maxfail을 더하는 것은 통과한다', async () => {
      const store = await started({ 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n', 'tox.ini': '[testenv]\ncommands = pytest\n' });
      await write('pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-q --maxfail=2 -x"\n');
      expect(await verdict(store)).toBeUndefined();
      await write('tox.ini', '[testenv]\ncommands = pytest --ignore=tests/slow\n');
      expect((await verdict(store))?.detail).toContain('tox.ini');
    });

    it('conftest.py의 collect_ignore와 pytest_collection_modifyitems 안의 건너뛰기를 돌려보낸다', async () => {
      const store = await started({ 'conftest.py': 'import pytest\n' });
      await write('conftest.py', 'import pytest\ncollect_ignore = ["tests/test_cart.py"]\n');
      expect((await verdict(store))?.ok).toBe(false);
      await write('conftest.py', 'import pytest\n\ndef pytest_collection_modifyitems(config, items):\n    for item in items:\n        item.add_marker(pytest.mark.skip(reason="x"))\n');
      expect((await verdict(store))?.ok).toBe(false);
      await write('conftest.py', 'import pytest\n\n@pytest.fixture\ndef client():\n    return 1\n');
      expect(await verdict(store)).toBeUndefined();
    });

    it('Maven surefire의 exclude·skipTests와 Gradle test의 exclude·enabled = false를 돌려보낸다', async () => {
      const POM = '<project>\n  <build>\n    <plugins>\n    </plugins>\n  </build>\n</project>\n';
      for (const snippet of ['<plugin><artifactId>maven-surefire-plugin</artifactId><configuration><skipTests>true</skipTests></configuration></plugin>', '<configuration>\n<excludes>\n<exclude>**/Cart*</exclude>\n</excludes>\n</configuration>', '<properties><maven.test.skip>true</maven.test.skip></properties>']) {
        const store = await started({ 'pom.xml': POM });
        await write('pom.xml', POM.replace('    </plugins>', `${snippet}\n    </plugins>`));
        expect((await verdict(store))?.ok, snippet).toBe(false);
        await rm(path.join(root, '.git'), { recursive: true, force: true });
      }
      const GRADLE = 'plugins { id "java" }\n';
      for (const snippet of ["test {\n    exclude '**/Cart*'\n}", 'tasks.test {\n    enabled = false\n}', 'tasks.withType<Test> { exclude("**/Cart*") }']) {
        for (const name of ['build.gradle', 'build.gradle.kts']) {
          const store = await started({ [name]: GRADLE });
          await write(name, `${GRADLE}${snippet}\n`);
          expect((await verdict(store))?.ok, `${name} ${snippet}`).toBe(false);
          await rm(path.join(root, '.git'), { recursive: true, force: true });
        }
      }
    });

    it('플러그인·의존성을 더하는 정당한 pom·gradle 변경은 통과한다(의존성 exclude 포함)', async () => {
      const store = await started({ 'pom.xml': '<project>\n</project>\n', 'build.gradle': 'plugins { id "java" }\n' });
      await write('pom.xml', '<project>\n<dependencies><dependency><artifactId>junit</artifactId></dependency></dependencies>\n</project>\n');
      await write('build.gradle', "plugins { id \"java\" }\ndependencies {\n    implementation('x:y:1') { exclude group: 'org.slf4j' }\n}\n");
      expect(await verdict(store)).toBeUndefined();
    });

    it('허용이 있으면 통과하고 받아들인 것을 남긴다', async () => {
      const store = await started({ 'vitest.config.ts': VITEST });
      await write('vitest.config.ts', VITEST.replace('  },\n};', '    exclude: ["src/cart.test.ts"],\n  },\n};'));
      const check = await verdict(store, { allowed: true });
      expect(check).toMatchObject({ ok: true });
      expect(check?.detail).toContain('vitest.config.ts');
    });

    it('시험 설정 파일이 아닌 곳의 exclude는 걸리지 않는다', async () => {
      const store = await started({ 'tsconfig.json': '{}\n', 'src/app.ts': 'export const a = 1;\n' });
      await write('tsconfig.json', '{ "exclude": ["dist"] }\n');
      await write('src/app.ts', 'export const a = { exclude: 1 };\n');
      expect(await verdict(store)).toBeUndefined();
    });
  });

  describe('길 2: package.json의 test 스크립트', () => {
    const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => `${JSON.stringify({ name: 'x', scripts, ...extra }, null, 2)}\n`;

    it.each([
      ['비움', ''],
      ['|| true', 'vitest run || true'],
      ['; exit 0', 'vitest run; exit 0'],
      ['|| exit 0', 'jest || exit 0'],
      ['--passWithNoTests', 'vitest run --passWithNoTests'],
      ['echo만', 'echo "tests skipped"'],
      ['echo && exit 0', 'echo skip && exit 0'],
      ['true', 'true'],
      ['--exclude', 'vitest run --exclude src/cart.test.ts'],
      ['--testPathIgnorePatterns', 'jest --testPathIgnorePatterns cart'],
    ])('test 스크립트를 약하게 바꾸면 돌려보낸다: %s', async (_name, value) => {
      const store = await started({ 'package.json': pkg({ test: 'vitest run' }) });
      await write('package.json', pkg({ test: value }));
      const check = await verdict(store);
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('package.json');
    });

    it('test:* 스크립트도 본다. 하위 폴더의 package.json도 본다', async () => {
      const store = await started({ 'package.json': pkg({ test: 'npm run test:unit', 'test:unit': 'vitest run' }), 'web/package.json': pkg({ test: 'vitest run' }) });
      await write('package.json', pkg({ test: 'npm run test:unit', 'test:unit': 'vitest run || true' }));
      expect((await verdict(store))?.ok).toBe(false);
      await write('package.json', pkg({ test: 'npm run test:unit', 'test:unit': 'vitest run' }));
      expect(await verdict(store)).toBeUndefined();
      await write('web/package.json', pkg({ test: 'echo ok' }));
      expect((await verdict(store))?.detail).toContain('web/package.json');
    });

    it('test 스크립트를 지워도 돌려보낸다', async () => {
      const store = await started({ 'package.json': pkg({ test: 'vitest run', lint: 'eslint .' }) });
      await write('package.json', pkg({ lint: 'eslint .' }));
      expect((await verdict(store))?.ok).toBe(false);
    });

    it('jest 절의 testPathIgnorePatterns를 더하면 돌려보낸다', async () => {
      const store = await started({ 'package.json': pkg({ test: 'jest' }, { jest: { testEnvironment: 'node' } }) });
      await write('package.json', pkg({ test: 'jest' }, { jest: { testEnvironment: 'node', testPathIgnorePatterns: ['/cart/'] } }));
      expect((await verdict(store))?.ok).toBe(false);
    });

    it('정당한 변경은 통과한다: 다른 스크립트·옵션 더하기·원래 있던 약한 스크립트·의존성', async () => {
      const store = await started({ 'package.json': pkg({ test: 'vitest run --passWithNoTests', build: 'tsc' }) });
      await write('package.json', pkg({ test: 'vitest run --passWithNoTests', build: 'tsc -b', lint: 'eslint . || true' }, { dependencies: { a: '1' } }));
      expect(await verdict(store)).toBeUndefined();
      await write('package.json', pkg({ test: 'vitest run --passWithNoTests --coverage', build: 'tsc' }));
      expect(await verdict(store)).toBeUndefined();
    });

    it('npm init의 기본값(echo 뒤 exit 1)은 약하게 보지 않는다', async () => {
      const store = await started({ 'package.json': pkg({ build: 'tsc' }) });
      await write('package.json', pkg({ build: 'tsc', test: 'echo "Error: no test specified" && exit 1' }));
      expect(await verdict(store)).toBeUndefined();
    });

    it('package.json을 읽을 수 없으면(JSON이 깨졌으면) 통과가 아니라 확인하지 못함이다', async () => {
      const store = await started({ 'package.json': pkg({ test: 'vitest run' }) });
      await write('package.json', '{ "scripts": { "test": ');
      const check = await verdict(store);
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('확인하지 못');
    });

    it('허용이 있으면 통과하고 받아들인 것을 남긴다', async () => {
      const store = await started({ 'package.json': pkg({ test: 'vitest run' }) });
      await write('package.json', pkg({ test: 'vitest run || true' }));
      const check = await verdict(store, { allowed: true });
      expect(check).toMatchObject({ ok: true });
      expect(check?.detail).toContain('package.json');
    });
  });

  describe('길 3: 스냅샷 파일 지우기', () => {
    it.each(['src/__snapshots__/cart.test.ts.snap', 'cart.snap', 'tests/__snapshots__/test_cart.ambr', 'tests/__snapshots__/anything.txt', 'SRC/__SNAPSHOTS__/Cart.SNAP'])('%s를 지우면 돌려보낸다', async (file) => {
      const store = await started({ [file]: 'exports[`a`] = `1`;\n', 'keep.txt': 'k\n' });
      await rm(path.join(root, file));
      const check = await verdict(store);
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('스냅샷');
    });

    it('스냅샷을 다른 스냅샷 이름으로 옮기는 것은 통과하고, 스냅샷이 아닌 이름으로 옮기면 돌려보낸다', async () => {
      const store = await started({ 'src/__snapshots__/a.test.ts.snap': 'x\n' });
      await mkdir(path.join(root, 'src/__snapshots__/old'), { recursive: true });
      await rename(path.join(root, 'src/__snapshots__/a.test.ts.snap'), path.join(root, 'src/__snapshots__/old/a.test.ts.snap'));
      expect(await verdict(store)).toBeUndefined();
      await rename(path.join(root, 'src/__snapshots__/old/a.test.ts.snap'), path.join(root, 'src/a.bak'));
      expect((await verdict(store))?.ok).toBe(false);
    });

    it('스냅샷을 고치거나 새로 만드는 것은 통과한다. 허용이 있으면 지워도 통과한다', async () => {
      const store = await started({ 'src/__snapshots__/a.test.ts.snap': 'x\n' });
      await write('src/__snapshots__/a.test.ts.snap', 'y\n');
      await write('src/__snapshots__/b.test.ts.snap', 'z\n');
      expect(await verdict(store)).toBeUndefined();
      await rm(path.join(root, 'src/__snapshots__/a.test.ts.snap'));
      expect((await verdict(store, { allowed: true }))?.ok).toBe(true);
    });
  });

  describe('길 4: 단언을 더한 것보다 많이 지우기', () => {
    const JS_TEST = ['import { it, expect } from "vitest";', "it('a', () => {", '  expect(a()).toBe(1);', '  expect(b()).toBe(2);', '  expect(c()).toBe(3);', '});', ''].join('\n');

    it('단언을 지우기만 하면 돌려보낸다', async () => {
      const store = await started({ 'web/cart.test.ts': JS_TEST });
      await write('web/cart.test.ts', JS_TEST.replace('  expect(b()).toBe(2);\n  expect(c()).toBe(3);\n', ''));
      const check = await verdict(store);
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('단언');
      expect(check?.detail).toContain('web/cart.test.ts');
    });

    it('단언을 바꾸는 것(지우고 하나 더하는 것)과 더하는 것은 통과한다', async () => {
      const store = await started({ 'web/cart.test.ts': JS_TEST });
      await write('web/cart.test.ts', JS_TEST.replace('expect(b()).toBe(2)', 'expect(b()).toBe(20)'));
      expect(await verdict(store)).toBeUndefined();
      await write('web/cart.test.ts', `${JS_TEST}expect(d()).toBe(4);\n`);
      expect(await verdict(store)).toBeUndefined();
      // 지운 만큼 더했다(하나를 둘로 나눔, 줄 바꿈 방식 변경)
      await write('web/cart.test.ts', JS_TEST.replace('  expect(c()).toBe(3);', '  expect(c())\n    .toBe(3);'));
      expect(await verdict(store)).toBeUndefined();
    });

    it('주석으로 바꿔 놓는 것은 지운 것으로 센다', async () => {
      const store = await started({ 'web/cart.test.ts': JS_TEST });
      await write('web/cart.test.ts', JS_TEST.replace('  expect(b()).toBe(2);', '  // expect(b()).toBe(2);').replace('  expect(c()).toBe(3);', '  /* expect(c()).toBe(3); */'));
      expect((await verdict(store))?.ok).toBe(false);
    });

    it('언어별 단언 표시를 센다: python assert·assertEqual, java assertEquals·assertThat, go t.Error·require, rust assert!·assert_eq!', async () => {
      const cases: Array<[string, string, string]> = [
        ['tests/test_cart.py', 'def test_a():\n    assert a() == 1\n    assert b() == 2\n', 'def test_a():\n    assert a() == 1\n'],
        ['tests/test_cart.py', 'class T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(a(), 1)\n        self.assertTrue(b())\n', 'class T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(a(), 1)\n'],
        ['src/test/java/CartTest.java', 'class CartTest {\n  void a() {\n    assertEquals(1, a());\n    assertThat(b()).isEqualTo(2);\n  }\n}\n', 'class CartTest {\n  void a() {\n    assertEquals(1, a());\n  }\n}\n'],
        ['pkg/cart_test.go', 'func TestA(t *testing.T) {\n\tif a() != 1 {\n\t\tt.Errorf("x")\n\t}\n\trequire.Equal(t, 2, b())\n}\n', 'func TestA(t *testing.T) {\n\tif a() != 1 {\n\t\tt.Errorf("x")\n\t}\n}\n'],
        ['tests/cart.rs', '#[test]\nfn a() {\n    assert_eq!(a(), 1);\n    assert!(b());\n}\n', '#[test]\nfn a() {\n    assert_eq!(a(), 1);\n}\n'],
      ];
      for (const [file, before, after] of cases) {
        const store = await started({ [file]: before });
        await write(file, after);
        expect((await verdict(store))?.ok, file).toBe(false);
        await rm(path.join(root, '.git'), { recursive: true, force: true });
      }
    });

    it('시험 파일이 아닌 곳에서 assert를 지우는 것은 걸리지 않는다', async () => {
      const store = await started({ 'src/app.ts': 'assert(a);\nassert(b);\n' });
      await write('src/app.ts', 'assert(a);\n');
      expect(await verdict(store)).toBeUndefined();
    });

    it('허용이 있으면 통과하고 받아들인 것을 남긴다', async () => {
      const store = await started({ 'web/cart.test.ts': JS_TEST });
      await write('web/cart.test.ts', JS_TEST.replace('  expect(b()).toBe(2);\n  expect(c()).toBe(3);\n', ''));
      const check = await verdict(store, { allowed: true });
      expect(check).toMatchObject({ ok: true });
      expect(check?.detail).toContain('web/cart.test.ts');
    });
  });


  describe('커밋 보안 검토 지적', () => {
    it('Gradle: 시험 제외 줄에 의존성 exclude 모양을 덧붙여도 가려지지 않는다', async () => {
      for (const snippet of ["test {\n    exclude '**/OrderTest*'  // exclude group: 'x'\n}", "test { exclude '**/Slow*' }; exclude(group = \"a\")"]) {
        const store = await started({ 'build.gradle': 'plugins { id "java" }\n' });
        await write('build.gradle', `plugins { id "java" }\n${snippet}\n`);
        expect((await verdict(store))?.ok, snippet).toBe(false);
        await rm(path.join(root, '.git'), { recursive: true, force: true });
      }
    });

    it('pytest: addopts의 인자를 다른 줄에 나눠 써도 걸린다(pyproject 배열, ini 이어진 줄)', async () => {
      const store = await started({ 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = [\n  "-q",\n]\n', 'pytest.ini': '[pytest]\naddopts = -q\n' });
      await write('pyproject.toml', '[tool.pytest.ini_options]\naddopts = [\n  "-q",\n  "-k",\n  "not slow",\n]\n');
      expect((await verdict(store))?.ok).toBe(false);
      await write('pyproject.toml', '[tool.pytest.ini_options]\naddopts = [\n  "-q",\n]\n');
      expect(await verdict(store)).toBeUndefined();
      await write('pytest.ini', '[pytest]\naddopts = -q\n    --deselect\n    tests/test_a.py::t\n');
      expect((await verdict(store))?.ok).toBe(false);
    });

    it.each(['package.json', 'pytest.ini', 'conftest.py', 'jest.config.js', 'pom.xml'])('시험 설정 파일 %s를 지우면 돌려보낸다', async (file) => {
      const store = await started({ [file]: file === 'package.json' ? '{"scripts":{"test":"vitest run"}}\n' : 'x\n' });
      await rm(path.join(root, file));
      const check = await verdict(store);
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain(`지운 시험 설정 파일: ${file}`);
    });

    it('package.json을 설정이 아닌 이름으로 옮기면 돌려보내고, 같은 이름으로 하위 폴더에 옮기면 통과한다', async () => {
      const store = await started({ 'package.json': '{"name":"x","scripts":{"test":"vitest run"}}\n' });
      await rename(path.join(root, 'package.json'), path.join(root, 'package.json.bak'));
      expect((await verdict(store))?.ok).toBe(false);
      await rename(path.join(root, 'package.json.bak'), path.join(root, 'package.json'));
      expect(await verdict(store)).toBeUndefined();
    });
  });

  describe('끝까지 읽지 못하는 경우', () => {
    it('설정 파일이 너무 커서 읽지 못하면 던진다(통과로 읽지 않는다)', async () => {
      const store = await started({ 'vitest.config.ts': 'export default {};\n' });
      await write('vitest.config.ts', `export default {};\n// ${'x'.repeat(2 * 1024 * 1024)}\n`);
      await expect(store.pendingTestChanges()).rejects.toThrow();
    });

    it('설정 파일이 상한을 넘게 많이 바뀌면 던진다', async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 305; i += 1) files[`p${i}/package.json`] = '{"scripts":{"test":"vitest"}}\n';
      const store = await started(files);
      for (let i = 0; i < 305; i += 1) await write(`p${i}/package.json`, '{"scripts":{"test":"vitest run"}}\n');
      await expect(store.pendingTestChanges()).rejects.toThrow('너무 많');
    });
  });
});
