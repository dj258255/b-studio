// Playwright 1.63.0의 coreBundle.js에서 이 크레이트가 쓰는 조각을 그대로 떼어 낸다(SOURCES 참고).
// 사용: node extract.mjs <playwright-core 폴더> <내보낼 폴더>
// 손으로 줄이거나 고치지 않는다. 버전을 올릴 때는 이 스크립트를 다시 돌려 차이를 본다.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const [pw, out] = process.argv.slice(2);
const bundlePath = path.join(pw, 'lib/coreBundle.js');
const text = fs.readFileSync(bundlePath, 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(pw, 'package.json'), 'utf8')).version;
const lines = text.split('\n');

/** 줄 번호(0부터)에서 시작해 `{`를 여는 객체 리터럴 하나를 짝 맞춰 잘라 낸다 */
function objectLiteralAfter(marker) {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`${marker}를 찾지 못했습니다`);
  const open = text.indexOf('{', start);
  let depth = 0;
  let inString = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inString = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`${marker}의 객체가 닫히지 않았습니다`);
}

// 1. 주입 스크립트(`source4`): 한 줄짜리 문자열 리터럴이다
const sourceLine = lines.findIndex((line, i) => /^\s*source\d+ = '/.test(line) && lines[i - 3]?.includes('generated/injectedScriptSource.ts') === false && /injectedScriptSource\.ts/.test(lines.slice(Math.max(0, i - 4), i).join('\n')));
if (sourceLine < 0) throw new Error('injectedScriptSource를 찾지 못했습니다');
const injected = vm.runInNewContext(lines[sourceLine].match(/^\s*source\d+ = (.*);$/)[1]);
fs.writeFileSync(path.join(out, 'injected_script_source.js'), `// Playwright ${version} packages/playwright-core/src/generated/injectedScriptSource.ts(coreBundle.js ${sourceLine + 1}행)에서 떼어 낸 그대로. Apache-2.0, 같은 폴더의 LICENSE·NOTICE·SOURCES 참고.\n${injected}`);

// 2. 키보드 표와 맥 편집 명령(JSON으로)
const layout = vm.runInNewContext(`(${objectLiteralAfter('USKeyboardLayout = {')})`);
fs.writeFileSync(path.join(out, 'us_keyboard_layout.json'), JSON.stringify(layout, null, 1) + '\n');
const mac = vm.runInNewContext(`(${objectLiteralAfter('macEditingCommands = {')})`);
fs.writeFileSync(path.join(out, 'mac_editing_commands.json'), JSON.stringify(mac, null, 1) + '\n');

// 3. 스크린샷 준비 함수(`inPagePrepareForScreenshots`)
const fnStart = text.indexOf('function inPagePrepareForScreenshots(');
const fnEnd = text.indexOf('\n}\n', fnStart) + 2;
fs.writeFileSync(path.join(out, 'prepare_for_screenshots.js'), `// Playwright ${version} coreBundle.js의 inPagePrepareForScreenshots를 그대로 떼어 낸 것. Apache-2.0.\n(${text.slice(fnStart, fnEnd)})`);
console.log('injected', injected.length, 'layout', Object.keys(layout).length, 'mac', Object.keys(mac).length, 'prepare', fnEnd - fnStart);
