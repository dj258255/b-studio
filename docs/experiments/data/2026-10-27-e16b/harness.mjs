// E16-b(#659) 측정 하네스. 구독 로그인으로 모델을 부른다. 사용: node harness.mjs <명령> [인자]
import { query } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

export const PROJECT = process.env.E16B_PROJECT;
const LOG = process.env.E16B_LOG;
const TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];

/** 한 번 묻고 결과·사용량·압축 기록을 돌려준다. resume가 있으면 그 대화를 이어받고, fork면 갈라서 이어받는다 */
export async function ask(prompt, { resume, fork = false, label, maxTurns = 12 } = {}) {
  const started = Date.now();
  const out = { label, prompt: prompt.slice(0, 200), resume, fork, compactions: [], assistantUsage: [], startedAt: new Date(started).toISOString() };
  const ids = new Set();
  const conversation = query({
    prompt,
    options: {
      cwd: PROJECT,
      model: 'sonnet',
      tools: TOOLS,
      allowedTools: TOOLS,
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      maxTurns,
      ...(resume ? { resume, forkSession: fork } : {}),
    },
  });
  for await (const m of conversation) {
    if (m.session_id) out.sessionId = m.session_id;
    if (m.type === 'system' && m.subtype === 'init') out.model = m.model;
    if (m.type === 'system' && m.subtype === 'compact_boundary') out.compactions.push(m.compact_metadata && { trigger: m.compact_metadata.trigger, pre: m.compact_metadata.pre_tokens, post: m.compact_metadata.post_tokens, ms: m.compact_metadata.duration_ms });
    if (m.type === 'assistant' && !m.parent_tool_use_id && !ids.has(m.message.id)) {
      ids.add(m.message.id);
      const u = m.message.usage ?? {};
      out.assistantUsage.push({ input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 });
    }
    if (m.type === 'assistant') {
      const text = m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) out.lastText = text;
    }
    if (m.type === 'result') {
      out.subtype = m.subtype;
      out.turns = m.num_turns;
      out.apiMs = m.duration_api_ms;
      out.costUsd = m.total_cost_usd;
      out.usage = { input: m.usage?.input_tokens ?? 0, cacheRead: m.usage?.cache_read_input_tokens ?? 0, cacheWrite: m.usage?.cache_creation_input_tokens ?? 0, output: m.usage?.output_tokens ?? 0 };
      out.modelUsage = m.modelUsage;
      if (m.result) out.result = m.result;
    }
  }
  out.wallMs = Date.now() - started;
  const first = out.assistantUsage[0];
  out.firstContext = first ? first.input + first.cacheRead + first.cacheWrite : undefined;
  if (LOG) appendFileSync(LOG, JSON.stringify(out) + '\n');
  return out;
}

if (process.argv[2] === 'ask') {
  const r = await ask(process.argv[3], { resume: process.argv[4], fork: process.argv[5] === 'fork', label: 'manual' });
  console.log(JSON.stringify(r, null, 1));
}
