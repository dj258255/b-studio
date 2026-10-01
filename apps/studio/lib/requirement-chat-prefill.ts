/**
 * 요구사항 카드 → 대화 프리필(ADR-094). "대화에서 묻기"는 요구사항 id·제목·인수 조건(+시나리오가 있으면 그것도)을
 * 맥락으로 채우고 끝에 질문을 쓸 자리를 남긴다(읽기만·조사 모드와 함께 쓴다 — 화면이 chat-draft-context의
 * ChatDraftMode로 그 두 스위치를 켠다). "복사"는 같은 내용을 마크다운으로 그대로 돌려준다(클립보드에 복사할 글).
 *
 * 순수 함수만 둔다(테스트하기 쉽게) — 렌더링·클립보드 접근은 호출하는 쪽(requirements-panel.tsx)이 한다.
 */

export interface RequirementForPrefill {
  id: string;
  title: string;
  acceptance: readonly string[];
  ears?: { statement: string };
  scenarios?: ReadonlyArray<{ id: string; given: string; when: string; then: string }>;
}

function requirementBodyLines(requirement: RequirementForPrefill): string[] {
  const lines: string[] = [];
  if (requirement.ears) lines.push(`EARS: ${requirement.ears.statement}`, '');
  lines.push('인수 조건:', ...requirement.acceptance.map((item) => `- ${item}`));
  if (requirement.scenarios && requirement.scenarios.length > 0) {
    lines.push('', '시나리오:');
    for (const scenario of requirement.scenarios) {
      lines.push(`- ${scenario.id}: (Given) ${scenario.given} (When) ${scenario.when} (Then) ${scenario.then}`);
    }
  }
  return lines;
}

/** "대화에서 묻기"가 채우는 글. 맥락 뒤에 빈 줄과 안내만 남기고, 실제 질문은 사람이 이어서 쓴다(커서 자리) */
export function buildRequirementAskPrefill(requirement: RequirementForPrefill): string {
  const header = `[${requirement.id}] ${requirement.title}`;
  const body = requirementBodyLines(requirement).join('\n');
  return `${header}\n\n${body}\n\n질문: `;
}

/** "복사"가 클립보드에 담는 마크다운. 대화에 붙여넣거나 문서에 인용하기 좋은 모양이다 */
export function requirementToMarkdown(requirement: RequirementForPrefill): string {
  const header = `## [${requirement.id}] ${requirement.title}`;
  const body = requirementBodyLines(requirement).join('\n');
  return `${header}\n\n${body}\n`;
}
