import path from 'node:path';

/**
 * 경로 이름을 비교할 때 쓰는 꼴(트러블슈팅 124·125·126). 검사하는 쪽(문자열 비교)과 쓰는 쪽(파일 시스템)이 이름을 다르게 읽으면
 * 같은 파일을 가리키는 다른 표기가 검사를 지나간다.
 *
 * **거부 목록과 허용 목록은 맞추는 정도가 반대다.**
 *  - 거부 목록(숨긴 이름, 보호 경로): 넓게 맞춘다. 다른 이름을 같은 것으로 잘못 봐도 더 막을 뿐이다 → `foldName`, `canonicalProjectPath`
 *  - 허용 목록(쓰기 범위): 좁게 맞춘다. 다른 이름을 같은 것으로 보면 범위 밖이 범위 안이 된다 → `normalizeProjectPath`만 쓰고 이름은 접지 않는다
 * 처음에 둘에 같은 함수를 썼다가, 대소문자를 구분하는 볼륨에서 범위 밖 폴더(`WEB/…`)가 쓰기 범위 안으로 판정됐다.
 */

/**
 * 표기만 정리한다: 구분자, `.`·`..`·겹친 `/`. 이름은 건드리지 않는다. 루트 자체는 빈 문자열이다.
 * 프로젝트 밖으로 나가거나, 절대 경로거나, 이름으로 쓸 수 없는 글자가 들었으면 undefined — 부르는 쪽이 정한 대로 막는다.
 *
 * 역슬래시: POSIX에서는 구분자가 아니라 이름의 한 글자다. 검사하는 쪽이 구분자로 바꿔 읽으면 실제로 쓰는 쪽과 어긋난다
 * (`infra/a\..\..\x`를 검사는 `x`로, 파일 시스템은 `infra` 안의 파일로 읽는다). 그래서 POSIX에서 역슬래시가 든 경로는 받지 않는다.
 * `lenientSeparators`는 설정 파일에 적은 규칙처럼 사람이 쓴 값에만 쓴다(Windows 표기로 적은 규칙을 같은 뜻으로 읽는다)
 */
export function normalizeProjectPath(file: string, { lenientSeparators = false }: { lenientSeparators?: boolean } = {}): string | undefined {
  if (file.includes('\0')) return undefined;
  let slashed = file;
  if (file.includes('\\')) {
    if (path.sep !== '\\' && !lenientSeparators) return undefined;
    slashed = file.replaceAll('\\', '/');
  }
  // 절대 경로(`/x`, Windows의 `C:/x`). `a:b.txt`처럼 콜론이 든 평범한 이름은 상대 경로다
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) return undefined;
  const normalized = path.posix.normalize(slashed).replace(/\/$/, '');
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

/**
 * 이름 한 조각을 거부 목록과 견줄 꼴로 **넓게** 접는다. 파일 시스템이 같은 항목으로 볼 수 있는 변형을 모두 한 꼴로 모으는 것이 목표라,
 * 서로 다른 이름이 같은 꼴이 되는 것은 감수한다(그만큼 더 막는다).
 *  - 호환 분해(NFKD)와 결합 문자 제거: 전각 글자, `ſ`(긴 s), 켈빈 기호 같은 닮은 글자와 악센트를 기본 글자로
 *  - 보이지 않는 문자 제거(서식 문자 전체): HFS+가 이름을 비교할 때 무시하는 것들을 포함한다(git이 `.git`을 지킬 때 거르는 범위)
 *  - 대문자로 바꿨다가 소문자로: 소문자로만 바꾸면 `ſ`처럼 이미 소문자인 변형이 남는다
 *  - 끝의 점과 공백 제거: Windows와 SMB는 이름 끝의 점·공백을 무시한다
 * macOS와 Windows의 기본 볼륨은 대소문자를 구분하지 않아 `.GIT`·`.Env`가 `.git`·`.env`와 같은 항목이다
 */
export function foldName(segment: string): string {
  const folded = segment
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC');
  // 점과 공백뿐인 이름은 그대로 둔다(빈 이름으로 만들지 않는다)
  const trimmed = folded.replace(/[. ]+$/, '');
  return trimmed === '' ? folded : trimmed;
}

/**
 * 거부 목록과 견줄 경로: 표기를 정리하고(normalizeProjectPath) 조각마다 넓게 접는다(foldName).
 * 허용 목록에는 쓰지 않는다
 */
export function canonicalProjectPath(file: string, options: { lenientSeparators?: boolean } = {}): string | undefined {
  const normalized = normalizeProjectPath(file, options);
  if (normalized === undefined || normalized === '') return normalized;
  return normalized.split('/').map(foldName).join('/');
}
