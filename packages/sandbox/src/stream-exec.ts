import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { ExecResult } from './types';

const CAPTURE_LIMIT = 1024 * 1024;

interface StreamExecOptions {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export async function runCommandToFile(bin: string, args: string[], outputFile: string, { signal, env }: StreamExecOptions = {}): Promise<ExecResult> {
  const child = spawn(bin, args, { signal, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = capture(child.stderr);
  const finished = waitForClose(child);
  const piped = pipeline(child.stdout, createWriteStream(outputFile)).catch((error: unknown) => error);
  const [exitCode, pipeError] = await Promise.all([finished, piped]);
  if (pipeError instanceof Error && exitCode === 0) throw pipeError;
  return { exitCode, stdout: '', stderr: stderr() };
}

export async function runCommandFromFile(bin: string, args: string[], inputFile: string, { signal, env }: StreamExecOptions = {}): Promise<ExecResult> {
  const child = spawn(bin, args, { signal, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  const finished = waitForClose(child);
  const piped = pipeline(createReadStream(inputFile), child.stdin).catch((error: unknown) => error);
  const [exitCode, pipeError] = await Promise.all([finished, piped]);
  if (pipeError instanceof Error && exitCode === 0) throw pipeError;
  return { exitCode, stdout: stdout(), stderr: stderr() };
}

function capture(stream: NodeJS.ReadableStream): () => string {
  let text = '';
  let truncated = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    if (text.length >= CAPTURE_LIMIT) {
      truncated = true;
      return;
    }
    const room = CAPTURE_LIMIT - text.length;
    text += chunk.slice(0, room);
    truncated ||= chunk.length > room;
  });
  return () => `${text}${truncated ? '\n... output truncated ...' : ''}`;
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}
