import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointError, CheckpointStore, redactCredentials, RemoteConflictError } from './checkpoints';
import { formatVerifyTrailer, formatWorkflowTrailer } from './workflow';

// 이 파일의 테스트는 실제 git 하위 프로세스를 여러 번 띄운다(clone·commit·push·fetch). 전체 테스트가 함께 도는 부하에서는
// 기본 5초를 넘겨 실패한 적이 여러 번 있다(단독으로는 항상 통과). 파일 전체에 넉넉한 제한 시간을 준다
vi.setConfig({ testTimeout: 30_000 });

const execFileAsync = promisify(execFile);

let root: string;
const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'checkpoints-test-'));
  // 개발자 PC의 전역 git 설정에 영향받지 않도록 빈 설정으로 시작한다
  const globalConfig = path.join(root, '..', `${path.basename(root)}.gitconfig`);
  await writeFile(globalConfig, '');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  await mkdir(path.join(root, 'api/src'), { recursive: true });
  await writeFile(path.join(root, 'api/src/Order.java'), 'class Order {}\n');
});

afterEach(() => {
  process.env.GIT_CONFIG_GLOBAL = savedEnv.global;
  process.env.GIT_CONFIG_NOSYSTEM = savedEnv.nosystem;
  if (savedEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  if (savedEnv.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
});

const write = (file: string, content: string) => writeFile(path.join(root, file), content);
const read = (file: string) => readFile(path.join(root, file), 'utf8');

describe('CheckpointStore', () => {
  it('시크릿 값이 들어간 파일이나 메시지는 커밋하지 않고, 값을 에러에 넣지 않는다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/PaymentClient.java', 'class PaymentClient { String key = "sk_live_1234567890"; }\n');
    const findSecrets = (text: string) => (text.includes('sk_live_1234567890') ? ['PAYMENT_API_KEY'] : []);

    const error = await store.commit('요청: 결제 연동', undefined, { findSecrets }).then(
      () => expect.unreachable(),
      (e: unknown) => e as CheckpointError,
    );

    expect(error).toBeInstanceOf(CheckpointError);
    expect(error.message).toContain('api/src/PaymentClient.java (PAYMENT_API_KEY)');
    expect(error.message).not.toContain('sk_live_1234567890');
    expect(await store.list()).toHaveLength(1);
    expect(await store.pendingFiles()).toEqual(['api/src/PaymentClient.java']);

    await write('api/src/PaymentClient.java', 'class PaymentClient { String key = System.getenv("PAYMENT_API_KEY"); }\n');
    await expect(store.commit('요청: 결제 연동', '키는 sk_live_1234567890', { findSecrets })).rejects.toThrow('커밋 메시지 (PAYMENT_API_KEY)');
    expect(await store.commit('요청: 결제 연동', undefined, { findSecrets })).toMatchObject({ files: ['api/src/PaymentClient.java'] });
  });

  it('커밋 본문의 Workflow-Passed 트레일러를 체크포인트의 통과 단계로 다시 읽고, 없으면 비워 둔다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    const verified = await store.commit('요청: 메모 추가', `검증 결과\n\n${formatWorkflowTrailer(['run', 'contract_check', 'test', 'review'])}`);
    expect(verified?.passedStages).toEqual(['run', 'contract_check', 'test', 'review']);

    await write('api/src/Order.java', 'class Order { String memo; String note; }\n');
    const local = await store.commit('직접 수정: 파일 1개', '스튜디오 밖에서 바꾼 파일입니다.');
    expect(local?.passedStages).toBeUndefined();

    // 본문이 길이 상한을 넘어 잘려도 트레일러는 잘리지 않아야 한다. 잘리면 검증을 통과한 체크포인트가 배포 거부된다
    await write('api/src/Order.java', 'class Order { String memo; String note; String tag; }\n');
    const long = await store.commit('요청: 긴 검증 보고서', `${'로그 한 줄\n'.repeat(2_000)}`, {
      trailers: [formatWorkflowTrailer(['run', 'contract_check', 'review'])],
    });
    expect(long?.passedStages).toEqual(['run', 'contract_check', 'review']);

    // 에이전트 요약은 본문에 들어간다. 모델이 요약에 트레일러 모양 줄을 써도 통과 기록으로 읽히면 안 된다
    await write('api/src/Order.java', 'class Order { String memo; String note; String tag; String flag; }\n');
    const forged = await store.commit('요청: 위조 시도', `에이전트 요약:\n${formatWorkflowTrailer(['run', 'contract_check', 'test', 'review'])}\n다 했습니다`, {
      trailers: [formatWorkflowTrailer(['run'])],
    });
    expect(forged?.passedStages).toEqual(['run']);
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    const forgedWithoutGate = await store.commit('직접 수정: 파일 1개', `메모\n\n${formatWorkflowTrailer(['test', 'review'])}\n\n끝`);
    expect(forgedWithoutGate?.passedStages).toBeUndefined();

    // 스튜디오를 다시 켜서 목록을 새로 읽어도 같은 기록이 나온다
    const [, , latest, local2, previous] = await store.list();
    expect(latest!.passedStages).toEqual(['run', 'contract_check', 'review']);
    expect(local2!.passedStages).toBeUndefined();
    expect(previous!.passedStages).toEqual(['run', 'contract_check', 'test', 'review']);
  });

  it('Workflow-Verify 트레일러가 있으면 가볍게 확인한 체크포인트로 읽고, 다시 읽어도 같은 값이 나온다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    const light = await store.commit('요청: 메모 추가', `검증 결과\n\n${formatWorkflowTrailer(['run', 'contract_check'])}\n${formatVerifyTrailer('light')}`);
    expect(light?.passedStages).toEqual(['run', 'contract_check']);
    expect(light?.verify).toBe('light');

    await write('api/src/Order.java', 'class Order { String memo; String note; }\n');
    const full = await store.commit('요청: 메모 추가 2', `검증 결과\n\n${formatWorkflowTrailer(['run', 'contract_check', 'test'])}`);
    expect(full?.verify).toBeUndefined();

    const [latest, previous] = await store.list();
    expect(latest!.verify).toBeUndefined();
    expect(previous!.verify).toBe('light');
    expect(previous!.passedStages).toEqual(['run', 'contract_check']);
  });

  it('코드 변경이 있는데 Workflow-Passed가 none이면 체크포인트를 만들지 않는다(ADR-131 마지막 방어선)', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    await expect(store.commit('요청: 메모 추가', '검증 없이 복원된 변경', { trailers: [formatWorkflowTrailer([])] })).rejects.toThrow(
      '검증 게이트를 거치지 않은 코드 변경이 있어 체크포인트를 남기지 않았습니다',
    );
    // 막혔으므로 체크포인트가 늘지 않고, 변경은 그대로 pending에 남는다(호출하는 쪽이 되돌리기로 처리한다)
    expect(await store.list()).toHaveLength(1);
    expect(await store.pendingFiles()).toEqual(['api/src/Order.java']);
  });

  it('트레일러 자체가 없으면(게이트를 애초에 거치지 않기로 한 경로) 막지 않는다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    const local = await store.commit('직접 수정: 파일 1개', '스튜디오 밖에서 바꾼 파일입니다.');
    expect(local?.passedStages).toBeUndefined();
    expect(await store.pendingFiles()).toEqual([]);
  });

  it('Workflow-Passed가 none이어도 문서 체크포인트 예외(Workflow-Verify: docs)는 그대로 허용한다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await write('docs/requirements.md', '# 요구사항\n');
    // 실제 호출부(commitWorkingCopyDocs)는 commitPaths로 문서 경로만 좁혀 커밋하지만, 방어선 자체는 commit()에
    // 있으므로 같은 트레일러 조합을 commit()에 직접 줘도 막지 않는지 본다(문서만 바뀌었으면 예외가 적용된다)
    const docsOnly = await store.commit('지키기: 되돌리기 전에 문서를 체크포인트로 남긴다', undefined, {
      trailers: [formatWorkflowTrailer([]), formatVerifyTrailer('docs')],
    });
    expect(docsOnly?.verify).toBe('docs');
    expect(await store.pendingFiles()).toEqual([]);
  });

  it('다른 사람이 만든 커밋의 트레일러는 무시하고, 스튜디오가 만든 체크포인트의 통과 기록은 그대로 읽는다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    const mine = await store.commit('요청: 메모 추가', `검증 결과\n\n${formatWorkflowTrailer(['run', 'contract_check', 'test', 'review'])}`);
    expect(mine?.passedStages).toEqual(['run', 'contract_check', 'test', 'review']);

    // 원격에 쓸 수 있는 사람이 통과 기록을 적어 올린 커밋. 본문 마지막 문단이 트레일러 블록이다
    await write('api/src/Order.java', 'class Order { String memo; String theirs; }\n');
    await execFileAsync('git', ['-C', root, 'add', '-A']);
    await execFileAsync('git', [
      '-C', root, '-c', 'user.name=other', '-c', 'user.email=other@example.com',
      'commit', '-q', '-m', '외부 커밋', '-m', formatWorkflowTrailer(['run', 'contract_check', 'test', 'review']),
    ]);

    const [theirs, latest, start] = await store.list();
    expect(theirs!.message).toBe('외부 커밋');
    expect(theirs!.passedStages).toBeUndefined();
    // 신뢰 범위를 좁히면서 스튜디오가 만든 체크포인트까지 막지 않았는지 확인한다
    expect(latest!.message).toBe('요청: 메모 추가');
    expect(latest!.passedStages).toEqual(['run', 'contract_check', 'test', 'review']);
    expect(start!.passedStages).toBeUndefined();
  });

  it('저장소가 사용자 지정 작성자를 쓰면 그 작성자가 만든 체크포인트의 통과 기록을 읽는다', async () => {
    const store = new CheckpointStore(root, { author: { name: 'ops', email: 'ops@example.com' } });
    await store.init();
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    const checkpoint = await store.commit('요청: 메모 추가', `검증 결과\n\n${formatWorkflowTrailer(['run', 'contract_check', 'review'])}`);

    expect(checkpoint?.passedStages).toEqual(['run', 'contract_check', 'review']);
    expect((await store.list())[0]!.passedStages).toEqual(['run', 'contract_check', 'review']);
  });

  it('sessionCommits는 커밋 본문의 트레일러에서 통과 단계를 함께 읽고, 없으면 비워 둔다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    await store.commit('요청: 메모 추가', '검증 결과', { trailers: [formatWorkflowTrailer(['run', 'contract_check', 'review'])] });
    await write('api/src/Order.java', 'class Order { String memo; String note; }\n');
    await store.commit('직접 수정: 파일 1개', '스튜디오 밖에서 바꾼 파일입니다.');

    const commits = await store.sessionCommits();
    expect(commits[0]).toMatchObject({ subject: '요청: 메모 추가', passedStages: ['run', 'contract_check', 'review'] });
    expect(commits[1]).toMatchObject({ subject: '직접 수정: 파일 1개' });
    expect(commits[1]!.passedStages).toBeUndefined();
  });

  it('sessionCommits는 커밋 본문의 Workflow-Verify 트레일러도 함께 읽는다(PR 본문이 문서 체크포인트를 구분한다)', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await write('docs/requirements.md', '# 요구사항\n');
    await store.commit('docs: 요구사항을 정리한다', undefined, { trailers: [formatVerifyTrailer('docs')] });
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    await store.commit('요청: 메모 추가', '검증 결과', { trailers: [formatWorkflowTrailer(['run', 'contract_check', 'review'])] });

    const commits = await store.sessionCommits();
    expect(commits[0]).toMatchObject({ subject: 'docs: 요구사항을 정리한다', verify: 'docs' });
    expect(commits[1]!.verify).toBeUndefined();
  });

  it('sessionCommits는 커밋마다 바뀐 줄 수(추가·삭제)를 담는다(제출 준비 점검, ADR-080)', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/Order.java', 'class Order {\n  String a;\n  String b;\n}\n');
    await store.commit('요청: 필드 두 개 추가');
    await write('api/src/Order.java', 'class Order {\n  String a;\n}\n');
    await store.commit('요청: 필드 하나 지움');

    const commits = await store.sessionCommits();
    expect(commits[0]!.stat).toEqual({ insertions: 4, deletions: 1 });
    expect(commits[1]!.stat).toEqual({ insertions: 0, deletions: 1 });
  });

  it('sessionDiff는 세션 시작부터 지금까지의 변경을 모두 담는다(PR 자동 리뷰가 보는 범위, ADR-074)', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    expect(await store.sessionDiff()).toBe('');

    await write('api/src/Order.java', 'class Order { String memo; }\n');
    await store.commit('요청: 메모 추가');
    await write('api/src/Order.java', 'class Order { String memo; String note; }\n');
    await store.commit('요청: 메모 필드 추가');

    const diff = await store.sessionDiff();
    expect(diff).toContain('diff --git a/api/src/Order.java b/api/src/Order.java');
    expect(diff).toContain('+class Order { String memo; String note; }');
    // 첫 커밋에서 두 번째로 가는 중간 상태(memo만 있는 버전)는 diff에 남지 않는다 — 세션 시작 대비 최종 상태만 본다
    expect(diff).not.toContain('+class Order { String memo; }\n');
  });

  it('diffSince는 세션 시작이 아니라 주어진 커밋부터 지금 HEAD까지만 담는다(PR 자동 리뷰가 새 커밋만 다시 볼 때 쓴다, 버그 리포트 86)', async () => {
    const store = new CheckpointStore(root);
    await store.init();

    await write('api/src/Order.java', 'class Order { String memo; }\n');
    const first = await store.commit('요청: 메모 추가');
    await write('api/src/Order.java', 'class Order { String memo; String note; }\n');
    await store.commit('요청: 메모 필드 추가');

    // 세션 시작부터 보면(sessionDiff) 첫 커밋의 전체 추가가 보이지만, 첫 커밋부터만 보면(diffSince) 그 뒤 변경만 보인다
    const sinceFirst = await store.diffSince(first!.sha);
    expect(sinceFirst).toContain('+class Order { String memo; String note; }');
    expect(sinceFirst).not.toContain('diff --git a/api/src/Order.java b/api/src/Order.java\nnew file mode');

    const sinceHead = await store.diffSince((await store.sessionCommits()).at(-1)!.sha);
    expect(sinceHead).toBe('');
  });

  it('작업 폴더 밖 저장소에 체크포인트를 남기고, 사용자 폴더의 .git과 무시한 파일은 건드리지 않는다', async () => {
    // 사용자가 쓰던 저장소: 커밋 하나, 무시하는 로그 파일, 아직 커밋하지 않은 초안
    await write('.gitignore', '*.log\n');
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', '내 커밋');
    await write('debug.log', 'local log\n');
    await write('api/src/Draft.java', 'class Draft {}\n');
    const userConfig = await readFile(path.join(root, '.git', 'config'), 'utf8');

    const gitDir = path.join(await mkdtemp(path.join(tmpdir(), 'checkpoints-state-')), 'orders-s1', '.git');
    const store = new CheckpointStore(root, { gitDir });
    const start = await store.init('세션 시작');
    expect(store.gitDir).toBe(gitDir);
    expect(start.files).toEqual(['.gitignore', 'api/src/Draft.java', 'api/src/Order.java']);

    // 실패한 요청의 변경은 되돌리고, 무시한 파일은 남긴다
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    await write('api/src/Temp.java', 'class Temp {}\n');
    expect(await store.pendingFiles()).toEqual(['api/src/Order.java', 'api/src/Temp.java']);
    await store.discard();
    expect(await read('api/src/Order.java')).toBe('class Order {}\n');
    await expect(read('api/src/Temp.java')).rejects.toThrow();
    expect(await read('debug.log')).toBe('local log\n');

    await write('api/src/Order.java', 'class Order { String memo; }\n');
    expect(await store.commit('요청: 메모')).toMatchObject({ files: ['api/src/Order.java'] });
    await store.restore(start.sha);
    expect(await read('api/src/Order.java')).toBe('class Order {}\n');
    expect(await read('api/src/Draft.java')).toBe('class Draft {}\n');

    // 사용자 저장소의 기록, 설정, 작업 상태는 그대로다
    expect(await git(root, 'log', '--format=%s')).toBe('내 커밋');
    expect(await git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('?? api/src/Draft.java');
    expect(await readFile(path.join(root, '.git', 'config'), 'utf8')).toBe(userConfig);
    expect(await new CheckpointStore(root, { gitDir }).list()).toHaveLength(1);
  });

  it('체크포인트의 기록한 파일만 폴더로 꺼내고, 남기지 않은 변경은 넣지 않는다', async () => {
    const store = new CheckpointStore(root);
    const start = await store.init();
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    const memo = (await store.commit('요청: 메모'))!;
    await write('api/src/Draft.java', 'class Draft {}\n');
    const out = await mkdtemp(path.join(tmpdir(), 'checkpoint-export-'));

    expect(await store.exportTree(start.sha, path.join(out, 'start'))).toBe(path.join(out, 'start'));
    expect(await readFile(path.join(out, 'start/api/src/Order.java'), 'utf8')).toBe('class Order {}\n');
    await store.exportTree(memo.shortSha, path.join(out, 'memo'));
    expect(await readFile(path.join(out, 'memo/api/src/Order.java'), 'utf8')).toBe('class Order { String memo; }\n');
    await expect(readFile(path.join(out, 'memo/api/src/Draft.java'), 'utf8')).rejects.toThrow();
    await expect(store.exportTree('not-a-sha', path.join(out, 'bad'))).rejects.toThrow(CheckpointError);
  });

  it('지금 상태를 첫 체크포인트로 남기고 샌드박스 생성물은 제외한다', async () => {
    await mkdir(path.join(root, 'web/node_modules/next'), { recursive: true });
    await write('web/node_modules/next/index.js', '');
    const store = new CheckpointStore(root);

    const first = await store.init();

    expect(first).toMatchObject({ message: '세션 시작', files: ['api/src/Order.java'] });
    expect(await store.pendingFiles()).toEqual([]);
  });

  it('바뀐 파일이 없으면 커밋하지 않고, 있으면 체크포인트로 남긴다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    expect(await store.commit('요청: 아무것도 안 함')).toBeUndefined();

    await write('api/src/Order.java', 'class Order { String memo; }\n');
    await write('api/src/V2.sql', 'alter table orders add column memo text;\n');
    const checkpoint = await store.commit('요청: 메모 필드 추가');

    expect(checkpoint).toMatchObject({ message: '요청: 메모 필드 추가', files: ['api/src/Order.java', 'api/src/V2.sql'] });
    expect((await store.list()).map((c) => c.message)).toEqual(['요청: 메모 필드 추가', '세션 시작']);
  });

  it('버리면 수정과 새 파일이 모두 사라지고, 버린 변경을 patch로 돌려준다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/Order.java', 'class Order { int broken }\n');
    await write('api/src/New.java', 'class New {}\n');

    const { files, patch } = await store.discard();

    expect(files).toEqual(['api/src/New.java', 'api/src/Order.java']);
    expect(patch).toContain('+class Order { int broken }');
    expect(patch).toContain('+class New {}');
    expect(await read('api/src/Order.java')).toBe('class Order {}\n');
    await expect(read('api/src/New.java')).rejects.toThrow();
    expect(await store.pendingFiles()).toEqual([]);
  });

  it('버리기 전에 백업을 남기고, 되살리기로 그대로 되돌린다(ADR-099, "절대 조용히 지우지 않는다")', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/Order.java', 'class Order { int broken }\n');
    await write('api/src/New.java', 'class New {}\n');

    const { files, backup } = await store.discard();
    expect(files).toEqual(['api/src/New.java', 'api/src/Order.java']);
    expect(backup).toMatchObject({ files: ['api/src/New.java', 'api/src/Order.java'] });
    expect(await read('api/src/Order.java')).toBe('class Order {}\n');
    await expect(read('api/src/New.java')).rejects.toThrow();

    const restored = await store.restoreBackup(backup!.id);
    expect(restored.files.sort()).toEqual(['api/src/New.java', 'api/src/Order.java']);
    expect(await read('api/src/Order.java')).toBe('class Order { int broken }\n');
    expect(await read('api/src/New.java')).toBe('class New {}\n');
    // 되살려도 체크포인트 기록 자체는 그대로다(되살린 변경은 다시 pending이다)
    expect(await store.pendingFiles()).toEqual(['api/src/New.java', 'api/src/Order.java']);
  });

  it('버릴 변경이 없으면 백업을 남기지 않는다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    expect(await store.discard()).toEqual({ files: [], patch: '' });
  });

  it('그 사이에 같은 파일이 다시 바뀌면 백업 되살리기를 거부하고 아무것도 바꾸지 않는다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/Order.java', 'class Order { int broken }\n');
    const { backup } = await store.discard();

    await write('api/src/Order.java', 'class Order { String other; }\n');
    await expect(store.restoreBackup(backup!.id)).rejects.toThrow('충돌');
    // 거부됐으니 그 사이에 쓴 내용은 그대로여야 한다
    expect(await read('api/src/Order.java')).toBe('class Order { String other; }\n');
  });

  it('존재하지 않는 백업 id는 되살리기를 거부한다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await expect(store.restoreBackup('2026-01-01T00-00-00-000Z-0001')).rejects.toThrow('찾을 수 없습니다');
    await expect(store.restoreBackup('; rm -rf /')).rejects.toThrow(CheckpointError);
  });

  it('이전 체크포인트로 되돌리기 전에도 아직 커밋하지 않은 변경을 백업한다', async () => {
    const store = new CheckpointStore(root);
    const start = await store.init();
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    await store.commit('요청: 메모');
    await write('api/src/Draft.java', 'class Draft {}\n');

    const { backup } = await store.restore(start.sha);
    expect(backup).toMatchObject({ files: ['api/src/Draft.java'] });
    await expect(read('api/src/Draft.java')).rejects.toThrow();

    const restored = await store.restoreBackup(backup!.id);
    expect(restored.files).toEqual(['api/src/Draft.java']);
    expect(await read('api/src/Draft.java')).toBe('class Draft {}\n');
  });

  it('백업은 최근 10개까지만 남기고 오래된 것부터 지우며, 방금 만든 백업은 지우지 않는다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      await write('api/src/Order.java', `class Order { int v${i}; }\n`);
      const { backup } = await store.discard();
      ids.push(backup!.id);
    }

    const remaining = await store.discardedBackups();
    expect(remaining).toHaveLength(10);
    const remainingIds = new Set(remaining.map((entry) => entry.id));
    // 가장 최근 10개(마지막에 만든 것부터)만 남고, 가장 먼저 만든 2개는 지워졌다
    expect(remainingIds.has(ids[0]!)).toBe(false);
    expect(remainingIds.has(ids[1]!)).toBe(false);
    expect(remainingIds.has(ids[ids.length - 1]!)).toBe(true);
    // 가장 최근 백업은 한도를 넘겨도 지우지 않는다
    await expect(store.restoreBackup(ids[ids.length - 1]!)).resolves.toMatchObject({ files: ['api/src/Order.java'] });
  });

  it('마지막 체크포인트 이후 추가·수정·삭제한 파일과 파일 하나의 변경 내용을 돌려준다', async () => {
    const store = new CheckpointStore(root);
    await write('api/src/Gone.java', 'class Gone {}\n');
    await store.init();

    await write('api/src/Order.java', 'class Order { String memo; }\n');
    await write('api/src/Memo.java', 'class Memo {}\n');
    await rm(path.join(root, 'api/src/Gone.java'));

    expect(await store.pendingChanges()).toEqual([
      { file: 'api/src/Gone.java', change: 'deleted' },
      { file: 'api/src/Memo.java', change: 'added' },
      { file: 'api/src/Order.java', change: 'modified' },
    ]);
    const patch = await store.pendingPatch('api/src/Order.java');
    expect(patch).toContain('-class Order {}');
    expect(patch).toContain('+class Order { String memo; }');
    // 아직 기록에 없는 새 파일은 diff가 없다
    expect(await store.pendingPatch('api/src/Memo.java')).toBe('');
  });

  it('이전 체크포인트로 복원하면 그 사이에 바뀐 파일 목록을 돌려준다', async () => {
    const store = new CheckpointStore(root);
    const first = await store.init();
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    await store.commit('요청: 메모');
    await write('api/src/Draft.java', 'class Draft {}\n');

    const { checkpoint, files } = await store.restore(first.shortSha);

    expect(checkpoint.sha).toBe(first.sha);
    expect(files).toEqual(['api/src/Draft.java', 'api/src/Order.java']);
    expect(await read('api/src/Order.java')).toBe('class Order {}\n');
    expect((await store.list()).map((c) => c.message)).toEqual(['세션 시작']);
  });

  it('사용자 전역 커밋 훅이 모든 커밋을 거부해도 체크포인트는 남는다', async () => {
    const hooks = path.join(root, '..', `${path.basename(root)}-hooks`);
    await mkdir(hooks, { recursive: true });
    await writeFile(path.join(hooks, 'commit-msg'), '#!/bin/sh\necho "rejected by global hook" >&2\nexit 1\n');
    await chmod(path.join(hooks, 'commit-msg'), 0o755);
    await writeFile(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgsign = true\n`);

    const store = new CheckpointStore(root);
    await expect(store.init()).resolves.toMatchObject({ message: '세션 시작' });
    await rm(hooks, { recursive: true, force: true });
  });

  it('형식이 틀리거나 기록에 없는 체크포인트는 거부한다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await expect(store.restore('HEAD~1; rm -rf /')).rejects.toThrow(CheckpointError);
    await expect(store.restore('deadbeef')).rejects.toThrow('찾을 수 없습니다');
  });

  it('원본 Git 저장소가 없는 세션은 원격 정보가 없고 올릴 수 없다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    expect(await store.repository()).toBeUndefined();
    await expect(store.push()).rejects.toThrow('원격 저장소와 연결되지 않은 세션');
  });
});

/** 커밋 작성자를 명령마다 넘긴다. 테스트는 빈 전역 설정으로 돌기 때문이다 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

/** origin(bare 저장소)으로 main을 올려 둔 원본 저장소를 만든다 */
async function createSourceRepository() {
  const base = path.join(root, 'remote-test');
  const remote = path.join(base, 'orders.git');
  const source = path.join(base, 'orders');
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await writeFile(path.join(source, 'README.md'), '# orders\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'docs');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  return { base, remote, source, workDir: path.join(base, 'sessions', 'orders-s1') };
}

const BRANCH = 'b-studio/orders-s1';

/** 리뷰어가 세션 브랜치를 받아 커밋 하나를 올린다 */
async function pushReviewerCommit(base: string, remote: string, file: string, content: string, message: string): Promise<string> {
  const reviewer = await mkdtemp(path.join(base, 'reviewer-'));
  await execFileAsync('git', ['clone', '-q', '--branch', BRANCH, remote, reviewer]);
  await mkdir(path.dirname(path.join(reviewer, file)), { recursive: true });
  await writeFile(path.join(reviewer, file), content);
  await git(reviewer, 'add', '-A');
  await git(reviewer, 'commit', '-q', '-m', message);
  await git(reviewer, 'push', '-q', 'origin', 'HEAD');
  return git(reviewer, 'rev-parse', 'HEAD');
}

describe('CheckpointStore 원격 변경 가져오기', () => {
  it('리뷰어 커밋을 병합 커밋 하나로 가져오고, 받아들인 뒤 올리면 원격을 덮어쓰지 않고 이어 붙인다', async () => {
    const { base, source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const order = path.join(workDir, 'api/src/Order.java');

    await writeFile(order, 'class Order { String a; }\n');
    await store.commit('요청: A');
    await store.push();
    const theirs = await pushReviewerCommit(base, remote, 'NOTE.md', 'review\n', 'review note');
    await writeFile(order, 'class Order { String b; }\n');
    const b = (await store.commit('요청: B'))!;
    await expect(store.push()).rejects.toThrow('원격 변경을 가져온 뒤 다시 올리세요');

    const result = await store.integrateRemote();
    expect(result).toMatchObject({
      status: 'merged',
      remoteSha: theirs,
      files: ['NOTE.md'],
      previous: b.sha,
      commits: [{ sha: theirs, subject: 'review note', author: 'test' }],
      checkpoint: { message: '원격 커밋 1개 가져오기', files: ['NOTE.md'] },
    });
    expect(await readFile(path.join(workDir, 'NOTE.md'), 'utf8')).toBe('review\n');
    expect(await readFile(order, 'utf8')).toBe('class Order { String b; }\n');

    // 리뷰어 커밋은 체크포인트로 보이지 않고, 가져온 결과가 체크포인트 하나로 남는다
    expect((await store.list()).map((checkpoint) => checkpoint.message)).toEqual(['원격 커밋 1개 가져오기', '요청: B', '요청: A', '세션 시작 (main 브랜치)']);
    expect((await store.sessionCommits()).map((commit) => commit.subject)).toEqual(['요청: A', '요청: B', '원격 커밋 1개 가져오기']);
    expect(await store.patch(result.checkpoint!.sha)).toContain('+review');

    await store.acceptRemote(result);
    expect(await store.push()).toEqual({ sha: result.checkpoint!.sha, commits: 3, forced: false });
    await expect(git(remote, 'merge-base', '--is-ancestor', theirs, `refs/heads/${BRANCH}`)).resolves.toBe('');
  });

  it('원격 커밋과 같은 곳을 고쳤으면 아무것도 바꾸지 않고 충돌한 파일을 알린다', async () => {
    const { base, source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const order = path.join(workDir, 'api/src/Order.java');

    await writeFile(order, 'class Order { String a; }\n');
    await store.commit('요청: A');
    await store.push();
    await pushReviewerCommit(base, remote, 'api/src/Order.java', 'class Order { String reviewer; }\n', 'reviewer edit');
    await writeFile(order, 'class Order { String mine; }\n');
    const mine = (await store.commit('요청: 내 변경'))!;

    const error = await store.integrateRemote().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RemoteConflictError);
    expect((error as RemoteConflictError).conflicts).toEqual(['api/src/Order.java']);
    expect(await git(workDir, 'rev-parse', 'HEAD')).toBe(mine.sha);
    expect(await store.pendingFiles()).toEqual([]);
    expect(await readFile(order, 'utf8')).toBe('class Order { String mine; }\n');
    await expect(git(workDir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')).rejects.toThrow();
  });

  it('원격에 브랜치가 없거나 지금 기록에 이미 들어 있으면 가져올 것이 없다', async () => {
    const { source, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const head = await git(workDir, 'rev-parse', 'HEAD');
    expect(await store.integrateRemote()).toEqual({ status: 'up-to-date', commits: [], files: [], previous: head });

    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String a; }\n');
    const a = (await store.commit('요청: A'))!;
    await store.push();
    expect(await store.integrateRemote()).toEqual({ status: 'up-to-date', remoteSha: a.sha, commits: [], files: [], previous: a.sha });
  });

  it('올린 뒤 되돌린 기록에는 버린 체크포인트 없이 원격에만 있는 변경을 옮겨 오고, 받아들이기 전에는 원격 상태로 기록하지 않는다', async () => {
    const { base, source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const order = path.join(workDir, 'api/src/Order.java');

    await writeFile(order, 'class Order { String a; }\n');
    const a = (await store.commit('요청: A'))!;
    await writeFile(order, 'class Order { String b; }\n');
    await store.commit('요청: B');
    await store.push();
    await store.restore(a.sha);
    const theirs = await pushReviewerCommit(base, remote, 'NOTE.md', 'review\n', 'review note');

    const result = await store.integrateRemote();
    expect(result).toMatchObject({ status: 'picked', remoteSha: theirs, files: ['NOTE.md'], previous: a.sha, commits: [{ subject: 'review note' }] });
    // 버린 B의 변경은 다시 들어오지 않는다
    expect(await readFile(order, 'utf8')).toBe('class Order { String a; }\n');
    expect(await readFile(path.join(workDir, 'NOTE.md'), 'utf8')).toBe('review\n');

    // 검증에 실패해 가져오기를 되돌렸다면, 원격 상태로 기록하지 않았으므로 올려도 리뷰어 커밋을 덮어쓰지 않는다
    await store.restore(a.sha);
    await expect(store.acceptRemote(result)).rejects.toThrow('원격 상태로 기록하지 않았습니다');
    await expect(store.push()).rejects.toThrow('덮어쓰지 않았습니다');
    expect(await git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(theirs);

    // 다시 가져와 받아들이면 원격 브랜치를 지금 기록으로 맞춘다. 리뷰어 변경은 내용으로 남는다
    const again = await store.integrateRemote();
    await store.acceptRemote(again);
    expect(await store.push()).toMatchObject({ sha: again.checkpoint!.sha, forced: true });
    expect(await git(remote, 'show', `refs/heads/${BRANCH}:NOTE.md`)).toBe('review');
  });
});

describe('CheckpointStore 원격 저장소 연동', () => {
  it('원본을 복제해 세션 브랜치를 만들고, 기록에는 세션 시작 이후만 보인다', async () => {
    const { source, remote, workDir } = await createSourceRepository();
    const { store, start, source: info } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });

    expect(info).toEqual({ base: 'main', originUrl: remote, dirtyFiles: 0, subdir: '' });
    expect(start).toMatchObject({ sha: await git(source, 'rev-parse', 'HEAD'), message: '세션 시작 (main 브랜치)', files: ['README.md', 'api/src/Order.java'] });
    expect(await git(workDir, 'branch', '--show-current')).toBe(BRANCH);
    expect(await store.patch(start.sha)).toContain('세션을 시작한 시점');

    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');
    await store.commit('요청: 메모 추가', '검증 통과\n- api: 재시작 후 준비 완료\n\n# 에이전트 요약 제목');

    expect((await store.list()).map((checkpoint) => checkpoint.message)).toEqual(['요청: 메모 추가', '세션 시작 (main 브랜치)']);
    expect(await store.repository()).toEqual({
      remoteUrl: remote,
      base: 'main',
      branch: BRANCH,
      subdir: undefined,
      pushedSha: undefined,
      remoteSha: undefined,
      pullRequestUrl: undefined,
    });
    // 마크다운 제목(#)이 커밋 정리 규칙에 지워지지 않아야 한다
    expect(await store.sessionCommits()).toMatchObject([
      { subject: '요청: 메모 추가', body: '검증 통과\n- api: 재시작 후 준비 완료\n\n# 에이전트 요약 제목', files: ['api/src/Order.java'] },
    ]);
  });

  it('올리면 원격에 세션 브랜치가 생기고, 기준 브랜치에서 갈라져 있다', async () => {
    const { source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    await expect(store.push()).rejects.toThrow('올릴 체크포인트가 없습니다');

    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');
    const checkpoint = (await store.commit('요청: 메모 추가'))!;

    expect(await store.push()).toEqual({ sha: checkpoint.sha, commits: 1, forced: false });
    expect(await git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(checkpoint.sha);
    expect(await git(remote, 'rev-parse', `refs/heads/${BRANCH}^`)).toBe(await git(remote, 'rev-parse', 'refs/heads/main'));
    expect((await store.repository())?.pushedSha).toBe(checkpoint.sha);
  });

  it('되돌린 뒤 다시 올리면 원격 브랜치를 맞추고, 다른 사람이 올린 커밋은 덮어쓰지 않는다', async () => {
    const { base, source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const order = path.join(workDir, 'api/src/Order.java');

    await writeFile(order, 'class Order { String a; }\n');
    const a = (await store.commit('요청: A'))!;
    await writeFile(order, 'class Order { String b; }\n');
    await store.commit('요청: B');
    await store.push();

    await store.restore(a.sha);
    expect(await store.push()).toEqual({ sha: a.sha, commits: 1, forced: true });
    expect(await git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(a.sha);

    // 리뷰어가 같은 브랜치에 커밋을 올린다
    const reviewer = path.join(base, 'reviewer');
    await execFileAsync('git', ['clone', '-q', '--branch', BRANCH, remote, reviewer]);
    await writeFile(path.join(reviewer, 'NOTE.md'), 'review\n');
    await git(reviewer, 'add', '-A');
    await git(reviewer, 'commit', '-q', '-m', 'review note');
    await git(reviewer, 'push', '-q', 'origin', 'HEAD');
    const theirs = await git(reviewer, 'rev-parse', 'HEAD');

    await writeFile(order, 'class Order { String c; }\n');
    await store.commit('요청: C');
    await expect(store.push()).rejects.toThrow('덮어쓰지 않았습니다');
    expect(await git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(theirs);
  });

  it('원본의 커밋하지 않은 변경은 세션에 들어가지 않고 개수만 알려 준다', async () => {
    const { source, workDir } = await createSourceRepository();
    await writeFile(path.join(source, 'DRAFT.md'), 'wip\n');
    await writeFile(path.join(source, 'README.md'), '# changed\n');

    const { source: info } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });

    expect(info.dirtyFiles).toBe(2);
    await expect(readFile(path.join(workDir, 'DRAFT.md'), 'utf8')).rejects.toThrow();
    expect(await readFile(path.join(workDir, 'README.md'), 'utf8')).toBe('# orders\n');
  });

  it('origin이 없는 원본은 원본 저장소에 세션 브랜치를 올린다', async () => {
    const { source, workDir } = await createSourceRepository();
    await git(source, 'remote', 'remove', 'origin');
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });

    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');
    const checkpoint = (await store.commit('요청: 메모 추가'))!;
    await store.push();

    expect((await store.repository())?.remoteUrl).toBe(await realpath(source));
    expect(await git(source, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(checkpoint.sha);
    // 원본의 체크아웃 브랜치와 작업 트리는 그대로다
    expect(await git(source, 'branch', '--show-current')).toBe('main');
  });

  it('모노레포 하위 폴더는 명시하면 저장소 전체를 복제하고, 경로는 프로젝트 폴더 기준으로 주고받는다', async () => {
    const { source, remote, workDir } = await createSourceRepository();
    const project = path.join(source, 'api');
    // 프로젝트 안의 변경만 센다
    await writeFile(path.join(project, 'DRAFT.md'), 'wip\n');
    await writeFile(path.join(source, 'OTHER.md'), 'other team\n');
    expect(await CheckpointStore.inspectSource(project)).toBeUndefined();
    expect(await CheckpointStore.inspectSource(project, { allowSubfolder: true })).toEqual({ base: 'main', originUrl: remote, dirtyFiles: 1, subdir: 'api' });

    const { store, start, projectRoot } = await CheckpointStore.clone(project, workDir, { branch: BRANCH, allowSubfolder: true });
    expect(projectRoot).toBe(path.join(workDir, 'api'));
    expect(start.files).toEqual(['src/Order.java']);
    expect(await readFile(path.join(workDir, 'README.md'), 'utf8')).toBe('# orders\n');
    expect((await store.repository())?.subdir).toBe('api');

    await writeFile(path.join(projectRoot, 'src/Order.java'), 'class Order { String memo; }\n');
    await writeFile(path.join(projectRoot, 'src/Memo.java'), 'class Memo {}\n');
    expect(await store.pendingFiles()).toEqual(['src/Memo.java', 'src/Order.java']);
    expect(await store.pendingChanges()).toEqual([
      { file: 'src/Memo.java', change: 'added' },
      { file: 'src/Order.java', change: 'modified' },
    ]);
    expect(await store.pendingPatch('src/Order.java')).toContain('+++ b/src/Order.java');
    const checkpoint = (await store.commit('요청: 메모'))!;
    expect(checkpoint.files).toEqual(['src/Memo.java', 'src/Order.java']);
    expect(await store.patch(checkpoint.sha)).toContain('+++ b/src/Order.java');

    await writeFile(path.join(projectRoot, 'src/Order.java'), 'broken\n');
    expect(await store.discard()).toMatchObject({ files: ['src/Order.java'] });
    expect(await store.restore(start.sha)).toMatchObject({ files: ['src/Memo.java', 'src/Order.java'] });

    await writeFile(path.join(projectRoot, 'src/Memo.java'), 'class Memo {}\n');
    await store.commit('요청: 메모 다시');
    await store.push();
    // 원격에는 저장소 루트 기준 경로로 올라간다
    expect(await git(remote, 'show', `refs/heads/${BRANCH}:api/src/Memo.java`)).toBe('class Memo {}');
    // 서버를 다시 시작해도 작업 복사본만으로 프로젝트 폴더를 찾는다
    expect(await new CheckpointStore(workDir).projectRoot()).toBe(path.join(workDir, 'api'));
  });

  it('하위 폴더 프로젝트의 문서 체크포인트가 프로젝트 폴더 밖 파일도 바꿨으면 outsideFiles로 드러난다', async () => {
    const { source, workDir } = await createSourceRepository();
    const { store, projectRoot } = await CheckpointStore.clone(path.join(source, 'api'), workDir, { branch: BRANCH, allowSubfolder: true });

    // 프로젝트 안의 문서만 바꾼 문서 체크포인트: 폴더 밖 변경이 없다
    await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    await writeFile(path.join(projectRoot, 'docs/requirements.md'), '# 요구사항\n');
    const inside = (await store.commitPaths(['docs/requirements.md'], '문서: 요구사항', undefined, { trailers: [formatVerifyTrailer('docs')] }))!;
    expect(inside.verify).toBe('docs');
    expect(inside.files).toEqual(['docs/requirements.md']);
    expect(inside.outsideFiles).toBeUndefined();

    // 같은 표시를 달았지만 저장소의 프로젝트 폴더 밖 파일도 함께 바꾼 커밋: files에는 안 보이고 outsideFiles로만 드러난다
    await writeFile(path.join(projectRoot, 'docs/requirements.md'), '# 요구사항\n고침\n');
    await writeFile(path.join(workDir, 'README.md'), '# orders\n폴더 밖 변경\n');
    await git(workDir, 'add', '-A');
    await git(workDir, '-c', 'user.name=b-studio', '-c', 'user.email=checkpoints@b-studio.local', 'commit', '-q', '-m', `문서: 섞인 커밋\n\n${formatVerifyTrailer('docs')}`);
    const mixed = (await store.list())[0]!;
    expect(mixed.verify).toBe('docs');
    expect(mixed.files).toEqual(['docs/requirements.md']);
    expect(mixed.outsideFiles).toBe(1);
  });

  it('문서 체크포인트 표시를 단 커밋이 코드 파일을 문서 이름으로 옮겼으면, 목록에는 새 이름만 보여도 outsideFiles로 드러난다', async () => {
    const { source, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });

    // 코드 파일을 그대로 문서 경로로 옮긴다: git은 이름 바꾸기로 보고 새 이름만 보여 준다(원래 파일은 사라졌다)
    await mkdir(path.join(workDir, 'docs'), { recursive: true });
    await git(workDir, 'mv', 'api/src/Order.java', 'docs/requirements.md');
    await git(workDir, '-c', 'user.name=b-studio', '-c', 'user.email=checkpoints@b-studio.local', 'commit', '-q', '-m', `문서: 옮긴 커밋\n\n${formatVerifyTrailer('docs')}`);
    const moved = (await store.list())[0]!;
    expect(moved.verify).toBe('docs');
    expect(moved.files).toEqual(['docs/requirements.md']);
    expect(moved.outsideFiles).toBe(1);
  });

  it('Git 저장소 루트가 아닌 폴더는 복제하지 않고, 세션 이전 기록으로는 되돌리지 않는다', async () => {
    const { source, workDir } = await createSourceRepository();
    expect(await CheckpointStore.inspectSource(path.join(source, 'api'))).toBeUndefined();
    await expect(CheckpointStore.clone(path.join(source, 'api'), workDir, { branch: BRANCH })).rejects.toThrow(CheckpointError);

    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const firstCommit = await git(source, 'rev-list', '--max-parents=0', 'HEAD');
    await expect(store.restore(firstCommit)).rejects.toThrow('세션 기록에 없는');
  });

  it('commitPaths는 지정한 경로만 커밋하고, 범위 밖 변경은 그대로 남기고, 범위 안에 변경이 없으면 건너뛴다(ADR-096)', async () => {
    const { source, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });

    // 범위 안에 변경이 없으면 undefined(건너뛴다)
    expect(await store.commitPaths(['docs/requirements.md'], '문서: 요구사항')).toBeUndefined();

    await mkdir(path.join(workDir, 'docs'), { recursive: true });
    await writeFile(path.join(workDir, 'docs/requirements.md'), '# 요구사항\n');
    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');

    const checkpoint = (await store.commitPaths(['docs/requirements.md'], '문서: 요구사항을 정리한다', undefined, {
      trailers: [formatVerifyTrailer('docs')],
    }))!;

    expect(checkpoint.files).toEqual(['docs/requirements.md']);
    expect(checkpoint.verify).toBe('docs');
    expect(checkpoint.passedStages).toBeUndefined();
    // 범위 밖(api/src/Order.java)의 변경은 커밋되지 않고 그대로 남는다
    expect(await store.pendingFiles()).toEqual(['api/src/Order.java']);
  });

  it('fileAt은 커밋된 파일 내용을 읽고, 작업 트리에서 바뀐 값이나 없는 파일에는 속지 않는다(ADR-157)', async () => {
    const { source, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    expect(await store.fileAt('docs/requirements.md')).toBeUndefined();

    await mkdir(path.join(workDir, 'docs'), { recursive: true });
    await writeFile(path.join(workDir, 'docs/requirements.md'), '# 요구사항\n');
    await store.commitPaths(['docs/requirements.md'], '문서: 요구사항');

    // 작업 트리를 고쳐도 커밋된 값을 돌려준다
    await writeFile(path.join(workDir, 'docs/requirements.md'), '# 바꾼 값\n');
    expect(await store.fileAt('docs/requirements.md')).toBe('# 요구사항\n');
  });

  it('commitPaths도 시크릿 값이 든 파일은 커밋하지 않는다', async () => {
    const { source, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    await mkdir(path.join(workDir, 'docs'), { recursive: true });
    await writeFile(path.join(workDir, 'docs/requirements.issues.json'), '{"token":"sk_live_1234567890"}\n');
    const findSecrets = (text: string) => (text.includes('sk_live_1234567890') ? ['TOKEN'] : []);

    await expect(store.commitPaths(['docs/requirements.issues.json'], '문서: 이슈 발행 기록', undefined, { findSecrets })).rejects.toThrow(
      'docs/requirements.issues.json (TOKEN)',
    );
    expect(await store.pendingFiles()).toEqual(['docs/requirements.issues.json']);
  });

  it('다른 세션의 작업 복사본과 체크포인트 sha로 레인·통합 세션을 시작할 수 있다(ADR-096): 기준 브랜치는 그 세션이 기록해 둔 값을 물려받는다', async () => {
    const { source, remote, workDir } = await createSourceRepository();
    const origin = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    await mkdir(path.join(workDir, 'docs'), { recursive: true });
    await writeFile(path.join(workDir, 'docs/requirements.md'), '# 요구사항\n');
    const docsCheckpoint = (await origin.store.commitPaths(['docs/requirements.md'], '문서: 요구사항을 정리한다'))!;
    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');
    await origin.store.commit('요청: 메모 추가');

    // 세션이 origin 브랜치(b-studio/orders-s1)를 체크아웃한 채로도, 문서 체크포인트 시점에서 레인을 새로 시작할 수 있다
    const laneWorkDir = path.join(workDir, '..', 'lane-1');
    const { store: lane, source: info } = await CheckpointStore.clone(workDir, laneWorkDir, { branch: 'b-studio/orders-lane1', ref: docsCheckpoint.sha });

    // 메타의 기준 브랜치는 origin 세션 브랜치가 아니라 origin이 물려받은 실제 기준 브랜치(main)다
    expect(info.base).toBe('main');
    expect(info.originUrl).toBe(remote);
    expect((await lane.repository())?.base).toBe('main');
    expect((await lane.repository())?.branch).toBe('b-studio/orders-lane1');
    // 내용은 문서 체크포인트 시점(메모 추가 전)이다
    expect(await readFile(path.join(laneWorkDir, 'docs/requirements.md'), 'utf8')).toBe('# 요구사항\n');
    expect(await readFile(path.join(laneWorkDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');
  });

  it('git 오류 메시지에서 주소의 자격 증명을 지운다', () => {
    expect(redactCredentials("fatal: unable to access 'https://bot:ghp_secret@github.com/acme/orders.git/': 403")).toBe(
      "fatal: unable to access 'https://***@github.com/acme/orders.git/': 403",
    );
  });
});

/** 세션이 갈라져 나온 뒤(main) 브랜치에 다른 사람이 커밋을 올린다 */
async function pushToBase(base: string, remote: string, file: string, content: string, message: string): Promise<string> {
  const other = await mkdtemp(path.join(base, 'main-writer-'));
  await execFileAsync('git', ['clone', '-q', '--branch', 'main', remote, other]);
  await mkdir(path.dirname(path.join(other, file)), { recursive: true });
  await writeFile(path.join(other, file), content);
  await git(other, 'add', '-A');
  await git(other, 'commit', '-q', '-m', message);
  await git(other, 'push', '-q', 'origin', 'HEAD');
  return git(other, 'rev-parse', 'HEAD');
}

describe('CheckpointStore main 따라잡기 (ADR-076)', () => {
  it('기준 브랜치가 앞서 있으면 behind로 세고, 다시 가져올 때까지는(throttle) 새 커밋을 보지 못한다', async () => {
    const { base, source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });

    expect(await store.baseStatus()).toMatchObject({ base: 'main', behind: 0 });

    await pushToBase(base, remote, 'CHANGELOG.md', '# changes\n', 'main 변경');
    // 방금 가져왔으므로(throttle 안) 강제로 다시 가져오지 않으면 새 커밋을 보지 못한다
    const throttled = await store.baseStatus();
    expect(throttled).toMatchObject({ base: 'main', behind: 0 });

    const forced = await store.baseStatus({ force: true });
    expect(forced).toMatchObject({ base: 'main', behind: 1 });
    expect(Date.parse(forced.lastFetchedAt)).toBeGreaterThanOrEqual(Date.parse(throttled.lastFetchedAt));
  });

  it('가져올 것이 없으면 병합하지 않고 up-to-date를 돌려준다', async () => {
    const { source, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const head = await git(workDir, 'rev-parse', 'HEAD');

    expect(await store.integrateBase()).toMatchObject({ status: 'up-to-date', commits: [], files: [] });
    expect(await git(workDir, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('main을 병합 커밋으로 따라잡는다: 첫 부모는 이 세션, 두 번째 부모는 main이다', async () => {
    const { base, source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const order = path.join(workDir, 'api/src/Order.java');
    await writeFile(order, 'class Order { String mine; }\n');
    const mine = (await store.commit('요청: 내 변경'))!;

    const theirs = await pushToBase(base, remote, 'CHANGELOG.md', '# changes\n', 'main 변경');

    const result = await store.integrateBase();
    expect(result).toMatchObject({
      status: 'merged',
      remoteSha: theirs,
      files: ['CHANGELOG.md'],
      previous: mine.sha,
      commits: [{ sha: theirs, subject: 'main 변경', author: 'test' }],
      checkpoint: { message: 'main을 따라잡는다 (1커밋)', files: ['CHANGELOG.md'] },
    });
    expect(await readFile(path.join(workDir, 'CHANGELOG.md'), 'utf8')).toBe('# changes\n');
    // 내 변경은 그대로 남는다
    expect(await readFile(order, 'utf8')).toBe('class Order { String mine; }\n');

    const parents = (await git(workDir, 'rev-list', '--parents', '-n1', result.checkpoint!.sha)).split(' ');
    expect(parents[0]).toBe(result.checkpoint!.sha);
    expect(parents[1]).toBe(mine.sha);
    expect(parents[2]).toBe(theirs);
  });

  it('main과 같은 곳을 고쳤으면 아무것도 바꾸지 않고 충돌한 파일을 알린다', async () => {
    const { base, source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const order = path.join(workDir, 'api/src/Order.java');
    await writeFile(order, 'class Order { String mine; }\n');
    const mine = (await store.commit('요청: 내 변경'))!;

    await pushToBase(base, remote, 'api/src/Order.java', 'class Order { String main; }\n', 'main 변경');

    const error = await store.integrateBase().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RemoteConflictError);
    expect((error as RemoteConflictError).conflicts).toEqual(['api/src/Order.java']);
    expect(await git(workDir, 'rev-parse', 'HEAD')).toBe(mine.sha);
    expect(await store.pendingFiles()).toEqual([]);
    expect(await readFile(order, 'utf8')).toBe('class Order { String mine; }\n');
    await expect(git(workDir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')).rejects.toThrow();
  });

  it('체크포인트로 남기지 않은 변경이 있으면 따라잡지 않는다', async () => {
    const { source, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String pending; }\n');

    await expect(store.integrateBase()).rejects.toThrow('체크포인트로 저장하지 않은 변경');
  });
});

/** 폴더 열기(ADR-067)가 하듯, root의 .git/info/exclude에 패턴을 더해 그 경로를 이 저장소의 git 추적에서 뺀다 */
async function excludeFromRoot(pattern: string): Promise<void> {
  await mkdir(path.join(root, '.git', 'info'), { recursive: true });
  await appendFile(path.join(root, '.git', 'info', 'exclude'), `${pattern}\n`);
}

describe('CheckpointStore 생성 파일(제외됨) 스냅샷 (ADR-141, 도그푸딩 마찰 127)', () => {
  it('실패한 실행이 고친 생성 파일(git 추적 밖)도 discard가 되돌리고, 새로 생긴 파일은 지운다', async () => {
    const store = new CheckpointStore(root, { excludedFiles: async () => ['studio.yaml', 'Dockerfile.b-studio'] });
    const start = await store.init();
    // 폴더 열기가 쓴 생성 파일을 세션 시작 뒤에 끼워 넣는 것과 같은 순서(overlayGeneratedFiles 다음에 스냅샷)
    await write('studio.yaml', 'version: 1\n');
    await excludeFromRoot('/studio.yaml');
    await excludeFromRoot('Dockerfile.b-studio');
    await store.refreshExcludedSnapshot(start.sha);

    // 실패할 실행: 추적되는 파일, 기존 생성 파일, 새로 찾은 서비스의 Dockerfile을 모두 고친다
    await write('api/src/Order.java', 'class Order { int broken }\n');
    await write('studio.yaml', 'version: 2\nworkflow:\n  tests: true\n');
    await write('Dockerfile.b-studio', 'FROM node\n');

    const { files } = await store.discard();

    expect(files.sort()).toEqual(['Dockerfile.b-studio', 'api/src/Order.java', 'studio.yaml']);
    expect(await read('api/src/Order.java')).toBe('class Order {}\n');
    expect(await read('studio.yaml')).toBe('version: 1\n');
    await expect(read('Dockerfile.b-studio')).rejects.toThrow();
  });

  it('대상 체크포인트에 생성 파일 스냅샷이 없으면(기능 이전 체크포인트) 생성 파일을 지우지 않는다(도그푸딩 회귀: 세션 재개가 studio.yaml·compose를 지웠다)', async () => {
    // 스냅샷 기능 이전에 만든 체크포인트를 흉내 낸다: excludedFiles 없이 시작한다
    const before = new CheckpointStore(root);
    await before.init();
    await write('studio.yaml', 'version: 1\n');
    await write('compose.b-studio.yaml', 'services: {}\n');
    await excludeFromRoot('/studio.yaml');
    await excludeFromRoot('/compose.b-studio.yaml');
    await write('api/src/Order.java', 'class Order { int pending }\n');

    // 기능이 들어온 뒤 같은 저장소를 다시 연다. HEAD 체크포인트에는 스냅샷이 없다
    const store = new CheckpointStore(root, { excludedFiles: async () => ['studio.yaml', 'compose.b-studio.yaml'] });
    const { files } = await store.discard();

    expect(files).toEqual(['api/src/Order.java']);
    expect(await read('studio.yaml')).toBe('version: 1\n');
    expect(await read('compose.b-studio.yaml')).toBe('services: {}\n');
  });

  it('버리기 전에 생성 파일도 백업하고, 되살리기로 그대로 되돌린다', async () => {
    const store = new CheckpointStore(root, { excludedFiles: async () => ['studio.yaml'] });
    const start = await store.init();
    await write('studio.yaml', 'version: 1\n');
    await excludeFromRoot('/studio.yaml');
    await store.refreshExcludedSnapshot(start.sha);

    await write('studio.yaml', 'version: 2\n');
    const { backup } = await store.discard();
    expect(backup).toMatchObject({ files: ['studio.yaml'] });
    expect(await read('studio.yaml')).toBe('version: 1\n');

    const restored = await store.restoreBackup(backup!.id);
    expect(restored.files).toEqual(['studio.yaml']);
    expect(await read('studio.yaml')).toBe('version: 2\n');
  });

  it('더 이른 체크포인트로 복원하면 생성 파일도 그 시점 내용으로 돌아간다', async () => {
    const store = new CheckpointStore(root, { excludedFiles: async () => ['studio.yaml'] });
    const start = await store.init();
    await write('studio.yaml', 'version: 1\n');
    await excludeFromRoot('/studio.yaml');
    await store.refreshExcludedSnapshot(start.sha);

    await write('api/src/Order.java', 'class Order { String memo; }\n');
    const checkpoint1 = (await store.commit('요청: 메모'))!;

    await write('studio.yaml', 'version: 2\n');
    await write('api/src/Order.java', 'class Order { String memo; String note; }\n');
    await store.commit('요청: 필드 추가');

    // 체크포인트 사이에 아직 체크포인트로 남기지 않은(중간에 바뀐) 내용도 있는 채로 복원한다
    await write('studio.yaml', 'version: 3-mid-flight\n');
    const { files } = await store.restore(checkpoint1.sha);

    expect(files).toContain('studio.yaml');
    expect(await read('studio.yaml')).toBe('version: 1\n');
  });

  it('commitPaths로 문서만 남긴 체크포인트는 생성 파일 변경을 받아들이지 않아, 뒤이은 discard가 그대로 되돌린다', async () => {
    const store = new CheckpointStore(root, { excludedFiles: async () => ['studio.yaml'] });
    const start = await store.init();
    await write('studio.yaml', 'version: 1\n');
    await excludeFromRoot('/studio.yaml');
    await store.refreshExcludedSnapshot(start.sha);

    // 실패할 실행: 문서와 studio.yaml을 함께 고친다
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await write('docs/requirements.md', '# 요구사항\n');
    await write('studio.yaml', 'version: 2\n');

    // 지키기: 되돌리기 전에 문서만 먼저 체크포인트로 남긴다(protectPendingDocsBeforeDiscard와 같은 모양)
    const docsCheckpoint = await store.commitPaths(['docs/requirements.md'], '지키기: 문서를 남긴다');
    expect(docsCheckpoint).toBeDefined();

    // 남은 변경(studio.yaml)을 버린다 — commitPaths가 생성 파일의 "지금 디스크" 상태를 받아들였다면 여기서 못 돌아간다
    const { files } = await store.discard();
    expect(files).toEqual(['studio.yaml']);
    expect(await read('studio.yaml')).toBe('version: 1\n');
    expect(await read('docs/requirements.md')).toBe('# 요구사항\n');
  });

  it('git이 무시하지 않는(평범하게 추적되는) studio.yaml은 생성 파일 스냅샷이 건드리지 않는다', async () => {
    const store = new CheckpointStore(root, { excludedFiles: async () => ['studio.yaml'] });
    await write('studio.yaml', 'version: 1\n');
    await store.init(); // 제외하지 않았으므로 studio.yaml은 평범하게 커밋된다

    expect(await store.pendingExcludedFiles()).toEqual([]);

    await write('studio.yaml', 'version: 2\n');
    await write('api/src/Order.java', 'class Order { int broken }\n');
    const { files } = await store.discard();

    // 평범하게 추적되는 파일은 git 쪽(pendingFiles) 경로로 되돌아간다 — 생성 파일 쪽 로직이 중복으로 손대지 않는다
    expect(files.sort()).toEqual(['api/src/Order.java', 'studio.yaml']);
    expect(await read('studio.yaml')).toBe('version: 1\n');
  });

  it('excludedFiles를 주지 않으면(평범한 세션) 아무 영향이 없다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    expect(await store.pendingExcludedFiles()).toEqual([]);
    await expect(store.refreshExcludedSnapshot()).resolves.toBeUndefined();
  });

  it('내 폴더 세션(workspace: local)처럼 작업 폴더 밖 별도 gitDir을 쓰면, 원본 폴더의 exclude와 무관하게 studio.yaml을 평범하게 추적한다', async () => {
    // registerFolder가 원본 폴더(root)의 .git/info/exclude에 studio.yaml을 뺀 상태를 흉내 낸다
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', '내 커밋');
    await excludeFromRoot('/studio.yaml');
    await write('studio.yaml', 'version: 1\n');

    // CheckpointStore는 별도 gitDir(세션 상태 폴더)을 쓴다 — 원본 폴더의 .git/info/exclude를 보지 않는다
    const gitDir = path.join(root, '..', `${path.basename(root)}-state`, '.git');
    const store = new CheckpointStore(root, { gitDir, excludedFiles: async () => ['studio.yaml'] });
    await store.init('세션 시작 (내 폴더)');

    // excludedFiles를 줬어도, 이 저장소(별도 gitDir) 기준으로는 studio.yaml이 무시 대상이 아니므로 평범하게 추적된다
    expect(await store.pendingExcludedFiles()).toEqual([]);
    expect(await store.pendingFiles()).toEqual([]); // 이미 세션 시작 커밋에 들어갔다

    await write('studio.yaml', 'version: 2\n');
    expect(await store.pendingFiles()).toEqual(['studio.yaml']);
    const { files } = await store.discard();
    expect(files).toEqual(['studio.yaml']);
    expect(await read('studio.yaml')).toBe('version: 1\n');

    // 원본 폴더의 .git은 그대로다(별도 gitDir이라 건드리지 않는다)
    expect(await git(root, 'log', '--format=%s')).toBe('내 커밋');
  });
});
