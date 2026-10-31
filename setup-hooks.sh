#!/usr/bin/env bash
# Install repo-tracked git hooks. Run once per clone; idempotent.
# `core.hooksPath` is a local-only setting, so we can't track it in git
# directly — this script wires it up.
set -e
cd "$(dirname "$0")"
chmod +x .githooks/* 2>/dev/null || true
git config core.hooksPath .githooks
echo "✓ hooksPath -> .githooks (multi-agent collision guard active)"
