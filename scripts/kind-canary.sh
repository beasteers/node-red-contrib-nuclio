#!/usr/bin/env bash
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Disposable Kubernetes canary. This intentionally uses a prebuilt function
# image loaded into KinD, so it validates the Node-RED package against Nuclio's
# Kubernetes API without requiring a registry or a Kaniko configuration.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-nuclio-node-red-canary}"
NUCLIO_NAMESPACE="${NUCLIO_NAMESPACE:-nuclio}"
NUCLIO_PROJECT="${NUCLIO_PROJECT:-node-red-canary}"
CANARY_FUNCTION_NAME="${CANARY_FUNCTION_NAME:-node-red-kind-canary}"
NUCLIO_VERSION="${NUCLIO_VERSION:-1.17.3}"
NUCLIO_CHART_VERSION="${NUCLIO_CHART_VERSION:-0.23.3}"
CANARY_IMAGE="${CANARY_IMAGE:-node-red-nuclio-kind-canary:latest}"
KIND_CANARY_KEEP_CLUSTER="${KIND_CANARY_KEEP_CLUSTER:-0}"

DASHBOARD_PORT="${DASHBOARD_PORT:-18070}"
NODE_RED_PORT="${NODE_RED_PORT:-18880}"
FUNCTION_PORT="${FUNCTION_PORT:-18080}"

case "$(uname -m)" in
    x86_64|amd64) NUCLIO_ARCH=amd64 ;;
    arm64|aarch64) NUCLIO_ARCH=arm64 ;;
    *) echo "Unsupported host architecture: $(uname -m)" >&2; exit 2 ;;
esac

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nuclio-kind-canary.XXXXXX")"
BUILD_DIR="$TMP_DIR/function-image"
NODE_RED_USER_DIR="$TMP_DIR/node-red"
LOG_DIR="$TMP_DIR/logs"
mkdir -p "$BUILD_DIR" "$NODE_RED_USER_DIR/node_modules/@bea.steers" "$LOG_DIR"

CLUSTER_CREATED=0
DASHBOARD_FORWARD_PID=""
FUNCTION_FORWARD_PID=""
NODE_RED_PID=""

cleanup() {
    local exit_code=$?
    trap - EXIT INT TERM

    for pid in "$DASHBOARD_FORWARD_PID" "$FUNCTION_FORWARD_PID" "$NODE_RED_PID"; do
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
    done

    if [ "$KIND_CANARY_KEEP_CLUSTER" != "1" ] && [ "$CLUSTER_CREATED" = "1" ]; then
        kind delete cluster --name "$KIND_CLUSTER_NAME" >/dev/null 2>&1 || true
    fi

    if [ "$exit_code" = "0" ]; then
        echo "KinD canary passed."
    else
        echo "KinD canary failed. Logs: $LOG_DIR" >&2
        if [ -f "$LOG_DIR/node-red.log" ]; then
            echo "--- Node-RED log tail ---" >&2
            tail -n 80 "$LOG_DIR/node-red.log" >&2 || true
        fi
        if [ -f "$LOG_DIR/dashboard-port-forward.log" ]; then
            echo "--- Dashboard port-forward log ---" >&2
            tail -n 40 "$LOG_DIR/dashboard-port-forward.log" >&2 || true
        fi
    fi

    if [ "$exit_code" != "0" ] || [ "$KIND_CANARY_KEEP_CLUSTER" = "1" ]; then
        echo "Canary files kept: $TMP_DIR"
        if [ "$KIND_CANARY_KEEP_CLUSTER" = "1" ]; then
            echo "Cluster kept: $KIND_CLUSTER_NAME"
        fi
    else
        rm -rf "$TMP_DIR"
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

require_command() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "Missing required command: $1" >&2
        exit 2
    }
}

for command in docker kind kubectl helm curl python3 npm; do
    require_command "$command"
done

NODE_RED_BIN="$PROJECT_DIR/node_modules/node-red/red.js"
if [ ! -f "$NODE_RED_BIN" ]; then
    echo "Node-RED is not installed. Run npm ci before starting the canary." >&2
    exit 2
fi

dashboard_url="http://127.0.0.1:$DASHBOARD_PORT"
node_red_url="http://127.0.0.1:$NODE_RED_PORT"

wait_for_http() {
    local url="$1"
    local attempts="${2:-120}"
    local i
    for i in $(seq 1 "$attempts"); do
        if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
        sleep 2
    done
    echo "Timed out waiting for $url" >&2
    return 1
}

