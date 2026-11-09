/**
 * 문서·PR 본문의 "모호한 표현" 린트(ADR-098). 범수 님이 쓴 평가 기준(측정 가능한 말을 쓴다 — "성능이
 * 좋아졌다/빨라졌다/안정적이다" 대신 수치·단위를, "latency"·"throughput"처럼 헷갈리는 말은 정확한 용어로)을
 * 문서 탭·PR 올리기 미리보기에서 결정론적으로(모델 호출 없이) 잡아내는 안전망이다.
 *
 * requirements.ts의 lintRequirement가 쓰는 약한 표현 목록(한국어·영어·"등")과 단어 경계 규칙을 그대로 쓴다 —
 * 요구사항 문장만이 아니라 문서·PR 본문 같은 자유 텍스트에도 같은 "약한 표현" 기준을 적용해야 두 린트가
 * 서로 다른 말을 다른 기준으로 잡는 혼란이 없다.
 *
 * 이 파일은 줄 번호가 있는 자유 텍스트(마크다운 문서, PR 본문)를 대상으로 한다 — requirements.ts의
 * lintRequirement는 구조화된 Requirement 한 건을 대상으로 한다는 점이 다르다(그래서 따로 둔다).
 *
 * 판정은 Rust(`crates/bstudio-guard/src/doc_lint.rs`, ADR-191 3단계 3j)가 한다. 여기에는 타입과, 같은 이름·시그니처로 네이티브 모듈을 부르는 얇은 껍데기만 남았다.
 */
import { decodeNative, native } from '@b-studio/sandbox';

export interface DocLintFinding {
  /** 1부터 시작하는 줄 번호 */
  line: number;
  code: 'weak-word' | 'vague-performance' | 'confusable-term';
  message: string;
}

/**
 * 자유 텍스트(문서·PR 본문)를 줄 단위로 린트한다: 약한 표현, 수치 없는 성능·안정성 주장, 헷갈리는 용어 쌍.
 * 모두 결정론적 문자열 검사라 모델을 부르지 않는다. 화면은 이 결과를 막지 않고(non-blocking) 보여 주기만 한다.
 */
export function lintText(text: string): DocLintFinding[] {
  return decodeNative<DocLintFinding[]>(native.docLintText(text));
}
