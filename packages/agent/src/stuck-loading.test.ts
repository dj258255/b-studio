import { describe, expect, it } from 'vitest';
import { detectStuckLoading } from './stuck-loading';

const noEvidence = { failedRequests: 0, consoleErrors: 0, pageErrors: 0 };

describe('detectStuckLoading', () => {
  it('로딩 문구만 남은 화면은 멈춘 것으로 본다(영어·한국어)', () => {
    expect(detectStuckLoading('Loading...')).toContain('화면이 로딩 문구만 보여 준 채 멈췄습니다');
    expect(detectStuckLoading('Loading')).toContain('멈췄습니다');
    expect(detectStuckLoading('로딩 중입니다...')).toContain('멈췄습니다');
    expect(detectStuckLoading('불러오는 중')).toContain('멈췄습니다');
    expect(detectStuckLoading('please wait...')).toContain('멈췄습니다');
    expect(detectStuckLoading('잠시만 기다려 주세요')).toContain('멈췄습니다');
  });

  it('여러 줄이어도 모든 줄이 로딩 문구뿐이면 멈춘 것으로 본다(반복된 스켈레톤 문구)', () => {
    expect(detectStuckLoading('Loading...\nLoading...\nLoading...')).toContain('멈췄습니다');
  });

  it('E8에서 실제로 관측된 "Loading..." 단독 화면과 같은 사례를 잡는다', () => {
    // haiku r1/r2: /dashboard가 합계를 못 받고 "Loading..."으로만 끝났다
    expect(detectStuckLoading('Loading...')).toBeDefined();
  });

  it('본문에 실제 내용이 있으면 "로딩"이라는 낱말이 섞여 있어도 통과시킨다(오탐 방지)', () => {
    // 로딩이라는 낱말이 문장 일부일 뿐, 줄 전체가 로딩 문구가 아니다
    expect(detectStuckLoading('Loading Dock 안내: 5번 게이트에서 오후 3시까지 접수합니다')).toBeUndefined();
    expect(detectStuckLoading('주문 목록\n합계 45,000\n페이지를 불러오는 중에도 이전 목록을 볼 수 있습니다')).toBeUndefined();
    // 여러 줄 중 한 줄만 로딩이고 나머지는 실제 콘텐츠면 "모든 줄"이 아니므로 통과시킨다(보수적 판정)
    expect(detectStuckLoading('주문 목록\n합계 45,000\nLoading...')).toBeUndefined();
  });

  it('빈 화면은 실패한 요청·콘솔 오류·스크립트 예외 같은 증거가 있을 때만 실패로 본다', () => {
    expect(detectStuckLoading('', noEvidence)).toBeUndefined();
    expect(detectStuckLoading('   \n  \n', noEvidence)).toBeUndefined();
    expect(detectStuckLoading('', { failedRequests: 1, consoleErrors: 0, pageErrors: 0 })).toContain('화면에 표시된 내용이 없습니다');
    expect(detectStuckLoading('', { failedRequests: 0, consoleErrors: 1, pageErrors: 0 })).toBeDefined();
    expect(detectStuckLoading('', { failedRequests: 0, consoleErrors: 0, pageErrors: 1 })).toBeDefined();
  });

  it('evidence를 생략하면(HTTP 모드) 빈 화면만으로는 판정하지 않는다 — 보수적으로 본다', () => {
    expect(detectStuckLoading('')).toBeUndefined();
  });

  it('일반적인 짧은 화면(의도된 빈·안내 화면)은 실패로 보지 않는다', () => {
    expect(detectStuckLoading('완료되었습니다', noEvidence)).toBeUndefined();
    expect(detectStuckLoading('접근 권한이 없습니다', noEvidence)).toBeUndefined();
  });
});
