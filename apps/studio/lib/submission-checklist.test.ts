import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSubmissionChecklist,
  checkCommitHistory,
  checkEnvExample,
  checkReadmeSections,
  checkRequirements,
  checkRunInstructions,
  checkSecrets,
  checkSeedData,
  checkTests,
  checkWorkingTree,
  scoreOf,
  type ChecklistCommit,
  type ChecklistService,
} from './submission-checklist';

let root: string;

const WEB: ChecklistService = { name: 'web', template: 'nextjs', path: 'web', port: 3000 };
const API: ChecklistService = { name: 'api', template: 'spring-boot', path: 'api', port: 8080 };

async function write(file: string, content: string): Promise<void> {
  const full = path.join(root, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'submission-checklist-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('checkRequirements', () => {
  it('docs/requirements.md가 없으면 건너뛴다', async () => {
    expect((await checkRequirements(root)).status).toBe('skip');
  });

  it('체크박스가 모두 체크됐으면 통과한다', async () => {
    await write('docs/requirements.md', '# 요구사항\n- [x] R-1 주문 생성\n- [x] R-2 주문 취소\n');
    const item = await checkRequirements(root);
    expect(item.status).toBe('pass');
  });

  it('일부 미완료면 경고, 전부 미완료면 실패한다', async () => {
    await write('docs/requirements.md', '- [x] R-1\n- [ ] R-2\n');
    expect((await checkRequirements(root)).status).toBe('warn');

    await write('docs/requirements.md', '- [ ] R-1\n- [ ] R-2\n');
    expect((await checkRequirements(root)).status).toBe('fail');
  });

  it('"상태:" 줄도 함께 읽는다', async () => {
    await write('docs/requirements.md', '## R-1\n상태: 완료\n## R-2\n상태: 미검증\n');
    const item = await checkRequirements(root);
    expect(item.status).toBe('warn');
    expect(item.reason).toContain('2개 중 1개');
  });
});

describe('checkTests (스프링+넥스트 레이아웃)', () => {
  it('둘 다 테스트 파일이 없으면 실패한다', async () => {
    await write('api/src/main/java/Order.java', 'class Order {}\n');
    await write('web/app/page.tsx', 'export default function Page() { return null; }\n');
    const item = await checkTests(root, [API, WEB], ['test']);
    expect(item.status).toBe('fail');
    expect(item.fix?.label).toBe('테스트 추가');
  });

  it('한쪽만 테스트가 있으면 경고한다', async () => {
    await write('api/src/test/java/OrderTest.java', 'class OrderTest {}\n');
    await write('web/app/page.tsx', 'export default function Page() { return null; }\n');
    const item = await checkTests(root, [API, WEB], ['test']);
    expect(item.status).toBe('warn');
    expect(item.reason).toContain('web');
  });

  it('둘 다 있고 게이트도 통과했으면 통과한다', async () => {
    await write('api/src/test/java/OrderTest.java', 'class OrderTest {}\n');
    await write('web/app/orders/page.test.tsx', 'test("ok", () => {});\n');
    const item = await checkTests(root, [API, WEB], ['test']);
    expect(item.status).toBe('pass');
  });

  it('테스트 파일은 있지만 게이트가 test 단계를 통과한 적 없으면 경고한다', async () => {
    await write('api/src/test/java/OrderTest.java', 'class OrderTest {}\n');
    await write('web/app/orders/page.test.tsx', 'test("ok", () => {});\n');
    const item = await checkTests(root, [API, WEB], ['run', 'review']);
    expect(item.status).toBe('warn');
    expect(item.reason).toContain('test 단계');
  });

  it('fastapi 백엔드는 pytest 파일(test_*.py)을 인식한다', async () => {
    const FASTAPI: ChecklistService = { name: 'api', template: 'fastapi', path: 'api', port: 8000 };
    await write('api/app/main.py', 'app = FastAPI()\n');
    await write('api/tests/test_orders.py', 'def test_ok(): pass\n');
    const item = await checkTests(root, [FASTAPI], ['test']);
    expect(item.status).toBe('pass');
  });
});

describe('checkRunInstructions', () => {
  it('README가 없으면 실패한다', async () => {
    const item = await checkRunInstructions(root, [WEB, API]);
    expect(item.status).toBe('fail');
  });

  it('docker compose와 포트를 모두 언급하면 통과한다', async () => {
    await write('README.md', '## 실행 방법\n```\ndocker compose up\n```\nweb: http://localhost:3000, api: http://localhost:8080\n');
    const item = await checkRunInstructions(root, [WEB, API]);
    expect(item.status).toBe('pass');
  });

  it('일부 서비스만 문서화됐으면 경고한다', async () => {
    await write('README.md', '## 실행 방법\npnpm dev로 실행합니다. http://localhost:3000\n');
    const item = await checkRunInstructions(root, [WEB, API]);
    expect(item.status).toBe('warn');
    expect(item.reason).toContain('api');
  });
});

