#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CLOSING_KEYWORD = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+\b/i;
const CLOSING_LINE = /^(close[sd]?|fix(e[sd])?|resolve[sd]?)\b/i;
const REQUIRED_SECTIONS = ['무엇을', '검증', '돌리지 않은 검증과 이유', '예상과 실제'];

function stripComments(body) {
  return body.replace(/<!--[\s\S]*?-->/g, '');
}

function collectSections(body) {
  const sections = new Map();
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.*?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections.set(current, []);
      continue;
    }
    if (current !== null) sections.get(current).push(line);
  }
  return sections;
}

function isSectionEmpty(lines) {
  return lines.every((line) => line.trim() === '' || CLOSING_LINE.test(line.trim()));
}

export function checkPrBody(body, { baseRef, defaultBranch } = {}) {
  const problems = [];
  const notes = [];
  const cleaned = stripComments(body ?? '');

  if (!CLOSING_KEYWORD.test(cleaned)) {
    problems.push(
      '`Closes #이슈번호`가 없습니다. PR이 이슈 일부만 끝내면 하위 이슈를 만들어 그 하위 이슈를 닫으세요',
    );
  }

  const sections = collectSections(cleaned);
  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) {
      problems.push(`필수 절 \`## ${name}\`이 없습니다`);
    } else if (isSectionEmpty(sections.get(name))) {
      problems.push(`필수 절 \`## ${name}\`이 비어 있습니다`);
    }
  }

  if (baseRef && defaultBranch && baseRef !== defaultBranch) {
    notes.push(
      '기본 브랜치가 아닌 곳을 향한 PR은 GitHub가 `Closes`를 이슈와 연결하지 않습니다. 앞 PR이 병합된 뒤 base를 기본 브랜치로 바꾸세요',
    );
  }

  return { ok: problems.length === 0, problems, notes };
}

function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error('::error::GITHUB_EVENT_PATH 환경 변수가 필요합니다');
    process.exit(1);
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const result = checkPrBody(event.pull_request?.body, {
    baseRef: event.pull_request?.base?.ref,
    defaultBranch: event.repository?.default_branch,
  });

  for (const note of result.notes) console.log(`::notice::${note}`);
  for (const problem of result.problems) console.log(`::error::${problem}`);

  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
