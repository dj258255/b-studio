import { describe, expect, it } from 'vitest';
import * as legacy from './compose-provider-legacy';
import * as now from './compose-provider';

/**
 * compose-provider의 인자 조립과 오류 글(ADR-195 4f A4c-4) 차등 시험. 같은 입력을 옛 TS(`compose-provider-legacy.ts`)와
 * 새 껍데기(Rust, crates/bstudio-guard/src/compose_args.rs)에 넣어 만든 docker 인자 배열과 오류 글을 견준다.
 * 경계값(빈 값, 따옴표·개행·NUL, 유니코드, 플래그처럼 보이는 이름, 아주 긴 값, JS 수 표기)을 넣는다.
 */

const NAMES = [
  '',
  ' ',
  'web',
  'api-1',
  "'",
  '"',
  'a b',
  '한글',
  '😀',
  '\n',
  '\t',
  '\0',
  '--detach',
  '-',
  'up',
  'compose',
  '${x}',
  '`x`',
  '$(x)',
  'a/b',
  '\u2028',
  '\ufeff',
  'ＡＰＩ',
  'x'.repeat(4096),
];

const PATHS = [
  '',
  '/',
  '/proj',
  '/proj/compose.yaml',
  'C:\\proj\\compose.yaml',
  'a b/c d/compose.yaml',
  '/p/\n/x',
  '한글/😀/x',
  '..',
  './x',
  '\0path',
  'x'.repeat(2048),
];

const ARG_LISTS: string[][] = [
  [],
  ['up'],
  ['up', '--detach'],
  ['up', '--detach', '--remove-orphans', '--no-deps', 'web'],
  ['logs', '--follow', '--no-color', '--timestamps', '--tail', '200'],
  ['exec', '-T', 'web', 'sh', '-c', 'echo hi'],
  ['--file', 'x'],
  ['', '--', '-', ' '],
  ['한글', '😀'],
];

const NUMBERS = [0, 1, 80, 3000, 65535, -1, 1.5, -0, NaN, Infinity, -Infinity, 1e21, 1e-7, 2 ** 53];

describe('composeCommandArgs: 하위 명령 앞에 붙는 compose 인자', () => {
  it('이름·경로·하위 인자의 경계값에서 같다', () => {
    for (const project of NAMES) {
      for (const root of PATHS) {
        for (const compose of PATHS) {
          for (const override of PATHS) {
            for (const args of ARG_LISTS) {
              expect(now.composeCommandArgs(project, root, compose, override, args), JSON.stringify({ project, root, compose, override, args })).toEqual(
                legacy.composeCommandArgs(project, root, compose, override, args),
              );
            }
          }
        }
      }
    }
  });
});

describe('지우기·서비스·조회 인자', () => {
  it('sandboxCleanupArgs', () => {
    for (const name of NAMES) expect(now.sandboxCleanupArgs(name), JSON.stringify(name)).toEqual(legacy.sandboxCleanupArgs(name));
  });

  it('serviceRunningArgs: 켜기·끄기', () => {
    for (const name of NAMES) {
      for (const running of [true, false]) {
        expect(now.serviceRunningArgs(name, running), JSON.stringify({ name, running })).toEqual(legacy.serviceRunningArgs(name, running));
      }
    }
  });

  it('serviceRecreateArgs', () => {
    for (const name of NAMES) expect(now.serviceRecreateArgs(name), JSON.stringify(name)).toEqual(legacy.serviceRecreateArgs(name));
  });

  it('edgePortArgs: JS 수 표기(String)를 그대로 옮긴다', () => {
    for (const edge of NAMES) {
      for (const port of NUMBERS) {
        expect(now.edgePortArgs(edge, String(port)), JSON.stringify({ edge, port })).toEqual(legacy.edgePortArgs(edge, port));
      }
    }
  });

  it('composePsArgs', () => {
    for (const name of NAMES) expect(now.composePsArgs(name), JSON.stringify(name)).toEqual(legacy.composePsArgs(name));
  });

  it('composeLogsArgs: 따라가기·tail 표기·서비스 순서', () => {
    const serviceLists: string[][] = [[], [''], ['web'], ['web', 'api'], ['--follow'], ['한글', '😀'], ['', '--', '-']];
    for (const services of serviceLists) {
      for (const follow of [true, false]) {
        for (const tail of NUMBERS) {
          expect(now.composeLogsArgs(services, follow, String(tail)), JSON.stringify({ services, follow, tail })).toEqual(legacy.composeLogsArgs(services, follow, tail));
        }
      }
    }
  });
});

describe('exec·build·전체 up 인자', () => {
  const COMMANDS: string[][] = [
    [],
    [''],
    ['sh', '-c', 'echo hi'],
    ['--help'],
    ['a b'],
    ['\0'],
    ['한글', '😀'],
    ['x'.repeat(4096)],
  ];

  it('composeExecArgs: 명령을 문자열로 잇지 않고 인자로 넘긴다', () => {
    for (const name of NAMES) {
      for (const command of COMMANDS) {
        expect(now.composeExecArgs(name, command), JSON.stringify({ name, command })).toEqual(legacy.composeExecArgs(name, command));
      }
    }
  });

  it('sandboxBuildArgs: 선택 없음·빈 목록·서비스 목록', () => {
    const selections: Array<string[] | undefined> = [undefined, [], [''], ['web'], ['web', 'api'], ['--no-cache'], ['한글', '😀']];
    for (const noCache of [true, false]) {
      for (const selected of selections) {
        expect(now.sandboxBuildArgs(noCache, selected), JSON.stringify({ noCache, selected })).toEqual(legacy.sandboxBuildArgs(noCache, selected));
      }
    }
  });

  it('composeUpRemoveOrphansArgs', () => {
    for (const args of ARG_LISTS) expect(now.composeUpRemoveOrphansArgs(args), JSON.stringify(args)).toEqual(legacy.composeUpRemoveOrphansArgs(args));
  });
});

