import { describe, expect, it } from 'vitest';
import { findPolicyViolations, isSensitiveHostPath } from './docker/container-policy';
import { assertReadonlyDockerArgs } from './docker/readonly-exec';
import { parseDotenv, Redactor } from './secrets';

/**
 * 막는 검사 판정을 Rust로 옮기면서(ADR-191 1단계, #996) JS와 Rust가 다르게 읽기 쉬운 입력을 고정한다.
 * 기대값은 옮기기 전 TS 구현을 돌려 얻은 값이다. "의도한 차이"라고 적은 테스트만 옛 값과 다르고, 모두 거부 쪽으로 넓어진 것이다
 */

describe('시크릿 파일 읽기: JS의 trim·\\s·.·역참조와 같게 읽는다', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['\uFEFFA=1', { A: '1' }], // BOM은 JS trim이 지운다(Rust str::trim은 지우지 않는다)
    ['A=1\rB=2', {}], // \r만 있는 줄 끝은 나누지 않고, 값의 \r은 `.`과 맞지 않아 줄이 버려진다
    ['A=1\r\nB=2\r\n', { A: '1', B: '2' }],
    ['A=x\u2028y', {}],
    ['A=\u0085x', { A: '\u0085x' }], // U+0085는 JS 공백이 아니다
    ['A="', { A: '"' }],
    ['A=""', { A: '' }],
    ["A='a\"", { A: "'a\"" }],
    ['A=1\nA=2', { A: '2' }],
    ['export FOO=1', { FOO: '1' }],
    ['export=1', { export: '1' }],
    ['export =1', { export: '1' }],
    ['exportFOO=1', { exportFOO: '1' }],
    ['export FOO', {}],
    ['export\u3000FOO=2', { FOO: '2' }],
    ['가=1\n_x9=2\n9x=3', { _x9: '2' }],
    ['  # c\n\tB =  "q"  ', { B: 'q' }],
  ];
  it.each(cases)('%j', (text, expected) => {
    expect(parseDotenv(text)).toEqual(expected);
  });
});

describe('호스트 경로 판정: path.posix.normalize와 같게 읽는다', () => {
  const cases: Array<[string, boolean]> = [
    ['/etc/../etc/passwd', true],
    ['//etc', true],
    ['/etc/./', true],
    ['/etcetera', false],
    ['/var/run/docker.sock', true],
    ['/home/x/DOCKER.sock', true],
    ['\\\\.\\pipe\\docker_engine', true],
    ['C:\\Users', false],
    ['/host_mnt/Users/a', false],
    ['/host_mnt/../etc', true],
    ['/host_mnt/', false],
    ['relative/path', true],
    ['', true],
    ['/etc\\x', false], // 역슬래시는 POSIX에서 보통 글자다
    ['/home/a/../b', false],
    ['/a/../../etc', true],
    ['/run/desktop/mnt/host/c/../../../../proc', true],
  ];
  it.each(cases)('%j → %s', (source, expected) => {
    expect(isSensitiveHostPath(source)).toBe(expected);
  });

  it('소켓 이름을 Unicode 대소문자 접기로 넓게 잡는다(의도한 차이: 옛 TS는 false)', () => {
    expect(isSensitiveHostPath('/x/docker.ſock')).toBe(true);
  });
});

