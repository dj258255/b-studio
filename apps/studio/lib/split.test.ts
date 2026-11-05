import { describe, expect, it } from 'vitest';
import {
  parseSplitIds,
} from './split';

describe('parseSplitIds', () => {
  it('쉼표로 나누고 빈 값·중복을 빼고 상한까지만 쓴다', () => {
    expect(parseSplitIds('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseSplitIds(' a , b ,, a ')).toEqual(['a', 'b']);
    expect(parseSplitIds('a,b,c,d,e,f')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseSplitIds(undefined)).toEqual([]);
    expect(parseSplitIds('')).toEqual([]);
    expect(parseSplitIds(['a,b', 'c'])).toEqual(['a', 'b']);
  });
});