dashboard_get() {
    curl -sS \
        -H "x-nuclio-function-namespace: $NUCLIO_NAMESPACE" \
        -H "x-nuclio-project-name: $NUCLIO_PROJECT" \
        "$dashboard_url$1"
}

echo "Creating KinD cluster: $KIND_CLUSTER_NAME"
kind_args=(create cluster --name "$KIND_CLUSTER_NAME")
if [ -n "${KIND_NODE_IMAGE:-}" ]; then kind_args+=(--image "$KIND_NODE_IMAGE"); fi
kind "${kind_args[@]}" \
    >"$LOG_DIR/kind.log" 2>&1
CLUSTER_CREATED=1
kubectl --context "kind-$KIND_CLUSTER_NAME" config use-context "kind-$KIND_CLUSTER_NAME" >/dev/null

echo "Installing Nuclio $NUCLIO_VERSION from Helm chart $NUCLIO_CHART_VERSION"
helm repo add nuclio https://nuclio.github.io/nuclio/charts --force-update >/dev/null
helm repo update >/dev/null
kubectl create namespace "$NUCLIO_NAMESPACE" >/dev/null
helm upgrade --install nuclio nuclio/nuclio \
    --version "$NUCLIO_CHART_VERSION" \
    --namespace "$NUCLIO_NAMESPACE" \
    --wait --timeout 10m \
    --set-string "controller.image.tag=$NUCLIO_VERSION-$NUCLIO_ARCH" \
    --set-string "dashboard.image.tag=$NUCLIO_VERSION-$NUCLIO_ARCH" \
    --set dashboard.containerBuilderKind=kaniko \
    >"$LOG_DIR/helm.log" 2>&1

kubectl rollout status deployment/nuclio-controller -n "$NUCLIO_NAMESPACE" --timeout=5m
kubectl rollout status deployment/nuclio-dashboard -n "$NUCLIO_NAMESPACE" --timeout=5m

cat >"$BUILD_DIR/Dockerfile" <<'EOF_DOCKERFILE'
ARG NUCLIO_VERSION=1.17.3
ARG NUCLIO_ARCH=amd64
ARG NUCLIO_ONBUILD_IMAGE=quay.io/nuclio/handler-builder-python-onbuild:${NUCLIO_VERSION}-${NUCLIO_ARCH}

FROM ${NUCLIO_ONBUILD_IMAGE} AS processor
FROM python:3.12-slim

