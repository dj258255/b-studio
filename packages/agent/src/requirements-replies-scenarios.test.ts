/**
 * 인용 확인(`verifySpecQuote`)이 JS로 따로 쓴 같은 규칙(`oracle`)과 글자까지 같은지 새 구현만으로 확인한다.
 * 옛 TS 사본과 무작위로 견주던 시험(`requirements-replies-differential.test.ts`)에서 사본과 무관한 확인만 남겼다(#1347).
 */
import { encodeLoneSurrogates } from '@b-studio/sandbox';
import { describe, expect, it, vi } from 'vitest';
import { Gen, readEnvList, readEnvNumber } from './differential-kit';
import * as cur from './requirements';

const SEEDS = readEnvList('REQ_REPLIES_DIFF_SEEDS', [1, 7, 42, 2026]);
const N = readEnvNumber('REQ_REPLIES_DIFF_N', 1500);
vi.setConfig({ testTimeout: 3_600_000 });

const SPEC_WORDS = ['사용자는', '로그인한다', 'the', 'user', 'API', 'v2', 'id', 'id_1', '10', '1', '연', '10회', '연 10회', 'JWT를', '비밀번호', 'a', 'e', 'x', '·', '-', '_', '\ud800', '\udc00', '😀', '', '', 'ſ', 'K', '결제'];
const SPACES = [' ', ' ', ' ', '  ', '\n', '\t', ' ', '﻿', ' ', '　', '\r\n', '​'];

function genSpec(g: Gen): string {
  const count = 1 + g.int(10);
  let out = '';
  for (let i = 0; i < count; i++) out += (i === 0 && g.chance(0.5) ? '' : g.pick(SPACES)) + g.pick(SPEC_WORDS);
  return out;
}

function genQuote(g: Gen, spec: string): string {
  const roll = g.int(10);
  const chars = [...spec];
  if (roll === 0) return '';
  if (roll === 1) return g.pick(SPACES);
  if (roll === 2) return genSpec(g);
  if (chars.length === 0) return 'x';
  const from = g.int(chars.length);
  const to = from + 1 + g.int(Math.min(chars.length - from, 12));
  let quote = chars.slice(from, to).join('');
  if (roll === 3) quote = quote.toUpperCase();
  if (roll === 4) quote = quote.replace(/\s+/g, g.pick(SPACES));
  if (roll === 5) quote = g.pick(SPACES) + quote + g.pick(SPACES);
  if (roll === 6) quote = quote.replace(/ /g, '');
  return quote;
}

/** 새 규칙을 JS로 따로 쓴 것: 공백을 접은 부분 문자열이면서, 인용의 앞·끝이 ASCII 낱말 글자일 때 그 옆도 낱말 글자인 자리는 세지 않는다. 짝 없는 서로게이트는 단사 인코딩으로 견준다 */
function oracle(quote: string, spec: string): boolean {
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
  const q = collapse(encodeLoneSurrogates(quote));
  if (!q) return false;
  const t = collapse(encodeLoneSurrogates(spec));
  const word = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
  for (let at = t.indexOf(q); at !== -1; at = t.indexOf(q, at + 1)) {
    const cutBefore = word(q[0]) && word(t[at - 1]);
    const cutAfter = word(q[q.length - 1]) && word(t[at + q.length]);
    if (!cutBefore && !cutAfter) return true;
  }
  return false;
}

interface Rec { question: string; answer: string; rationale: string; basis: unknown; specQuote?: string; sources?: unknown }

describe('모델 답 읽기: 인용 확인', () => {
  it('새 구현은 JS로 따로 쓴 같은 규칙과 같고, 낱말 중간을 자른 인용은 받지 않는다', () => {
    let accepted = 0;
    let rejected = 0;
    for (const seed of SEEDS) {
      const g = new Gen(seed * 17 + 3);
      for (let i = 0; i < N * 4; i++) {
        const spec = genSpec(g);
        const quote = genQuote(g, spec);
        const current = cur.verifySpecQuote(quote, spec);
        expect(current, JSON.stringify([quote, spec])).toBe(oracle(quote, spec));
        if (current) accepted += 1;
        else rejected += 1;
      }
    }
    expect(accepted).toBeGreaterThan(300);
    expect(rejected).toBeGreaterThan(300);
  });
});
