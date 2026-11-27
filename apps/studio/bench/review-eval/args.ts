/** 명령줄 인자 해석(실행 없이 시험하려고 run.ts에서 떼어 둔다) */
export interface EvalArgs {
  ask: 'claude-code' | 'fake';
  model?: string;
  out?: string;
}

export function parseArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = { ask: 'claude-code' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} 뒤에 값이 필요합니다`);
      i += 1;
      return next;
    };
    if (arg === '--ask') {
      const v = value();
      if (v !== 'claude-code' && v !== 'fake') throw new Error(`--ask는 claude-code 또는 fake여야 합니다: ${v}`);
      args.ask = v;
    } else if (arg === '--model') args.model = value();
    else if (arg === '--out') args.out = value();
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  return args;
}