COPY --from=processor /home/nuclio/bin/processor /usr/local/bin/processor
COPY --from=processor /home/nuclio/bin/py /opt/nuclio/
COPY --from=processor /home/nuclio/bin/py*-whl/* /opt/nuclio/whl/

RUN python /opt/nuclio/whl/$(basename /opt/nuclio/whl/pip-*.whl)/pip install pip --no-index --find-links /opt/nuclio/whl \
    && python -m pip install --no-cache-dir msgpack \
    && python -m pip install nuclio-sdk --no-index --find-links /opt/nuclio/whl

COPY main.py /opt/nuclio/main.py
CMD ["processor"]
EOF_DOCKERFILE

cat >"$BUILD_DIR/main.py" <<'EOF_FUNCTION'
def handler(context, event):
    return {"ok": True, "echo": event.body}
EOF_FUNCTION

echo "Building and loading canary function image: $CANARY_IMAGE"
docker build --pull --platform "linux/$NUCLIO_ARCH" \
    --build-arg "NUCLIO_VERSION=$NUCLIO_VERSION" \
    --build-arg "NUCLIO_ARCH=$NUCLIO_ARCH" \
    --tag "$CANARY_IMAGE" "$BUILD_DIR" \
    >"$LOG_DIR/docker-build.log" 2>&1
kind load docker-image "$CANARY_IMAGE" --name "$KIND_CLUSTER_NAME" \
    >"$LOG_DIR/kind-load.log" 2>&1

echo "Forwarding the Nuclio dashboard"
kubectl port-forward -n "$NUCLIO_NAMESPACE" service/nuclio-dashboard "$DASHBOARD_PORT:8070" \
    >"$LOG_DIR/dashboard-port-forward.log" 2>&1 &
DASHBOARD_FORWARD_PID=$!
wait_for_http "$dashboard_url/api/functions"

ln -s "$PROJECT_DIR" "$NODE_RED_USER_DIR/node_modules/@bea.steers/node-red-contrib-nuclio"
cat >"$NODE_RED_USER_DIR/settings.js" <<EOF_SETTINGS
module.exports = {
    flowFile: 'flows.json',
    flowFilePretty: true,
    uiPort: $NODE_RED_PORT,
    editorTheme: { tours: false },
    logging: { console: { level: 'info' } },
};
EOF_SETTINGS

cat >"$NODE_RED_USER_DIR/flows.json" <<EOF_FLOWS
[
  {"id":"canary-tab","type":"tab","label":"KinD Canary","disabled":false,"info":""},
  {"id":"canary-server","type":"nuclio-config","address":"$dashboard_url","addressType":"str","namespace":"$NUCLIO_NAMESPACE","namespaceType":"str","publicAddress":"$dashboard_url","publicAddressType":"str","invocationUrlPreference":"service","internalInvocationServiceHost":"127.0.0.1:$FUNCTION_PORT","internalInvocationServiceHostType":"str","deploymentPolicy":"managed","requestTimeoutMs":"10000","deployTimeoutMs":"60000"},
  {"id":"canary-project","type":"nuclio-project","name":"$NUCLIO_PROJECT","nameType":"str"},
  {"id":"canary-function","type":"nuclio-function","server":"canary-server","project":"canary-project","name":"$CANARY_FUNCTION_NAME","runtime":"python:3.12","sourceType":"image","codeEntryPath":"$CANARY_IMAGE","deploymentMode":"eager","maxSelfHealAttempts":"1","redeployDeadlineMs":"120000","autoRedeployOnError":"false","autoRedeployOnErrorType":"bool","configCode":"spec:\\n  imagePullPolicy: IfNotPresent\\n"},
  {"id":"canary-http-in","type":"http in","z":"canary-tab","name":"","url":"/kind-canary","method":"post","upload":false,"swaggerDoc":"","x":120,"y":120,"wires":[["canary-invoke"]]},
  {"id":"canary-invoke","type":"nuclio","z":"canary-tab","function":"canary-function","name":"","timeoutMs":"30000","maxInFlight":"1","retries":"0","retryDelayMs":"500","headers":[],"x":320,"y":120,"wires":[["canary-http-response"],[]]},
  {"id":"canary-http-response","type":"http response","z":"canary-tab","name":"","statusCode":"","headers":{},"x":530,"y":120,"wires":[]}
]
EOF_FLOWS

echo "Starting Node-RED with the working-tree package"
node "$NODE_RED_BIN" --userDir "$NODE_RED_USER_DIR" --port "$NODE_RED_PORT" \
    >"$LOG_DIR/node-red.log" 2>&1 &
NODE_RED_PID=$!
wait_for_http "$node_red_url"

echo "Waiting for the canary function to become ready"
state=""
for i in $(seq 1 120); do
    state="$(dashboard_get "/api/functions/$CANARY_FUNCTION_NAME" 2>/dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status", {}).get("state", ""))' \
        2>/dev/null || true)"
    case "$state" in
        ready) break ;;
        error|unhealthy)
            echo "Canary function entered state: $state" >&2
            kubectl get nucliofunction "$CANARY_FUNCTION_NAME" -n "$NUCLIO_NAMESPACE" -o yaml >&2 || true
            exit 1
            ;;
    esac
    if [ "$i" = "120" ]; then
        echo "Timed out waiting for function; last state: ${state:-unknown}" >&2
        kubectl get nucliofunction "$CANARY_FUNCTION_NAME" -n "$NUCLIO_NAMESPACE" -o yaml >&2 || true
        exit 1
    fi
    sleep 2
done

echo "Forwarding the canary function service"
kubectl port-forward -n "$NUCLIO_NAMESPACE" "service/nuclio-$CANARY_FUNCTION_NAME" "$FUNCTION_PORT:8080" \
    >"$LOG_DIR/function-port-forward.log" 2>&1 &
FUNCTION_FORWARD_PID=$!
sleep 2

echo "Invoking through the Node-RED nuclio node"
response="$(curl -fsS -X POST "$node_red_url/kind-canary" \
    -H 'Content-Type: application/json' \
    --data '{"hello":"kind"}')"
printf '%s\n' "$response"
printf '%s' "$response" | python3 -c '
import json, sys
value = json.load(sys.stdin)
assert value.get("ok") is True, value
assert value.get("echo") == {"hello": "kind"}, value
'

echo "Canary function is ready and invocation succeeded."
