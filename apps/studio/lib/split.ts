/** 한 화면에 나란히 볼 수 있는 세션 수 상한 */
export const MAX_SPLIT = 4;
/**
 * `/split?ids=a,b,c`의 ids를 정리한다. 빈 값과 중복을 빼고 상한까지만 쓴다(주소가 손으로 고쳐져도 서버가 지킨다)
 */
export function parseSplitIds(raw: string | string[] | undefined): string[] {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return [];
  const ids: string[] = [];
  for (const part of value.split(',')) {
    const id = part.trim();
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_SPLIT) break;
  }
  return ids;
}
