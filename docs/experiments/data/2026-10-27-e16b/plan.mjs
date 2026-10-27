// 시작 대화를 만드는 요청(읽기만)과 이어서 보낼 요청 10개(#659 사전 등록)
const DONE = " 다른 것은 건드리지 마세요. 끝나면 '완료' 한 마디로만 답해 주세요.";
const ASK = ' 파일은 건드리지 마세요. 기억나지 않으면 추측하지 말고 모른다고 답해 주세요.';
export const SETUP = [
  'desk/ 폴더의 파일 목록을 훑고, 각 파일이 하는 일을 한 줄씩 정리해 주세요. 파일 머리 주석 정도만 읽어도 됩니다.',
  'desk/cards.ts를 처음부터 끝까지 읽고 카드 한 장이 어떤 줄들로 이루어지는지 설명해 주세요.',
  'desk/keys.ts를 처음부터 끝까지 읽고 Ctrl-b 다음에 오는 키마다 하는 일을 표로 정리해 주세요.',
  'desk/sidebar.ts를 처음부터 끝까지 읽고 headStatus와 agentStatus가 상태를 정하는 순서를 설명해 주세요.',
  'desk/render.ts와 desk/hints.ts를 읽고 화면마다 키 안내가 어떻게 그려지는지 설명해 주세요.',
];
export const REQUESTS = [
  { id: 'r1', kind: 'edit', text: 'config/owners.ts에서 TODO 주석 줄을 지워 주세요.' + DONE, check: { file: 'config/owners.ts', excludes: 'TODO(', includes: 'NOTIFY_GROUP_MS' } },
  { id: 'r2', kind: 'edit', text: 'config/retry.ts에서 RETRY_LIMIT 값을 3으로 바꾸고, 그 바로 아래 티켓 주석 줄을 지워 주세요.' + DONE, check: { file: 'config/retry.ts', excludes: 'ORD-', includes: 'RETRY_LIMIT = 3' } },
  { id: 'r3', kind: 'recall', distance: 1, text: '방금 config/retry.ts에서 RETRY_LIMIT을 바꾸기 전의 값은 얼마였나요? 숫자만 답해 주세요.' + ASK, expect: '7' },
  { id: 'r4', kind: 'edit', text: "notes/release.md 맨 아래에 '- 확인: 2026-10-27' 한 줄을 더해 주세요." + DONE, check: { file: 'notes/release.md', includes: '- 확인: 2026-10-27' } },
  { id: 'r5', kind: 'edit', text: 'config/flags.ts에서 ENABLE_BETA를 false로 바꿔 주세요.' + DONE, check: { file: 'config/flags.ts', includes: 'ENABLE_BETA = false' } },
  { id: 'r6', kind: 'recall', distance: 4, text: '아까 config/retry.ts에서 지운 티켓 주석에 적혀 있던 티켓 번호는 무엇이었나요? 번호만 답해 주세요.' + ASK, expect: '4821' },
  { id: 'r7', kind: 'edit', text: "notes/release.md 첫 줄의 제목 '# 릴리스 메모'를 '# 릴리스 노트'로 바꿔 주세요." + DONE, check: { file: 'notes/release.md', includes: '# 릴리스 노트' } },
  { id: 'r8', kind: 'edit', text: "config/flags.ts 맨 아래에 'export const MAX_ITEMS = 50;' 한 줄을 더해 주세요." + DONE, check: { file: 'config/flags.ts', includes: 'export const MAX_ITEMS = 50;' } },
  { id: 'r9', kind: 'edit', text: "notes/todo.md에서 '- 정렬 버그' 줄을 지워 주세요." + DONE, check: { file: 'notes/todo.md', excludes: '정렬 버그' } },
  { id: 'r10', kind: 'recall', distance: 9, text: '맨 처음에 config/owners.ts에서 지운 TODO 주석에 적혀 있던 담당자 이름은 무엇이었나요? 이름만 답해 주세요.' + ASK, expect: '김하늘' },
];
