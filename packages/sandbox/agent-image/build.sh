#!/bin/sh
# 에이전트 이미지(codex 포함)를 만든다. 이 스크립트는 사람이 부른다 — 시험과 CI는 이미지를 만들지 않는다.
# 이미지 이름은 packages/sandbox/src/docker/agent-image.ts의 AGENT_CODEX_IMAGE와 같아야 한다(시험이 확인한다).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tag=$(sed -n "s/^export const AGENT_CODEX_IMAGE = '\(.*\)';$/\1/p" "$here/../src/docker/agent-image.ts")
[ -n "$tag" ] || { echo "AGENT_CODEX_IMAGE를 읽지 못했습니다" >&2; exit 1; }
exec docker build --tag "$tag" "$here"
