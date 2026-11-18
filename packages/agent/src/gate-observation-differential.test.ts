import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeNative, native } from '@b-studio/sandbox';
import type { BrowserPageStep } from './browser-check';
import { legacyCompareDesign, legacySaveSteps, legacyServiceOrigins } from './gate-observation-legacy';

/**
 * D2 (c): 화면 확인의 관측(단계 저장·디자인 비교·서비스 출처)을 Rust로 옮긴 조각의 차등 시험.
 * 저장·엔드포인트는 TS 콜백이고, 나머지는 Rust가 한다. 옛 TS(`gate-observation-legacy.ts`)와 같은 값을 내는지 견준다.
 */

function image(width: number, height: number, color: [number, number, number] = [255, 255, 255], pixel?: { x: number; y: number; color: [number, number, number] }): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const value = pixel && pixel.x === x && pixel.y === y ? pixel.color : color;
      png.data[index] = value[0];
      png.data[index + 1] = value[1];
      png.data[index + 2] = value[2];
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gate-observation-diff-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

type SavedStep = { label: string; ok: boolean; detail?: string; artifact?: string };
type CompareOutcome =
  | { ok: true; ratio: number; width: number; height: number; diff: string; reference: string }
  | { ok: false; kind: 'missing' | 'compare' | 'decode'; message: string };

async function currentCompare(reference: string, actual: Buffer, masks: unknown[] = []): Promise<CompareOutcome> {
  return decodeNative<CompareOutcome>(await native.gateCompareDesign(root, reference, JSON.stringify(masks), 0.1, actual.toString('base64')));
}

