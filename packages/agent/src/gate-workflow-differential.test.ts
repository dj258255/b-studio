import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RegularFileRead } from './workspace';
import * as legacy from './gate-workflow-legacy';
import * as current from './gate-workflow';

/**
 * 2단계 (b): 게이트가 끝에 다시 읽는 두 파일. 같은 폴더·같은 스냅샷을 옛 TS(`gate-workflow-legacy.ts`)와
 * 새 구현(Rust `bstudio-io::gate_workflow`)에 주고 결과(값·오류 글·검사 목록·순서)를 견준다.
 * 게이트를 막는 판정이라 읽지 못하는 자리(링크·폴더·큰 파일·형식 오류)가 통과가 아니라 실패인지도 함께 본다.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gate-workflow-diff-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function file(relative: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

const SPEC = `version: 1
name: orders
services:
  web:
    source: managed
    template: nextjs
    path: web
    port: 3000
    preview: browser
workflow:
  required: [plan, implement, run]
  maxTurns: 30
`;
const SPEC_NO_WORKFLOW = `version: 1
name: orders
services:
  web:
    source: managed
    template: nextjs
    path: web
    port: 3000
    preview: browser
`;
const COMPOSE = `services:
  web:
    image: node:22
`;

const REQUIREMENT = (extra: string) => `# 요구사항

## R1. 제목
- 종류: api · 우선순위: must
- 인수 조건:
  - a
${extra}- 상태: 미착수
`;
const MANUAL = '- 확인: 범수 · 2026-10-01 · 체크포인트 abc1234 · 메모 화면에서 확인\n';
const MANUAL_CHANGED = '- 확인: 다른사람 · 2026-10-02 · 체크포인트 def5678 · 메모 고침\n';

const redact = (text: string) => `[R]${text}`;

async function compareLatest(always: boolean, changed: readonly string[], label: string): Promise<void> {
  const left = await legacy.legacyLatestWorkflow(root, always, () => changed, redact);
  const shouldRead = always || changed.includes('studio.yaml');
  const right = shouldRead ? await current.latestWorkflow(root, redact) : undefined;
  if (isDeepStrictEqual(left, right)) return;
  expect(right, label).toEqual(left);
}

async function compareRecords(before: RegularFileRead, label: string): Promise<void> {
  const workspace = { root, snapshotRead: () => before } as unknown as Parameters<typeof legacy.legacyRequirementRecordChecks>[1];
  const left = await legacy.legacyRequirementRecordChecks(root, workspace, before);
  const right = await current.requirementRecordChecks(root, before);
  if (isDeepStrictEqual(left, right)) return;
  expect(right, label).toEqual(left);
}

describe('gate-workflow: 옛 TS와 Rust가 같다', () => {
  it('studio.yaml의 workflow 읽기·없음·안 바뀜·형식 오류가 같다', async () => {
    await file('studio.yaml', SPEC);
    await file('compose.yaml', COMPOSE);
    await compareLatest(true, [], 'valid always');
    await compareLatest(false, [], 'not changed');
    await compareLatest(false, ['studio.yaml'], 'changed');
    await compareLatest(false, ['compose.yaml'], 'other changed');

    await file('studio.yaml', SPEC_NO_WORKFLOW);
    await compareLatest(true, [], 'no workflow');

    await file('studio.yaml', 'version: 1\nname: Bad\nteam: x\nservices: {}\n');
    await compareLatest(true, [], 'schema error');

    await file('studio.yaml', 'secret: [1,\nname: oops\n');
    await compareLatest(true, [], 'yaml syntax');

    await rm(path.join(root, 'compose.yaml'));
    await file('studio.yaml', SPEC);
    await compareLatest(true, [], 'compose missing');
  });

  it('읽을 수 없는 studio.yaml 자리(없음·링크·폴더·큰 파일)가 실패로 같다', async () => {
    await compareLatest(true, [], 'missing');

    await file('real.yaml', SPEC);
    await symlink(path.join(root, 'real.yaml'), path.join(root, 'studio.yaml'));
    await compareLatest(true, [], 'symlink');

    await rm(path.join(root, 'studio.yaml'));
    await mkdir(path.join(root, 'studio.yaml'));
    await compareLatest(true, [], 'directory');

    await rm(path.join(root, 'studio.yaml'), { recursive: true });
    await file('studio.yaml', 'x'.repeat(256 * 1024 + 1));
    await compareLatest(true, [], 'too large for precheck');
  });

  it('요구사항 기록: 없음·같음·새 기록·바뀐 기록·지운 기록이 같다', async () => {
    const missing: RegularFileRead = { kind: 'missing' };
    await compareRecords(missing, 'both missing');

    await file('docs/requirements.md', REQUIREMENT(''));
    await compareRecords(missing, 'new document without records');
    await compareRecords({ kind: 'text', content: REQUIREMENT('') }, 'unchanged');
    await compareRecords({ kind: 'text', content: REQUIREMENT('') }, 'new manual record after empty before');

    await file('docs/requirements.md', REQUIREMENT(MANUAL));
    await compareRecords({ kind: 'text', content: REQUIREMENT('') }, 'forged');
    await compareRecords({ kind: 'text', content: REQUIREMENT(MANUAL) }, 'unchanged with record');
    await compareRecords(missing, 'new document with record');

    await file('docs/requirements.md', REQUIREMENT(MANUAL_CHANGED));
    await compareRecords({ kind: 'text', content: REQUIREMENT(MANUAL) }, 'changed record');

    await file('docs/requirements.md', REQUIREMENT(''));
    await compareRecords({ kind: 'text', content: REQUIREMENT(MANUAL) }, 'removed record');
    await compareRecords({ kind: 'irregular', reason: '읽을 수 없습니다' }, 'before irregular');

    // 예약 글자(U+E000)도 양쪽이 같은 인코딩으로 견준다
    await file('docs/requirements.md', REQUIREMENT(MANUAL.replace('메모', '메모\uE000')));
    await compareRecords({ kind: 'text', content: REQUIREMENT('') }, 'reserved char');
  });

  it('요구사항 문서 자리가 링크·폴더·큰 파일이면 실패로 같다(통과 아님)', async () => {
    await file('real.md', REQUIREMENT(MANUAL));
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await symlink(path.join(root, 'real.md'), path.join(root, 'docs/requirements.md'));
    await compareRecords({ kind: 'missing' }, 'symlink');

    await rm(path.join(root, 'docs/requirements.md'));
    await mkdir(path.join(root, 'docs/requirements.md'));
    await compareRecords({ kind: 'missing' }, 'directory');

    await rm(path.join(root, 'docs/requirements.md'), { recursive: true });
    await file('docs/requirements.md', 'x'.repeat(256 * 1024 + 1));
    await compareRecords({ kind: 'missing' }, 'too large');

    const right = await current.requirementRecordChecks(root, { kind: 'missing' });
    expect(right).toMatchObject([{ stage: 'review', name: 'manual-verification', ok: false, attempts: 1 }]);
    expect(right[0]?.detail).toContain('일반 파일로 되돌리세요');
  });

  it('요구사항 before 스냅샷의 세 꼴(글·없음·읽을 수 없음)이 같다', async () => {
    await file('docs/requirements.md', REQUIREMENT(MANUAL));
    const snapshots: RegularFileRead[] = [
      { kind: 'text', content: REQUIREMENT(MANUAL) },
      { kind: 'text', content: REQUIREMENT('') },
      { kind: 'missing' },
      { kind: 'irregular', reason: '일반 파일이 아닙니다' },
    ];
    for (const snapshot of snapshots) await compareRecords(snapshot, JSON.stringify(snapshot));
  });
});
