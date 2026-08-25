#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Smoke test: deploys a Nuclio function through Node-RED against a real
# Nuclio dashboard and invokes it. Requires Docker Compose v2.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SMOKE_DIR="$PROJECT_DIR/hack/compose-smoke"
COMPOSE_FILE="$SMOKE_DIR/docker-compose.yml"
RED="\033[0;31m"  GREEN="\033[0;32m"  YELLOW="\033[0;33m"  NC="\033[0m"

SMOKE_FN="smoke-test"
NR_URL="http://localhost:1882"
NUCLIO_URL="http://localhost:8072"
TIMEOUT=120  # seconds to wait for the function to become ready
POLL_INTERVAL=3

# Compose requires an explicit architecture so a production-like smoke test
# cannot accidentally pull the ARM64 dashboard image on an x86 host.
if [ -z "${NUCLIO_ARCH:-}" ]; then
    case "$(uname -m)" in
        aarch64|arm64) NUCLIO_ARCH=arm64 ;;
        amd64|x86_64) NUCLIO_ARCH=amd64 ;;
        *) echo "Unsupported host architecture: $(uname -m)" >&2; exit 2 ;;
    esac
    export NUCLIO_ARCH
fi
if [ -z "${NUCLIO_DASHBOARD_IMAGE:-}" ]; then
    export NUCLIO_DASHBOARD_IMAGE="quay.io/nuclio/dashboard:1.17.5-${NUCLIO_ARCH}"
fi

cleanup() {
    echo ""
    echo -e "${YELLOW}==> Tearing down docker-compose...${NC}"
    docker compose -f "$COMPOSE_FILE" down --volumes 2>/dev/null || true
    if [ -n "${EXIT_CODE:-}" ] && [ "$EXIT_CODE" != "0" ]; then
        echo -e "${RED}SMOKE TEST FAILED${NC}"
    else
        echo -e "${GREEN}SMOKE TEST PASSED${NC}"
    fi
    exit "${EXIT_CODE:-0}"
}

trap cleanup EXIT INT TERM

# ------ Step 1: start the stack ------------------------------------------

echo -e "${YELLOW}==> Building and starting Docker Compose...${NC}"
docker compose -f "$COMPOSE_FILE" down --volumes 2>/dev/null || true
docker compose -f "$COMPOSE_FILE" up -d --build

# ------ Step 2: wait for services ----------------------------------------

echo -e "${YELLOW}==> Waiting for Node-RED...${NC}"
for i in $(seq 1 60); do
    if curl -sf -o /dev/null "$NR_URL" 2>/dev/null; then
        echo -e "${GREEN}  Node-RED is up.${NC}"
        break
    fi
    if [ "$i" -eq 60 ]; then echo -e "${RED}Node-RED did not start in time.${NC}"; EXIT_CODE=1; exit 1; fi
    sleep 2
done

echo -e "${YELLOW}==> Waiting for Nuclio dashboard...${NC}"
for i in $(seq 1 60); do
    if curl -sf -o /dev/null "$NUCLIO_URL/api/functions" 2>/dev/null; then
        echo -e "${GREEN}  Nuclio dashboard is up.${NC}"
        break
    fi
    if [ "$i" -eq 60 ]; then echo -e "${RED}Nuclio dashboard did not start in time.${NC}"; EXIT_CODE=1; exit 1; fi
    sleep 3
done

# ------ Step 3: wait for the function to deploy and be ready --------------

echo -e "${YELLOW}==> Waiting for function '$SMOKE_FN' to become ready (timeout ${TIMEOUT}s)...${NC}"
START_TS=$(date +%s)
while true; do
    ELAPSED=$(( $(date +%s) - START_TS ))
    if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
        echo -e "${RED}Timed out waiting for function to become ready.${NC}"
        echo "Last known state:"
        curl -sf "$NUCLIO_URL/api/functions" | python3 -m json.tool 2>/dev/null || true
        docker logs nodered-nuclio-smoke --tail 40 2>/dev/null || true
        EXIT_CODE=1; exit 1
    fi

    STATE=$(curl -sf "$NUCLIO_URL/api/functions/$SMOKE_FN" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",{}).get("state",""))' 2>/dev/null || echo "")

    case "$STATE" in
        ready)
            echo -e "${GREEN}  Function is ready (took ${ELAPSED}s).${NC}"
            break
            ;;
        error)
            echo -e "${RED}  Function entered error state.${NC}"
            docker logs nodered-nuclio-smoke --tail 60 2>/dev/null || true
            EXIT_CODE=1; exit 1
            ;;
        "")
            echo "  [$ELAPSED s] nuclio not yet listing function..."
            ;;
        *)
            echo "  [$ELAPSED s] state: $STATE"
            ;;
    esac
    sleep "$POLL_INTERVAL"
done

# Node-RED may observe the dashboard function a little after the dashboard
# itself reports it ready. Wait for the local invoke node to have a usable
# endpoint before sending an HTTP request that would otherwise remain open.
echo -e "${YELLOW}==> Waiting for Node-RED function state...${NC}"
for i in $(seq 1 60); do
    if curl -fsS --max-time 5 \
        "$NR_URL/nuclio/api/functions?id=smoke-function&view=summary" 2>/dev/null \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status", {}).get("state") == "ready"; assert d.get("invocation", {}).get("urls")' 2>/dev/null; then
        echo -e "${GREEN}  Node-RED function is ready.${NC}"
        break
    fi
    if [ "$i" -eq 60 ]; then
        echo -e "${RED}Node-RED function did not become ready in time.${NC}"
        EXIT_CODE=1; exit 1
    fi
    sleep 2
done

# ------ Step 4: invoke the function ---------------------------------------

echo -e "${YELLOW}==> Invoking function...${NC}"

# Invoke through Node-RED's HTTP-in -> nuclio -> HTTP-response path. This
# validates both deployment and the public node invocation contract.
RESPONSE=$(curl -sf -X POST \
    --max-time "$TIMEOUT" \
    -H 'Content-Type: application/json' \
    -d '{"hello":"world"}' \
    "$NR_URL/smoke-test" 2>&1) || {
    echo -e "${RED}Invocation through Node-RED failed:${NC} $RESPONSE"
    EXIT_CODE=1; exit 1
}

echo "  Response: $RESPONSE"

if echo "$RESPONSE" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d.get("ok") is True; assert d.get("echo") == {"hello":"world"}' 2>/dev/null; then
    echo -e "${GREEN}  Invocation response verified.${NC}"
else
    echo -e "${RED}  Unexpected response: $RESPONSE${NC}"
    EXIT_CODE=1; exit 1
fi

EXIT_CODE=0
