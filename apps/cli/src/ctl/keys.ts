/** `studio keys`가 보내는 키 이름 → 터미널에 넣는 바이트. 모르는 이름은 글자 그대로 보내지 않고 거절한다(오타가 CLI에 글로 들어가지 않게) */

const NAMED: Readonly<Record<string, string>> = {
  enter: '\r',
  return: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  btab: '\x1b[Z',
  's-tab': '\x1b[Z',
  space: ' ',
  backspace: '\x7f',
  bspace: '\x7f',
  delete: '\x1b[3~',
  del: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pgup: '\x1b[5~',
  pagedown: '\x1b[6~',
  pgdn: '\x1b[6~',
};

export function keyBytes(name: string): string | undefined {
  const lower = name.toLowerCase();
  const named = NAMED[lower];
  if (named !== undefined) return named;
  // C-c, Ctrl-c, ctrl+c
  const ctrl = /^(?:c|ctrl)[-+]([a-z\[\\\]^_@])$/.exec(lower);
  if (ctrl) return String.fromCharCode(ctrl[1]!.toUpperCase().charCodeAt(0) & 0x1f);
  // M-x, Alt-x
  const alt = /^(?:m|alt)[-+](.)$/iu.exec(name);
  if (alt) return `\x1b${alt[1]}`;
  // 한 글자(숫자·글자·기호)는 그대로. 권한 창의 1·2·3, y·n
  if ([...name].length === 1 && !/[\x00-\x1f\x7f]/.test(name)) return name;
  return undefined;
}

export const KEY_HELP = 'Enter Esc Tab S-Tab Space BSpace Delete Up Down Left Right Home End PgUp PgDn C-<글자> M-<글자> 또는 글자 하나(1 y n …)';
