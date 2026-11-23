import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { checkDesignApproval, type DesignDocRecord } from './design-pipeline';
import * as current from './docs';
import { Gen } from './differential-kit';
import { judge, toPageCheckSteps, type QaActionRecord, type QaDiagnostics, type QaReview } from './explore-qa';
import { buildContractSystem } from './lane-contracts';
import { routeModel, type ModelProfile } from './model-router';
import { buildPlanBriefSystem } from './plan-brief';
import { servicesForFiles } from './services';

/**
 * Rust로 옮긴 순수 판정 여섯 개의 "옛 TS와 견주지 않는" 성질 시험. 옛 TS를 시험 안에 복사해 새 구현과 견주던 차등 시험
 * (`docs`·`budget-routing`·`design-pipeline`·`explore-qa`·`plan-brief`·`services`의 `*-differential.test.ts`)은 #1347에서 지웠고,
 * 그 안에서 옛 구현과 무관하게 새 구현만 확인하던 시험을 여기에 옮겼다. 옛 구현과 견주던 기대값은 각 `*-vectors.test.ts`가 맡는다.
 */

describe('docs: 경로 안전', () => {
const TITLE_ATOMS = [
  'a', 'B', 'z', '0', '9', '결제', '한글', 'x-y', ' ', ' ', ' ', '\t', '\n', '\r', ' ', ' ', ' ', '﻿', '　', '​', '\u0085', ' ', ' ',
  '/', '\\', ':', '*', '?', '"', '<', '>', '|', '-', '--', '---', '.', '..', '...', '../', '..\\', '/etc', 'C:', '\u0000', '∕', '／', '‮', '😀', 'é', 'é', 'ß', '#', '%2e', '~',
];

function genTitle(g: Gen): string {
  const roll = g.int(20);
  if (roll === 0) return '';
  if (roll === 1) return g.text(TITLE_ATOMS, 400 + g.int(400)); // 매우 긴 제목
  if (roll === 2) return g.pick(['..', '.', '...', '/', '\\', '../..', '-', '--', ' ', '  ', '\t', ' ', '﻿', ' - ', '- -', '/-/', '"-"']);
  return g.text(TITLE_ATOMS, 1 + g.int(12));
}

const NUMBERS = [0, 1, 2, 5, 9, 10, 11, 98, 99, 100, 101, 999, 1000, 12345, -1, -10, 1.5, 9.99, 99.5, 0.1, NaN, Infinity, -Infinity, -0, 2 ** 53, 1e21, 1e-7, 123456789012345680000];

function genNumber(g: Gen): number {
  return g.chance(0.7) ? g.pick(NUMBERS) : g.int(1500);
}

const SEEDS = [1, 7, 42, 2026];
const ITERATIONS = 3000;

  it('경로 안전: slug와 경로는 폴더 밖을 가리키는 꼴(구분자·상위 폴더)을 절대 내지 않는다', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const g = new Gen(seed + 77);
      for (let n = 0; n < ITERATIONS; n++) {
        const title = genTitle(g);
        const number = genNumber(g);
        const slug = current.slugifyTitle(title);
        const paths = [current.designDocFilePath(number, title), current.adrFilePath(number, title)];
        // slug에는 구분자(/ \)·공백 종류가 없고, 앞 글자가 `-`일 수 없다
        expect(slug).not.toMatch(/[\\/\s]/);
        expect(slug.startsWith('-')).toBe(false);
        expect(slug.length).toBeGreaterThan(0);
        for (const path of paths) {
          // 경로는 늘 정해진 폴더 아래의 `NN-`·`ADR-NNN-`으로 시작하는 한 파일 이름이다
          expect(path).toMatch(/^docs\/(?:adr\/ADR-)?[^/\\]+\.md$/);
          expect(path.split('/').includes('..')).toBe(false);
          expect(path.startsWith('/')).toBe(false);
          expect(path).not.toContain('\\');
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('model-router: 참조 동일성', () => {
  it('참조 동일성: 고른 모델과 후보의 model은 입력 배열의 같은 객체다', () => {
    const profiles: ModelProfile[] = [
      { id: 'a', provider: 'anthropic', model: 'a', label: 'A', capabilities: ['tools'], contextWindow: 100000, pricing: { inputPerMillion: 1, outputPerMillion: 2 }, baselineQuality: 0.5, baselineLatencyMs: 1000, extra: { keep: 'me' } } as ModelProfile,
      { id: 'b', provider: 'openai', model: 'b', label: 'B', capabilities: ['tools'], contextWindow: 100000, pricing: { inputPerMillion: 1, outputPerMillion: 2 }, baselineQuality: 0.4, baselineLatencyMs: 1000 },
    ];
    const decision = routeModel(profiles, { prompt: 'hello', intent: 'build' });
    expect(decision.selected).toBe(profiles[0]);
    expect(decision.candidates.map((candidate) => candidate.model)).toEqual(profiles);
    expect(decision.candidates[0]!.model).toBe(profiles[0]);
    expect((decision.selected as unknown as { extra: unknown }).extra).toEqual({ keep: 'me' });
  });
});

describe('design-pipeline: 입력을 바꾸지 않는다', () => {
  it('입력으로 쓴 설계 기록 객체는 껍데기가 바꾸지 않고, 막는 기록은 같은 객체로 돌려준다', () => {
    const doc = { path: 'docs/design/01-a.md', number: 1, title: 't', requirementIds: ['R-1'], bundles: [], status: 'draft', createdAt: 'x', createdBy: 'y' } as unknown as DesignDocRecord;
    const before = JSON.stringify(doc);
    const result = checkDesignApproval(['R-1'], [doc]);
    expect(result.blockingDocs[0]).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('explore-qa: 던지는 입력', () => {
  it('문자열로 바꿀 수 없는 text·key, 배열이 아닌 findings는 던진다(옛 구현도 던졌다)', () => {
    const bomb = { toString: () => { throw new Error('boom'); } };
    const fill = { index: 1, tool: 'qa_fill', ok: true, stableSelector: 'x', input: { text: bomb } } as unknown as QaActionRecord;
    const click = { index: 1, tool: 'qa_click', ok: true, stableSelector: 'x', input: { text: bomb } } as unknown as QaActionRecord;
    const failed = { index: 1, tool: 'qa_fill', ok: false, stableSelector: 'x', input: { text: bomb } } as unknown as QaActionRecord;
    expect(() => toPageCheckSteps([fill])).toThrow();
    // 쓰지 않는 자리의 값은 건드리지 않는다
    expect(() => toPageCheckSteps([click])).not.toThrow();
    expect(() => toPageCheckSteps([failed])).not.toThrow();
    const broken = { findings: undefined, stoppedBy: 'finish' } as unknown as QaReview;
    const clean = { consoleErrors: [], pageErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, accessibilityViolations: [] } as QaDiagnostics;
    expect(() => judge({}, clean, '', broken)).toThrow();
  });
});

describe('plan-brief·lane-contracts: 던지는 입력', () => {
  it('서비스 정의가 없는 프로젝트는 던진다(옛 구현도 던졌다)', () => {
    const broken = { spec: { name: 'x' }, managed: [['web', undefined]] } as unknown as LoadedProject;
    expect(() => buildPlanBriefSystem(broken, '요청')).toThrow();
    expect(() => buildContractSystem(broken)).toThrow();
  });
});

describe('services: 참조 동일성', () => {
  it('참조 동일성: unmatched는 입력 파일의 같은 문자열이다(짝 없는 서로게이트 이름도 그대로)', () => {
    const lone = 'zz/\ud800';
    const project = { managed: [['s', { path: 'a' }]], root: '/p', composePath: '/p/compose.yaml' } as unknown as LoadedProject;
    expect(servicesForFiles(project, [lone, 'a/x'])).toEqual({ services: ['s'], unmatched: [lone] });
  });
});