describe('checkEnvExample', () => {
  it('환경 변수를 쓰지 않으면 건너뛴다', async () => {
    await write('api/src/main/java/Order.java', 'class Order {}\n');
    expect((await checkEnvExample(root)).status).toBe('skip');
  });

  it('환경 변수를 읽지만 .env.example이 없으면 경고한다', async () => {
    await write('api/src/main/java/Order.java', '@Value("${DATABASE_URL}") String url;\n');
    const item = await checkEnvExample(root);
    expect(item.status).toBe('warn');
    expect(item.fix?.label).toBe('.env.example 만들기');
  });

  it('.env.example이 있으면 통과한다', async () => {
    await write('web/lib/db.ts', 'const url = process.env.DATABASE_URL;\n');
    await write('.env.example', 'DATABASE_URL=\n');
    expect((await checkEnvExample(root)).status).toBe('pass');
  });

  it('실제 .env가 저장소에 있으면 실패한다', async () => {
    await write('.env', 'DATABASE_URL=postgres://real:secret@host/db\n');
    const item = await checkEnvExample(root);
    expect(item.status).toBe('fail');
    expect(item.reason).not.toContain('secret@host');
  });
});

describe('checkSeedData', () => {
  it('데이터베이스가 없으면 건너뛴다', async () => {
    expect((await checkSeedData(root, false)).status).toBe('skip');
  });

  it('마이그레이션·시드가 없으면 경고한다', async () => {
    expect((await checkSeedData(root, true)).status).toBe('warn');
  });

  it('Flyway 마이그레이션을 찾으면 통과한다', async () => {
    await write('api/src/main/resources/db/migration/V1__init.sql', 'create table orders();\n');
    expect((await checkSeedData(root, true)).status).toBe('pass');
  });

  it('Prisma seed 스크립트를 찾으면 통과한다', async () => {
    await write('web/prisma/seed.ts', 'main();\n');
    expect((await checkSeedData(root, true)).status).toBe('pass');
  });
});

describe('checkSecrets', () => {
  it('비밀 값 패턴이 없으면 통과한다', async () => {
    await write('api/src/main/java/Order.java', 'class Order {}\n');
    expect((await checkSecrets(root)).status).toBe('pass');
  });

  it('AWS 키를 찾으면 실패하고, 값 자체는 이유에 담지 않는다', async () => {
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    await write('api/src/main/resources/application.yml', `aws.key: ${secret}\n`);
    const item = await checkSecrets(root);
    expect(item.status).toBe('fail');
    expect(item.reason).not.toContain(secret);
    expect(item.reason).toContain('application.yml:1');
  });

  it('.env.example 안의 예시 값은 무시한다', async () => {
    await write('.env.example', 'AWS_SECRET_ACCESS_KEY=changeme_example_value\n');
    expect((await checkSecrets(root)).status).toBe('pass');
  });
});

describe('checkCommitHistory', () => {
  function commit(subject: string, insertions = 1, deletions = 0): ChecklistCommit {
    return { subject, stat: { insertions, deletions } };
  }

  it('커밋이 없으면 건너뛴다', async () => {
    expect((await checkCommitHistory([])).status).toBe('skip');
  });

  it('conventional 접두어나 한국어 서술형이면 통과한다', async () => {
    const item = await checkCommitHistory([commit('feat: 주문 생성 API를 추가한다'), commit('fix: 재고 확인 버그를 고친다')]);
    expect(item.status).toBe('pass');
  });

  it('72자를 넘거나 wip 같은 제목이면 실패한다', async () => {
    expect((await checkCommitHistory([commit('wip')])).status).toBe('fail');
    expect((await checkCommitHistory([commit('a'.repeat(80))])).status).toBe('fail');
  });

  it('한 커밋이 전체 변경의 80%를 넘게 차지하면 경고한다', async () => {
    const item = await checkCommitHistory([commit('feat: 뼈대를 만든다', 500, 0), commit('fix: 오타를 고친다', 1, 0)]);
    expect(item.status).toBe('warn');
    expect(item.reason).toContain('%');
  });

  it('작은 세션은 커밋 하나뿐이어도 독차지로 보지 않는다', async () => {
    const item = await checkCommitHistory([commit('feat: 주문 생성 API를 추가한다', 10, 2)]);
    expect(item.status).toBe('pass');
  });
});

describe('checkWorkingTree', () => {
  it('저장하지 않은 변경이 있으면 실패한다', async () => {
    expect((await checkWorkingTree(2, undefined)).status).toBe('fail');
  });

  it('원격이 없으면 건너뛴다', async () => {
    expect((await checkWorkingTree(0, undefined)).status).toBe('skip');
  });

  it('원격은 있지만 올리지 않았으면 경고, 올렸으면 통과한다', async () => {
    expect((await checkWorkingTree(0, { hasRemote: true, pushed: false })).status).toBe('warn');
    expect((await checkWorkingTree(0, { hasRemote: true, pushed: true })).status).toBe('pass');
  });
});

