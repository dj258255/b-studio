import { describe, expect, it } from 'vitest';
import { InputParser } from './input';

describe('InputParser', () => {
  it('붙여 넣은 글(여러 줄)은 Enter가 오면 한 요청이 된다', () => {
    const parser = new InputParser();
    expect(parser.feed('\x1b[200~첫 줄\n둘째 줄\x1b[201~')).toEqual([]);
    expect(parser.feed('\r')).toEqual(['첫 줄\n둘째 줄']);
  });

  it('표식이 여러 조각에 나뉘어 와도 맞추고, 빈 입력 줄의 Enter는 무시한다', () => {
    const parser = new InputParser();
    const out = ['\r', '\x1b[20', '0~첫 줄\n둘째 줄\x1b[201', '~', '\r'].flatMap((piece) => parser.feed(piece));
    expect(out).toEqual(['첫 줄\n둘째 줄']);
  });

  it('붙여 넣기 안의 Enter(\\r)는 요청을 보내지 않는다', () => {
    const parser = new InputParser();
    expect(parser.feed('\x1b[200~가\r나\x1b[201~\r')).toEqual(['가\r나']);
  });

  it('요청 둘이 한 조각에 이어 와도 차례로 낸다. 쳐 넣은 글자와 붙여 넣은 글이 한 줄로 이어진다', () => {
    const parser = new InputParser();
    expect(parser.feed('\x1b[200~하나\x1b[201~\r\x1b[200~둘\x1b[201~\r')).toEqual(['하나', '둘']);
    expect(parser.feed('abc\x1b[200~def\x1b[201~g\r')).toEqual(['abcdefg']);
  });

  it('Enter 없이 붙여 넣기만 하면 요청하지 않는다. 공백뿐인 줄도 무시한다', () => {
    const parser = new InputParser();
    expect(parser.feed('\x1b[200~보내지 않음\x1b[201~')).toEqual([]);
    expect(new InputParser().feed('  \r')).toEqual([]);
  });
});
