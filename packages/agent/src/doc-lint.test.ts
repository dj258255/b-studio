import { describe, expect, it } from 'vitest';
import { lintText } from './doc-lint';

describe('lintText', () => {
  it('한국어 약한 표현을 줄 번호와 함께 찾는다', () => {
    const findings = lintText('1번째 줄\n응답을 빠르게 처리합니다');
    expect(findings).toContainEqual({ line: 2, code: 'weak-word', message: expect.stringContaining('빠르게') });
  });

  it('영어 약한 표현도 찾는다', () => {
    const findings = lintText('Make it fast and user-friendly.');
    expect(findings.some((finding) => finding.code === 'weak-word' && finding.message.includes('fast'))).toBe(true);
    expect(findings.some((finding) => finding.code === 'weak-word' && finding.message.includes('user-friendly'))).toBe(true);
  });

  it('수치 없는 성능 주장을 잡는다', () => {
    const findings = lintText('이번 배포로 성능이 개선되었습니다.');
    expect(findings).toContainEqual(expect.objectContaining({ line: 1, code: 'vague-performance' }));
  });

  it('같은 줄에 숫자+단위가 있으면 성능 주장을 걸지 않는다', () => {
    const findings = lintText('p95 응답 시간이 850ms에서 320ms로 개선되었습니다.');
    expect(findings.some((finding) => finding.code === 'vague-performance')).toBe(false);
  });

  it('안정적이다·부하가 크다 같은 수치 없는 안정성·부하 주장도 잡는다', () => {
    expect(lintText('이 설정이 더 안정적입니다.').some((finding) => finding.code === 'vague-performance')).toBe(true);
    expect(lintText('동시 요청이 늘면 부하가 크다.').some((finding) => finding.code === 'vague-performance')).toBe(true);
  });

  it('헷갈리는 용어 쌍을 쓰면 정확한 용어를 요구하는 힌트를 보여준다', () => {
    const findings = lintText('속도가 중요합니다.');
    expect(findings).toContainEqual(expect.objectContaining({ code: 'confusable-term', message: expect.stringContaining('latency(지연)와 throughput(처리량)') }));
  });

  it('이미 정확한 용어(latency/throughput 등)를 쓰면 다시 지적하지 않는다', () => {
    const findings = lintText('latency(지연)를 줄이는 것이 목표입니다.');
    expect(findings.some((finding) => finding.code === 'confusable-term')).toBe(false);
  });

  it('문제 없는 줄은 아무 것도 찾지 않는다', () => {
    expect(lintText('p95 지연(latency)이 320ms입니다.')).toEqual([]);
  });

  it('여러 줄에 걸친 문제를 줄 번호대로 모두 돌려준다', () => {
    const findings = lintText('적절히 처리합니다\n다음 줄은 괜찮습니다\n응답이 빠르게 왔습니다');
    const lines = findings.map((finding) => finding.line);
    expect(lines).toContain(1);
    expect(lines).toContain(3);
    expect(lines).not.toContain(2);
  });
});
