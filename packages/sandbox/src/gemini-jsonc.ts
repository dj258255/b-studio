/** 파일에 쓰인 JSONC(주석·끝의 쉼표)를 JSON으로 읽는다. Gemini는 주석을 뗀 JSON으로 읽는다(strip-json-comments). 이쪽은 끝의 쉼표도 받는 더 넓은 읽기다 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new Error('닫히지 않은 주석');
      index = end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  // 끝의 쉼표(`,}`·`,]`). 글자열 밖에서만 센다
  let cleaned = '';
  let at = 0;
  while (at < out.length) {
    const char = out[at]!;
    if (char === '"') {
      let end = at + 1;
      while (end < out.length && out[end] !== '"') end += out[end] === '\\' ? 2 : 1;
      cleaned += out.slice(at, end + 1);
      at = end + 1;
    } else if (char === ',') {
      let next = at + 1;
      while (next < out.length && /\s/u.test(out[next]!)) next += 1;
      if (out[next] !== '}' && out[next] !== ']') cleaned += char;
      at += 1;
    } else {
      cleaned += char;
      at += 1;
    }
  }
  return JSON.parse(cleaned);
}

