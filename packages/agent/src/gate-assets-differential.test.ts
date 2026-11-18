import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeNative, native } from '@b-studio/sandbox';
import {
  legacyEvaluationAssetChecks,
  legacyFingerprintEvaluationAssets,
  type LegacyBaseline,
} from './gate-assets-legacy';

/**
 * D2 (a): 평가 자산 지문·훑기와 그 판정을 Rust로 옮긴 조각의 차등 시험.
 * 같은 폴더를 옛 TS(`gate-assets-legacy.ts`)와 새 구현(guard+io)에 주고 지문·검사 결과·오류 글을 견준다.
 * 이 판정은 게이트를 막는 쪽이라, 견줄 수 없는 입력(링크·상한·큰 파일)이 실패로 나오는지도 함께 본다.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gate-assets-diff-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function file(relative: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

type BaselineJson = { kind: 'ok'; digests: Array<[string, string]> } | { kind: 'error'; detail: string };

function toJson(baseline: LegacyBaseline): BaselineJson {
  if (baseline.kind === 'error') return baseline;
  return { kind: 'ok', digests: [...baseline.digests].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) };
}

function normalize(baseline: BaselineJson): BaselineJson {
  if (baseline.kind === 'error') return baseline;
  return { kind: 'ok', digests: [...baseline.digests].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) };
}

async function currentFingerprint(assets: string[]): Promise<BaselineJson> {
  return decodeNative<BaselineJson>(await native.gateFingerprintEvaluationAssets(root, assets));
}

async function currentChecks(assets: string[], baseline: BaselineJson, hasTests: boolean) {
  return decodeNative<Array<{ stage: string; name: string; ok: boolean; attempts: number; detail?: string }>>(
    await native.gateEvaluateEvaluationAssets(root, assets, JSON.stringify(baseline), hasTests),
  );
}

describe('평가 자산 지문·판정 차등(D2a)', () => {
  it('파일·폴더·없는 경로·정규화·바이너리·유니코드 이름이 옛 구현과 같다', async () => {
    await file('assets/a.txt', 'a');
    await file('assets/nested/B.bin', Buffer.from([0, 1, 255]));
    await mkdir(path.join(root, 'assets/empty'), { recursive: true });
    await file('assets/Z.txt', 'z');
    await file('assets/é.txt', 'nfc');
    await file('assets/e\u0301.txt', 'nfd');
    const cases = [['assets'], ['missing'], ['assets/nested'], ['assets/../assets'], ['assets/nested/B.bin'], ['assets/empty']];
    for (const assets of cases) {
      const legacy = toJson(await legacyFingerprintEvaluationAssets(root, assets));
      const current = await currentFingerprint(assets);
      expect(normalize(current), assets.join(',')).toEqual(normalize(legacy));
    }
  });

  it('링크·상위 링크·큰 파일은 실패로 알린다(글자까지 같다)', async () => {
    await file('assets/a.txt', 'a');
    await symlink(path.join(root, 'assets/a.txt'), path.join(root, 'assets/link'));
    await mkdir(path.join(root, 'real'), { recursive: true });
    await file('real/child.txt', 'child');
    await symlink(path.join(root, 'real'), path.join(root, 'linked'));
    await file('assets/big.txt', Buffer.alloc(256 * 1024 + 1, 0x61));
    const cases = [['assets/link'], ['assets'], ['linked/child.txt'], ['assets/big.txt']];
    for (const assets of cases) {
      const legacy = toJson(await legacyFingerprintEvaluationAssets(root, assets));
      const current = await currentFingerprint(assets);
      expect(current, assets.join(',')).toEqual(legacy);
    }
  });

  it('파일 수 상한(2,000)을 넘으면 실패한다', async () => {
    await mkdir(path.join(root, 'many'), { recursive: true });
    await Promise.all(Array.from({ length: 2_001 }, (_, index) => writeFile(path.join(root, 'many', `f${String(index).padStart(4, '0')}.txt`), 'x')));
    const legacy = toJson(await legacyFingerprintEvaluationAssets(root, ['many']));
    const current = await currentFingerprint(['many']);
    expect(current).toEqual(legacy);
    expect(current).toMatchObject({ kind: 'error', detail: expect.stringContaining('파일이 2000개를 넘습니다') });
  });

  it('검사 결과: 같음·바뀜·기준선 오류·지금 오류·단계·스무 개 초과 목록', async () => {
    await file('assets/a.txt', 'a');
    await file('assets/b.txt', 'b');

    const unchanged = toJson(await legacyFingerprintEvaluationAssets(root, ['assets']));
    for (const hasTests of [true, false]) {
      const legacy = legacyEvaluationAssetChecks(true, hasTests, await legacyFingerprintEvaluationAssets(root, ['assets']), await legacyFingerprintEvaluationAssets(root, ['assets']));
      expect(await currentChecks(['assets'], unchanged, hasTests)).toEqual(legacy);
    }

    // 한 파일 바꿈
    const base = unchanged as { kind: 'ok'; digests: Array<[string, string]> };
    const changedMap: LegacyBaseline = { kind: 'ok', digests: new Map([...base.digests, ['assets/b.txt', '0'.repeat(64)]]) };
    const legacyChanged = legacyEvaluationAssetChecks(true, true, await legacyFingerprintEvaluationAssets(root, ['assets']), changedMap);
    expect(await currentChecks(['assets'], toJson(changedMap), true)).toEqual(legacyChanged);

    // 스무 개를 넘게 바꿈(설명의 "외 N개")
    const many = new Map<string, string>();
    for (let index = 0; index < 25; index++) many.set(`assets/f${index}.txt`, '0'.repeat(64));
    const legacyMany = legacyEvaluationAssetChecks(
      true,
      false,
      { kind: 'ok', digests: many },
      await legacyFingerprintEvaluationAssets(root, ['assets']),
    );
    expect(await currentChecks(['assets'], toJson({ kind: 'ok', digests: many }), false)).toEqual(legacyMany);

    // 기준선 오류 / 지금 오류
    const errorBaseline: LegacyBaseline = { kind: 'error', detail: '기준선을 읽지 못했습니다' };
    expect(await currentChecks(['assets'], { kind: 'error', detail: '기준선을 읽지 못했습니다' }, true)).toEqual(
      legacyEvaluationAssetChecks(true, true, errorBaseline, await legacyFingerprintEvaluationAssets(root, ['assets'])),
    );
    await symlink(path.join(root, 'assets/a.txt'), path.join(root, 'assets/link'));
    const currentError = toJson(await legacyFingerprintEvaluationAssets(root, ['assets']));
    expect(await currentChecks(['assets'], unchanged, true)).toEqual(
      legacyEvaluationAssetChecks(true, true, { kind: 'ok', digests: new Map((unchanged as { digests: Array<[string, string]> }).digests) }, await legacyFingerprintEvaluationAssets(root, ['assets'])),
    );
    expect(currentError.kind).toBe('error');
  });

  it('선언이 비면 검사 결과도 빈다', async () => {
    expect(await currentChecks([], { kind: 'ok', digests: [] }, true)).toEqual(legacyEvaluationAssetChecks(false, true, { kind: 'ok', digests: new Map() }, { kind: 'ok', digests: new Map() }));
  });
});
