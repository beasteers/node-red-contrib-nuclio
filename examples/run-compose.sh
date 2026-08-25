#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 2 ]]; then
    echo "usage: $0 <example> <compose-command> [args...]" >&2
    echo "examples: http, cron, batching, mqtt, nats-request, nats-mqtt" >&2
    exit 2
fi

example="$1"
shift
case "$example" in
    http|cron|batching|mqtt|nats-request|nats-mqtt) ;;
    *) echo "unknown example: $example" >&2; exit 2 ;;
esac

case "${NUCLIO_ARCH:-$(uname -m)}" in
    amd64|x86_64) detected_arch=amd64 ;;
    arm64|aarch64) detected_arch=arm64 ;;
    *)
        echo "unsupported architecture: ${NUCLIO_ARCH:-$(uname -m)}; set NUCLIO_ARCH to amd64 or arm64" >&2
        exit 2
        ;;
esac

export NUCLIO_ARCH="$detected_arch"
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
compose_file="$repo_dir/examples/compose/$example/docker-compose.yml"
exec docker compose -f "$compose_file" "$@"
