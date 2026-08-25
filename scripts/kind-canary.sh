#!/usr/bin/env bash
set -Eeuo pipefail

# Compatibility entrypoint. The KinD fixture lives under hack/kind; keep this
# path for existing npm scripts and contributor commands.
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$PROJECT_DIR/hack/kind/run.sh" "$@"