describe('checkReadmeSections', () => {
  it('README가 없으면 실패한다', async () => {
    expect((await checkReadmeSections(root, [WEB])).status).toBe('fail');
  });

  it('필요한 절이 모두 있으면 통과한다', async () => {
    await write(
      'README.md',
      '## 개요\n설명\n## 실행 방법\n설명\n## API\n설명\n## 테스트\n설명\n## 설계 결정\n설명\n',
    );
    expect((await checkReadmeSections(root, [WEB])).status).toBe('pass');
  });

  it('일부 절이 없으면 경고하고 어떤 절인지 알려 준다', async () => {
    await write('README.md', '## 개요\n설명\n## 실행 방법\n설명\n');
    const item = await checkReadmeSections(root, [WEB]);
    expect(item.status).toBe('warn');
    expect(item.reason).toContain('API');
    expect(item.reason).toContain('테스트');
  });
});

describe('buildSubmissionChecklist / scoreOf', () => {
  it('전체 항목을 조립하고 skip을 뺀 점수를 계산한다', async () => {
    await write('README.md', '## 개요\n설명\n## 실행 방법\ndocker compose up, web http://localhost:3000\n## API\n설명\n## 테스트\n설명\n## 설계 결정\n설명\n');
    await write('web/app/page.test.tsx', 'test("ok", () => {});\n');

    const report = await buildSubmissionChecklist({
      root,
      services: [WEB],
      hasDatabase: false,
      latestPassedStages: ['test'],
      pendingFilesCount: 0,
      repository: { hasRemote: true, pushed: true },
      commits: [{ subject: 'feat: 주문 화면을 추가한다', stat: { insertions: 5, deletions: 0 } }],
    });

    expect(report.items).toHaveLength(9);
    expect(report.score.total).toBeLessThanOrEqual(9);
    expect(report.score.passed).toBe(scoreOf(report.items).passed);
  });
});

describe('checkRequirements — 명세 탭 상태', () => {
  it('명세 탭이 쓰는 "상태: 검증됨"을 끝난 것으로 본다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-req-'));
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'requirements.md'), '# 요구사항\n\n## R1. 목록 API\n- 상태: 검증됨\n\n## R2. 목록 화면\n- 상태: 검증됨\n');
    expect((await checkRequirements(root)).status).toBe('pass');
  });

  it('실시간 상태가 있으면 파일보다 그것을 쓰고, 필수가 남으면 실패, 선택만 남으면 경고다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-req-'));
    const must = await checkRequirements(root, [
      { id: 'R1', title: '목록 API', priority: 'must', status: '검증됨' },
      { id: 'R2', title: '목록 화면', priority: 'must', status: '작업 중' },
    ]);
    expect(must.status).toBe('fail');
    expect(must.reason).toContain('R2 목록 화면(작업 중)');
    const should = await checkRequirements(root, [
      { id: 'R1', title: '목록 API', priority: 'must', status: '검증됨' },
      { id: 'R3', title: '정렬', priority: 'should', status: '미착수' },
    ]);
    expect(should.status).toBe('warn');
    expect((await checkRequirements(root, [{ id: 'R1', title: '목록 API', priority: 'must', status: '검증됨' }])).status).toBe('pass');
  });
});

describe('checkReadmeSections — 실제 README 제목', () => {
  it('번호 붙은 제목·아키텍처·핵심 설계·첫 제목 아래 소개 문단을 인정한다(pay README 구조)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-readme-'));
    await writeFile(
      path.join(root, 'README.md'),
      '# BE-commerce\n\n결제와 정산을 다루는 커머스 백엔드입니다. 실패를 지우지 않고 확정하는 흐름을 보여 줍니다.\n\n## 아키텍처\n\n## 핵심 설계\n\n## 실행\n\n### 1. 애플리케이션\n\n### 3. 테스트\n\n## API 목록\n',
    );
    const item = await checkReadmeSections(root, []);
    expect(item.status).toBe('pass');
  });

  it('소개 문단도 개요 제목도 없으면 개요가 없다고 한다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-readme-'));
    await writeFile(path.join(root, 'README.md'), '# 앱\n\n## 실행\n\n## API\n\n## 테스트\n\n## 설계 결정\n');
    const item = await checkReadmeSections(root, []);
    expect(item.status).toBe('warn');
    expect(item.reason).toContain('개요');
  });
});

describe('checkSecrets — 테스트 코드', () => {
  it('테스트·픽스처 파일의 고정 시크릿은 세지 않고, 앱 코드의 것은 센다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-secret-'));
    await mkdir(path.join(root, 'api/src/test/java/app'), { recursive: true });
    await mkdir(path.join(root, 'web/app'), { recursive: true });
    await writeFile(path.join(root, 'api/src/test/java/app/JwtServiceTest.java'), 'String secret = "test-secret-value-123";\n');
    await writeFile(path.join(root, 'web/app/login.test.ts'), "const password = 'fixture-pass-1';\n");
    expect((await checkSecrets(root)).status).toBe('pass');
    await writeFile(path.join(root, 'web/app/admin.ts'), "login({ username: 'admin', password: 'admin-local-only' });\n");
    const item = await checkSecrets(root);
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('web/app/admin.ts:1');
    expect(item.reason).not.toContain('admin-local-only');
  });
});