describe('출력 가림: 길이와 정렬은 UTF-16 기준, 같은 길이는 넘긴 순서', () => {
  const cases: Array<[Record<string, string>, string, { redact: string; find: string[] }]> = [
    // 한글 값은 UTF-16으로 8, 바이트로 24다. 9글자 ASCII 값이 먼저 가려진다
    [{ K: '가나다라마바사아', A: '123456789' }, '123456789가나다라마바사아', { redact: '[A 가림][K 가림]', find: ['A', 'K'] }],
    // 두 값이 `9`에서 겹친다. UTF-16 길이는 A(9) > K(8)라 A를 먼저 가리고, 바이트 길이(K 22)로 정렬하면 K가 먼저 가려져 결과가 달라진다
    [{ K: '9가나다라마바사', A: '123456789' }, '123456789가나다라마바사', { redact: '[A 가림]가나다라마바사', find: ['A', 'K'] }],
    // find의 정렬은 UTF-16 코드 단위 순서(😀=0xD83D가 ～=0xFF5E보다 앞)
    [{ '😀': 'xxxxxxxxyy', '\uFF5E': 'yyxxxxxxxx' }, 'xxxxxxxxyy yyxxxxxxxx', { redact: '[😀 가림] [\uFF5E 가림]', find: ['😀', '\uFF5E'] }],
    [{ Z: 'abcdefghij', B: 'efghijklmn' }, 'abcdefghijklmn', { redact: '[Z 가림]klmn', find: ['B', 'Z'] }],
    [{ R: "A-z_0.!~*'() #$&+,/:;=?@[]" }, "A-z_0.!~*'()%20%23%24%26%2B%2C%2F%3A%3B%3D%3F%40%5B%5D", { redact: '[R 가림]', find: ['R'] }],
    [{ U: '비밀번호값입니다😀' }, 'YWLruYTrsIDrsojtmLjqsJLsnoXri4jri6Twn5iACg==', { redact: 'YWL[U 가림]Cg==', find: ['U'] }],
    // 정수 같은 이름은 JS 객체에서 먼저 온다(Object.entries 순서). 같은 길이의 값은 그 순서로 가린다
    [{ b: 'samelengtx', '10': 'samelength', '2': 'samelengtz' }, 'samelength samelengtz samelengtx', { redact: '[10 가림] [2 가림] [b 가림]', find: ['10', '2', 'b'] }],
  ];
  it.each(cases)('%j', (secrets, text, expected) => {
    const redactor = new Redactor(secrets);
    expect({ redact: redactor.redact(text), find: redactor.find(text) }).toEqual(expected);
  });

  it('빈 형태로 가리지 않는다(의도한 차이: 옛 TS는 `bcd`를 글자 사이마다 가렸다. 8자 미만 값은 resolveSecrets가 받지 않는다)', () => {
    expect(new Redactor({ X: 'a' }).redact('bcd')).toBe('bcd');
  });
});

describe('컨테이너 정책: 모양을 모르는 값은 걸린 것으로 센다', () => {
  const OPTIONS = { projectName: 'sb1', sandboxNetwork: 'b-studio-sandbox', egressNetwork: 'b-studio-egress', edgeService: 'b-studio-edge' };

  it('의도한 차이: 옛 TS는 문자열 CapAdd에서 던지고, 문자열 Privileged를 참으로 읽었다', () => {
    const container = { Id: 'x', HostConfig: { Privileged: 'true', CapAdd: 'SYS_ADMIN', PortBindings: { '80/tcp': 'x' } }, Mounts: [{ Type: 'bind', Source: 1 }, 'x'] };
    expect(findPolicyViolations(container as never, OPTIONS)).toEqual([
      '알 수 없는 형식: HostConfig.Privileged',
      '알 수 없는 형식: HostConfig.CapAdd',
      '알 수 없는 형식: HostConfig.PortBindings.80/tcp',
      '알 수 없는 형식: Mounts.Source',
      '알 수 없는 형식: Mounts',
    ]);
  });

  it('네트워크 이름은 JS 객체 순서(정수 같은 이름 먼저)로 적는다', () => {
    const container = { Id: 'x', Config: { Labels: { 'com.docker.compose.service': 'api' } }, NetworkSettings: { Networks: { b: {}, '10': {}, '2': {} } } };
    expect(findPolicyViolations(container, OPTIONS)).toEqual(['networks: 2, 10, b']);
  });
});

describe('읽기 전용 docker', () => {
  it('이름이 정확히 같아야 한다', () => {
    for (const sub of ['PS', 'ps ', ' ps', 'inspect\0', '']) expect(() => assertReadonlyDockerArgs([sub])).toThrow(/허용하지 않습니다/);
    expect(() => assertReadonlyDockerArgs(['ps', '-a'])).not.toThrow();
  });
});
