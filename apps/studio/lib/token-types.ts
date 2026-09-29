import type { AgentUsage } from '@b-studio/agent';

/** 토큰 탭이 주고받는 형태. 서버(token-report)와 화면(token-view)이 함께 쓴다(서버 전용 코드는 담지 않는다) */

/** 100만 토큰당 단가(달러). 네 값이 모두 있어야 비용을 계산한다 */
export interface TokenPrices {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

export interface TokenTurn {
  turn: number;
  contextTokens: number;
  /** 직전 턴 대비 컨텍스트 증가량. 첫 턴은 contextTokens와 같다(줄어들면 음수일 수 있다) */
  delta: number;
  output: number;
  cacheRead: number;
  /** 그 턴에서 모델에 간 결과가 가장 큰 도구 */
  biggestTool?: { name: string; input: string; chars: number };
  /** 그 턴 직전에 오래된 도구 결과를 묶어서 비운 기록. 비우지 않았으면 없다 */
  cleared?: { count: number; chars: number };
}

export interface TokenToolTotal {
  name: string;
  calls: number;
  /** 모델에 간 결과 글자 합 */
  chars: number;
  /** 전체 결과 글자에서 이 도구가 차지하는 비중(0-1) */
  share: number;
}

export interface TokenBigResult {
  name: string;
  input: string;
  chars: number;
  rawChars: number;
  turn?: number;
}

export type TokenWarningKind = 'big_result' | 'repeated_result' | 'node_modules' | 'context_jump';

export interface TokenWarning {
  kind: TokenWarningKind;
  message: string;
  turn?: number;
  tool?: string;
}

export interface TokenReport {
  runId: string;
  request: string;
  turns: TokenTurn[];
  toolTotals: TokenToolTotal[];
  biggest: TokenBigResult[];
  warnings: TokenWarning[];
  totals: AgentUsage;
  /** 캐시 읽기 / (입력 + 캐시 읽기 + 캐시 쓰기). 분모가 0이면 0 */
  cacheHitRatio: number;
  /** 실행 중 오래된 도구 결과를 비운 합계(횟수·글자). 비운 적이 없으면 0 */
  cleared: { count: number; chars: number };
  estimatedCostUsd?: number;
  /** 단가가 없을 때 화면이 보여줄 문구 */
  priceNote?: string;
}