describe('오류 글은 바이트까지 같다', () => {
  const IDS = ['', 'studio-p', 'studio-한글-😀', "a'b", 'a\nb', '--x', 'x'.repeat(4096)];

  it('composeFailureMessage', () => {
    const commands = ['', 'up', 'config', 'ps', 'exec', '실패', 'a b', 'x'.repeat(2048)];
    for (const command of commands) {
      for (const id of IDS) expect(now.composeFailureMessage(command, id), JSON.stringify({ command, id })).toBe(legacy.composeFailureMessage(command, id));
    }
  });

  it('composeServiceRequiredMessage', () => {
    for (const name of NAMES) {
      for (const id of IDS) expect(now.composeServiceRequiredMessage(name, id), JSON.stringify({ name, id })).toBe(legacy.composeServiceRequiredMessage(name, id));
    }
  });

  it('managedServiceRequiredMessage·composeConfigUnreadableMessage·readinessStoppedMessage', () => {
    for (const name of NAMES) {
      expect(now.managedServiceRequiredMessage(name), JSON.stringify(name)).toBe(legacy.managedServiceRequiredMessage(name));
      expect(now.readinessStoppedMessage(name), JSON.stringify(name)).toBe(legacy.readinessStoppedMessage(name));
      expect(now.composeConfigUnreadableMessage(name), JSON.stringify(name)).toBe(legacy.composeConfigUnreadableMessage(name));
    }
  });
});

describe('무작위 조합에서 옛 쪽과 같다', () => {
  // mulberry32: 시드가 같으면 늘 같은 입력이 나온다
  function makeRandom(seed: number): () => number {
    let state = seed | 0;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  it('2천 조합', () => {
    const rand = makeRandom(20_261_118);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    const word = () => {
      const pieces = ['a', '-', ' ', "'", '"', '\n', '\0', '$', '`', '한', '😀', '\u2028', '1e21'];
      return Array.from({ length: Math.floor(rand() * 8) }, () => pick(pieces)).join('');
    };
    const list = () => Array.from({ length: Math.floor(rand() * 4) }, word);
    for (let index = 0; index < 2000; index += 1) {
      const project = word();
      const root = word();
      const compose = word();
      const override = word();
      const args = list();
      expect(now.composeCommandArgs(project, root, compose, override, args), `${index}`).toEqual(legacy.composeCommandArgs(project, root, compose, override, args));

      const name = word();
      const running = rand() < 0.5;
      expect(now.serviceRunningArgs(name, running), `${index}`).toEqual(legacy.serviceRunningArgs(name, running));

      const services = list();
      const follow = rand() < 0.5;
      const tail = pick(NUMBERS);
      expect(now.composeLogsArgs(services, follow, String(tail)), `${index}`).toEqual(legacy.composeLogsArgs(services, follow, tail));

      expect(now.composeExecArgs(name, args), `${index}`).toEqual(legacy.composeExecArgs(name, args));

      const noCache = rand() < 0.5;
      const selected = rand() < 0.3 ? undefined : list();
      expect(now.sandboxBuildArgs(noCache, selected), `${index}`).toEqual(legacy.sandboxBuildArgs(noCache, selected));

      expect(now.composeFailureMessage(project, root), `${index}`).toBe(legacy.composeFailureMessage(project, root));
    }
  });
});

describe('의도한 차이', () => {
  it('짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다. docker에 넘기는 argv 바이트는 옛 쪽과 같다(Node의 UTF-8 인코딩도 같은 치환을 한다)', () => {
    const command = ['a\ud83d', '\ude00b', '😀'];
    const old = legacy.composeExecArgs('web', command);
    const fresh = now.composeExecArgs('web', command);
    // 짝을 이룬 😀는 그대로이고, 짝이 없는 단위만 U+FFFD가 된다
    expect(fresh).toEqual(['exec', '-T', 'web', 'a\ufffd', '\ufffdb', '😀']);
    // 배열 글자는 다르지만 docker가 받는 바이트는 같다
    expect(fresh.map((part) => Buffer.from(part, 'utf8'))).toEqual(old.map((part) => Buffer.from(part, 'utf8')));
  });

  it('오류 글에 든 짝 없는 서로게이트는 U+FFFD로 바뀐다(글자를 화면에 쓸 때 Node도 같은 치환을 한다)', () => {
    const name = 'we\ud83db';
    const old = legacy.managedServiceRequiredMessage(name);
    const fresh = now.managedServiceRequiredMessage(name);
    expect(fresh).toBe(old.replace('\ud83d', '\ufffd'));
    expect(Buffer.from(fresh, 'utf8')).toEqual(Buffer.from(old, 'utf8'));
  });
});
