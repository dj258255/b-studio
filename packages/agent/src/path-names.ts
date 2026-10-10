import path from 'node:path';

/**
 * 경로 이름을 비교할 때 쓰는 꼴(트러블슈팅 124·125). 검사하는 쪽(문자열 비교)과 쓰는 쪽(파일 시스템)이 이름을 다르게 읽으면
 * 같은 파일을 가리키는 다른 표기가 검사를 지나간다. 숨김 검사(workspace.ts)와 실행 정책(policy.ts)이 같은 규칙을 쓰도록 한곳에 둔다.
 */

/**
 * 이름 한 조각을 파일 시스템이 같은 것으로 볼 수 있는 꼴로 맞춘다. macOS와 Windows의 기본 볼륨은 대소문자를 구분하지 않아
 * `.GIT`·`.Env`가 `.git`·`.env`와 같은 항목이다. 유니코드 정규화 꼴과, HFS+가 이름을 비교할 때 무시하는 보이지 않는 문자
 * (git이 `.git`을 지킬 때 거르는 것과 같은 범위)도 함께 맞춘다.
 * 대소문자를 구분하는 볼륨에서는 `.GIT`이 다른 폴더지만, 그런 이름까지 같은 것으로 보는 쪽이 지나치는 것보다 낫다
 */
export function canonicalName(segment: string): string {
  return segment
    .normalize('NFC')
    .replace(/[‌-‏‪-‮⁪-⁯﻿]/g, '')
    .toLowerCase();
}

/**
 * 프로젝트 루트 기준 상대 경로를 비교할 수 있는 꼴로 맞춘다: 구분자를 `/`로, `.`·`..`·겹친 `/`를 정리하고, 조각마다 canonicalName.
 * 루트 자체는 빈 문자열이다. 루트 밖으로 나가거나 절대 경로면 undefined — 부르는 쪽이 거절한다
 */
export function canonicalProjectPath(file: string): string | undefined {
  const slashed = file.replaceAll('\\', '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) return undefined;
  const normalized = path.posix.normalize(slashed).replace(/\/$/, '');
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized.split('/').map(canonicalName).join('/');
}