describe('화면 확인 관측 차등(D2c)', () => {
  it('단계 저장: 저장 성공·실패·스크린샷 없음·상세 문구가 옛 구현과 같다', async () => {
    const steps: BrowserPageStep[] = [
      { label: '첫째', ok: true, screenshot: image(2, 2) },
      { label: '둘째', ok: false, detail: '클릭 실패' },
      { label: '셋째', ok: true, screenshot: Buffer.from([1, 2, 3]) },
    ];
    let saved = 0;
    const save = async ({ name }: { name: string; data: Buffer; contentType: 'image/png' | 'image/jpeg' }): Promise<string> => {
      saved += 1;
      if (saved === 2) throw new Error('디스크 가득');
      return `a${saved}`;
    };
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => void warnings.push(String(message)));
    const legacy = await legacySaveSteps('확인', steps, save);
    const legacyWarnings = [...warnings];

    saved = 0;
    const encoded = steps.map((step) => ({
      label: step.label,
      ok: step.ok,
      ...(step.detail !== undefined ? { detail: step.detail } : {}),
      ...(step.screenshot !== undefined ? { screenshot: step.screenshot.toString('base64') } : {}),
    }));
    const hook = async (text: string): Promise<string> => {
      const request = JSON.parse(text) as { op?: string; name?: string; data?: string };
      if (request.op !== 'saveArtifact') return JSON.stringify({ ok: false });
      try {
        return JSON.stringify({ ok: true, artifact: await save({ name: String(request.name), data: Buffer.from(String(request.data), 'base64'), contentType: 'image/png' }) });
      } catch (error) {
        return JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    };
    const current = decodeNative<{ steps: SavedStep[]; warnings: string[] }>(await native.gateSaveSteps('확인', JSON.stringify(encoded), true, hook));
    expect(current.steps).toEqual(legacy);
    expect(current.warnings).toEqual(legacyWarnings);

    // 저장할 곳이 없으면 스크린샷이 있어도 저장하지 않는다
    const legacyNoSave = await legacySaveSteps('확인', steps);
    const currentNoSave = decodeNative<{ steps: SavedStep[]; warnings: string[] }>(
      await native.gateSaveSteps('확인', JSON.stringify(encoded), false, async () => JSON.stringify({ ok: false })),
    );
    expect(currentNoSave.steps).toEqual(legacyNoSave);
    expect(currentNoSave.warnings).toEqual([]);
  });

  it('디자인 비교: 같음·다름·가림·너비 불일치·깨진 PNG·기준 없음이 옛 구현과 같다', async () => {
    const identical = image(8, 6);
    await writeFile(path.join(root, 'same.png'), identical);
    await writeFile(path.join(root, 'different.png'), image(8, 6, [0, 0, 0]));
    await writeFile(path.join(root, 'wide.png'), image(9, 6));
    await writeFile(path.join(root, 'broken.png'), Buffer.from('not a png'));

    const cases: Array<{ label: string; reference: string; actual?: Buffer; masks?: unknown[]; kind?: 'compare' | 'decode' | 'missing' }> = [
      { label: '같음', reference: 'same.png', actual: identical },
      { label: '다름', reference: 'different.png', actual: identical },
      { label: '가림', reference: 'different.png', actual: identical, masks: [{ x: 0, y: 0, width: 8, height: 6 }] },
      { label: '너비 불일치', reference: 'wide.png', actual: identical, kind: 'compare' },
      { label: '깨진 기준', reference: 'broken.png', actual: identical, kind: 'decode' },
      { label: '깨진 실제', reference: 'same.png', actual: Buffer.from('nope'), kind: 'decode' },
      { label: '기준 없음', reference: 'missing.png', actual: identical, kind: 'missing' },
    ];

    for (const item of cases) {
      const compare = { reference: item.reference, maxDiffRatio: 0.02, threshold: 0.1, masks: item.masks } as never;
      if (item.actual === undefined) {
        await expect(legacyCompareDesign(root, compare, undefined, (text) => text)).rejects.toThrow('디자인 비교에 쓸 뷰포트 스크린샷을 찍지 못했습니다');
        continue;
      }
      let legacyValue: Awaited<ReturnType<typeof legacyCompareDesign>> | undefined;
      let legacyError: Error | undefined;
      try {
        legacyValue = await legacyCompareDesign(root, compare, item.actual, (text) => text);
      } catch (error) {
        legacyError = error as Error;
      }
      const current = await currentCompare(item.reference, item.actual, item.masks);
      if (item.kind) {
        expect(legacyError, item.label).toBeDefined();
        expect(current, item.label).toMatchObject({ ok: false, kind: item.kind });
        if (!current.ok) expect(current.message, item.label).toBe(legacyError!.message);
        continue;
      }
      expect(current.ok, item.label).toBe(true);
      if (!current.ok || !legacyValue) continue;
      expect(current.ratio, item.label).toBe(legacyValue.ratio);
      expect(current.width, item.label).toBe(legacyValue.width);
      expect(current.height, item.label).toBe(legacyValue.height);
      expect(Buffer.from(current.diff, 'base64').equals(legacyValue.diff), item.label).toBe(true);
      expect(Buffer.from(current.reference, 'base64').equals(await readFile(path.join(root, item.reference))), item.label).toBe(true);
    }

  });

  it('서비스 출처: 순서·중복·기본 포트·실패·잘못된 URL이 옛 구현과 같다', async () => {
    const names = ['web', 'api', 'bad', 'edge', 'invalid', 'off'];
    const skipped = new Set(['off']);
    const endpoint = async (name: string): Promise<{ url: string }> => {
      if (name === 'bad') throw new Error('준비 안 됨');
      return {
        web: { url: 'http://127.0.0.1:8080/x' },
        api: { url: 'http://127.0.0.1:8080/y' },
        edge: { url: 'https://example.com:443/z' },
        invalid: { url: 'not a url' },
        off: { url: 'http://127.0.0.1:9999' },
      }[name]!;
    };
    const legacy = await legacyServiceOrigins(names, skipped, endpoint);
    const hook = async (text: string): Promise<string> => {
      const request = JSON.parse(text) as { op?: string; name?: string };
      if (request.op !== 'endpoint') return JSON.stringify({ ok: false });
      try {
        return JSON.stringify({ ok: true, url: (await endpoint(String(request.name))).url });
      } catch {
        return JSON.stringify({ ok: false });
      }
    };
    const current = decodeNative<string[]>(await native.gateServiceOrigins(names, [...skipped], hook));
    expect(current).toEqual(legacy);
    expect(current).toEqual(['http://127.0.0.1:8080', 'https://example.com']);
  });
});
