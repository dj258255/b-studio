/**
 * 아래 키 안내 한 줄(#935). 안내는 " · "로 이은 항목들이고, 중요한 것을 앞에 둔다.
 * 폭이 모자라면 뒤 항목부터 통째로 빼서 반쯤 잘린 글자("f AI 비교…")를 남기지 않는다.
 * 첫 항목(화면 이름이나 물음), 닫는 법(Esc), 모든 키를 보는 법(?), 묻는 줄의 답(y)은 끝까지 남긴다
 */
import { fit, stringWidth } from './screen';

const SEPARATOR = ' · ';

/** 끝까지 남기는 항목: 닫기·모든 키·묻는 줄의 답 */
function kept(item: string): boolean {
  const text = item.trim();
  return /^(Esc|\?|Ctrl-[a-z] \?)/.test(text) || /^y[ ·]/.test(text);
}

/** 안내를 width칸 한 줄로 맞춘다. 남길 항목만으로도 넘치면 그때만 끝을 줄인다 */
export function fitHint(text: string, width: number): string {
  if (stringWidth(text) <= width) return fit(text, width);
  const items = text.split(SEPARATOR);
  const keep = items.map((item, index) => index === 0 || kept(item));
  for (let index = items.length - 1; index > 0; index--) {
    if (keep[index]) continue;
    items[index] = '';
    const joined = items.filter(Boolean).join(SEPARATOR);
    if (stringWidth(joined) <= width) return fit(joined, width);
  }
  return fit(items.filter(Boolean).join(SEPARATOR), width);
}
