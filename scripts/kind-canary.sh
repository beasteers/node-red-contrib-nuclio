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
KIND_CANARY_AUTOSCALE="${KIND_CANARY_AUTOSCALE:-0}"
KIND_CANARY_SCALE_TO_ZERO="${KIND_CANARY_SCALE_TO_ZERO:-0}"
CANARY_MIN_REPLICAS="${CANARY_MIN_REPLICAS:-1}"
CANARY_MAX_REPLICAS="${CANARY_MAX_REPLICAS:-1}"
CANARY_TARGET_CPU="${CANARY_TARGET_CPU:-50}"
CANARY_CPU_BURN_MS="${CANARY_CPU_BURN_MS:-0}"
METRICS_SERVER_VERSION="${METRICS_SERVER_VERSION:-v0.7.2}"
AUTOSCALE_PHASE_DURATION="${AUTOSCALE_PHASE_DURATION:-}"
AUTOSCALE_CONCURRENCY="${AUTOSCALE_CONCURRENCY:-512}"
AUTOSCALE_SCENARIO_CONFIG="${AUTOSCALE_SCENARIO_CONFIG:-$PROJECT_DIR/scripts/stress-scenario.kind-autoscale.example.json}"

if [ "$KIND_CANARY_AUTOSCALE" = "1" ]; then
    [ "$CANARY_MAX_REPLICAS" = "1" ] && CANARY_MAX_REPLICAS=3
    [ "$CANARY_CPU_BURN_MS" = "0" ] && CANARY_CPU_BURN_MS=20
fi

if [ "$KIND_CANARY_SCALE_TO_ZERO" = "1" ]; then
    # Scale-to-zero is an autoscaled function with a zero lower bound. This
    # mode exercises Nuclio's DLX path, which lets the Service wake a function
    # after its processor deployment has reached zero replicas.
    KIND_CANARY_AUTOSCALE=1
    CANARY_MIN_REPLICAS=0
    [ "$CANARY_MAX_REPLICAS" = "1" ] && CANARY_MAX_REPLICAS=3
    [ "$CANARY_CPU_BURN_MS" = "0" ] && CANARY_CPU_BURN_MS=20
fi

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
HPA_SAMPLE_PID=""
LOADGEN_POD=""

cleanup() {
    local exit_code=$?
    trap - EXIT INT TERM

    for pid in "$DASHBOARD_FORWARD_PID" "$FUNCTION_FORWARD_PID" "$NODE_RED_PID" "$HPA_SAMPLE_PID"; do
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
    done

    if [ -n "$LOADGEN_POD" ]; then
        kubectl delete pod "$LOADGEN_POD" -n "$NUCLIO_NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
    fi

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

if [ "$KIND_CANARY_AUTOSCALE" = "1" ]; then
    echo "Installing Kubernetes metrics-server $METRICS_SERVER_VERSION"
    kubectl apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/$METRICS_SERVER_VERSION/components.yaml" \
        >"$LOG_DIR/metrics-server.log" 2>&1
    kubectl patch deployment metrics-server -n kube-system --type='json' \
        -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"},{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-preferred-address-types=InternalIP,Hostname,ExternalIP"}]' \
        >>"$LOG_DIR/metrics-server.log" 2>&1
    kubectl rollout status deployment/metrics-server -n kube-system --timeout=5m \
        >>"$LOG_DIR/metrics-server.log" 2>&1
fi

echo "Installing Nuclio $NUCLIO_VERSION from Helm chart $NUCLIO_CHART_VERSION"
helm repo add nuclio https://nuclio.github.io/nuclio/charts --force-update >/dev/null
helm repo update >/dev/null
kubectl create namespace "$NUCLIO_NAMESPACE" >/dev/null
helm_args=(upgrade --install nuclio nuclio/nuclio \
    --version "$NUCLIO_CHART_VERSION" \
    --namespace "$NUCLIO_NAMESPACE" \
    --wait --timeout 10m \
    --set-string "controller.image.tag=$NUCLIO_VERSION-$NUCLIO_ARCH" \
    --set-string "dashboard.image.tag=$NUCLIO_VERSION-$NUCLIO_ARCH" \
    --set dashboard.containerBuilderKind=kaniko)
if [ "$KIND_CANARY_SCALE_TO_ZERO" = "1" ]; then
    helm_args+=(
        --set dlx.enabled=true
        --set-string "dlx.image.tag=$NUCLIO_VERSION-$NUCLIO_ARCH"
        --set platform.scaleToZero.mode=enabled
        --set platform.scaleToZero.scalerInterval=10s
        --set platform.scaleToZero.readinessPollInterval=1s
    )
fi
helm "${helm_args[@]}" >"$LOG_DIR/helm.log" 2>&1

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
import math
import os
import time


def handler(context, event):
    burn_ms = int(os.environ.get("NUCLIO_CANARY_CPU_BURN_MS", "0"))
    deadline = time.perf_counter() + (burn_ms / 1000)
    value = 0.0
    while time.perf_counter() < deadline:
        value = math.sqrt(value + 1.0)
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

canary_scaling_fields=""
if [ "$KIND_CANARY_AUTOSCALE" = "1" ]; then
    canary_scaling_fields='"scalingMode":"autoscaled","scalingMinReplicas":"'$CANARY_MIN_REPLICAS'","scalingMaxReplicas":"'$CANARY_MAX_REPLICAS'","scalingTargetCPU":"'$CANARY_TARGET_CPU'","scalingReplicas":"",'
fi

cat >"$NODE_RED_USER_DIR/flows.json" <<EOF_FLOWS
[
  {"id":"canary-tab","type":"tab","label":"KinD Canary","disabled":false,"info":""},
  {"id":"canary-server","type":"nuclio-config","address":"$dashboard_url","addressType":"str","namespace":"$NUCLIO_NAMESPACE","namespaceType":"str","publicAddress":"$dashboard_url","publicAddressType":"str","invocationUrlPreference":"service","internalInvocationServiceHost":"127.0.0.1:$FUNCTION_PORT","internalInvocationServiceHostType":"str","deploymentPolicy":"managed","requestTimeoutMs":"10000","deployTimeoutMs":"60000"},
  {"id":"canary-project","type":"nuclio-project","name":"$NUCLIO_PROJECT","nameType":"str"},
  {"id":"canary-function","type":"nuclio-function","server":"canary-server","project":"canary-project",$canary_scaling_fields"name":"$CANARY_FUNCTION_NAME","runtime":"python:3.12","sourceType":"image","codeEntryPath":"$CANARY_IMAGE","deploymentMode":"eager","maxSelfHealAttempts":"1","redeployDeadlineMs":"120000","autoRedeployOnError":"false","autoRedeployOnErrorType":"bool","configCode":"spec:\\n  imagePullPolicy: IfNotPresent\\n  env:\\n    - name: NUCLIO_CANARY_CPU_BURN_MS\\n      value: \"$CANARY_CPU_BURN_MS\"\\n"},
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
        scaledToZero)
            [ "$KIND_CANARY_SCALE_TO_ZERO" = "1" ] && break
            ;;
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
if [ "$KIND_CANARY_SCALE_TO_ZERO" != "1" ]; then
    kubectl port-forward -n "$NUCLIO_NAMESPACE" "service/nuclio-$CANARY_FUNCTION_NAME" "$FUNCTION_PORT:8080" \
        >"$LOG_DIR/function-port-forward.log" 2>&1 &
    FUNCTION_FORWARD_PID=$!
    sleep 2
fi

if [ "$KIND_CANARY_SCALE_TO_ZERO" != "1" ]; then
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
    echo "Canary function is available and invocation succeeded."
fi

if [ "$KIND_CANARY_SCALE_TO_ZERO" = "1" ]; then
    echo "Requesting the function's desired state to become scaledToZero"
    curl -fsS -X PATCH "$dashboard_url/api/functions/$CANARY_FUNCTION_NAME" \
        -H "x-nuclio-function-namespace: $NUCLIO_NAMESPACE" \
        -H "x-nuclio-project-name: $NUCLIO_PROJECT" \
        -H 'Content-Type: application/json' \
        --data '{"desiredState":"scaledToZero"}' \
        >"$LOG_DIR/scale-to-zero-patch.log"

    echo "Waiting for the function to reach zero replicas"
    state=""
    replicas=""
    for i in $(seq 1 90); do
        state="$(dashboard_get "/api/functions/$CANARY_FUNCTION_NAME" 2>/dev/null \
            | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status", {}).get("state", ""))' \
            2>/dev/null || true)"
        replicas="$(dashboard_get "/api/functions/$CANARY_FUNCTION_NAME/replicas" 2>/dev/null \
            | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("names") or []))' \
            2>/dev/null || true)"
        if [ "$state" = "scaledToZero" ] && [ "$replicas" = "0" ]; then break; fi
        if [ "$state" = "error" ] || [ "$state" = "unhealthy" ]; then
            echo "Scale-to-zero function entered state: $state" >&2
            kubectl get nucliofunction "$CANARY_FUNCTION_NAME" -n "$NUCLIO_NAMESPACE" -o yaml >&2 || true
            exit 1
        fi
        if [ "$i" = "90" ]; then
            echo "Timed out waiting for scale-to-zero; state=${state:-unknown}, replicas=${replicas:-unknown}" >&2
            kubectl get nucliofunction "$CANARY_FUNCTION_NAME" -n "$NUCLIO_NAMESPACE" -o yaml >&2 || true
            exit 1
        fi
        sleep 2
    done
    echo "Function reached scaledToZero with zero active replicas."

    echo "Forwarding the scaled-to-zero function Service through the DLX"
    kubectl port-forward -n "$NUCLIO_NAMESPACE" "service/nuclio-$CANARY_FUNCTION_NAME" "$FUNCTION_PORT:8080" \
        >"$LOG_DIR/function-port-forward.log" 2>&1 &
    FUNCTION_FORWARD_PID=$!
    sleep 2

    echo "Invoking through Node-RED to verify scale-from-zero"
    scale_from_zero_started="$(python3 -c 'import time; print(time.monotonic())')"
    response="$(curl -fsS --max-time 120 -X POST "$node_red_url/kind-canary" \
        -H 'Content-Type: application/json' \
        --data '{"hello":"scale-from-zero"}')"
    scale_from_zero_elapsed="$(python3 -c 'import sys,time; print(f"{time.monotonic() - float(sys.argv[1]):.3f}")' "$scale_from_zero_started")"
    printf '%s\n' "$response"
    printf '%s' "$response" | python3 -c '
import json, sys
value = json.load(sys.stdin)
assert value.get("ok") is True, value
assert value.get("echo") == {"hello": "scale-from-zero"}, value
'
    echo "Scale-from-zero invocation succeeded in ${scale_from_zero_elapsed}s."

    echo "Waiting for Nuclio to report the function ready again"
    for i in $(seq 1 90); do
        state="$(dashboard_get "/api/functions/$CANARY_FUNCTION_NAME" 2>/dev/null \
            | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status", {}).get("state", ""))' \
            2>/dev/null || true)"
        replicas="$(dashboard_get "/api/functions/$CANARY_FUNCTION_NAME/replicas" 2>/dev/null \
            | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("names") or []))' \
            2>/dev/null || true)"
        if [ "$state" = "ready" ] && [ "$replicas" -ge 1 ] 2>/dev/null; then break; fi
        if [ "$state" = "error" ] || [ "$state" = "unhealthy" ]; then
            echo "Scale-from-zero function entered state: $state" >&2
            kubectl get nucliofunction "$CANARY_FUNCTION_NAME" -n "$NUCLIO_NAMESPACE" -o yaml >&2 || true
            exit 1
        fi
        if [ "$i" = "90" ]; then
            echo "Timed out waiting for scale-from-zero readiness; state=${state:-unknown}, replicas=${replicas:-unknown}" >&2
            kubectl get nucliofunction "$CANARY_FUNCTION_NAME" -n "$NUCLIO_NAMESPACE" -o yaml >&2 || true
            exit 1
        fi
        sleep 2
    done
    echo "Scale-to-zero canary passed: scaled down, woke on invocation, and returned to ready."
fi

if [ "$KIND_CANARY_AUTOSCALE" = "1" ] && [ "$KIND_CANARY_SCALE_TO_ZERO" != "1" ]; then
    echo "Running phased autoscaling scenario"
    LOADGEN_POD="${CANARY_FUNCTION_NAME}-stress-loadgen"
    scenario_config_name="$(basename "$AUTOSCALE_SCENARIO_CONFIG")"
    echo "Starting in-cluster stress load generator: $LOADGEN_POD"
    kubectl run "$LOADGEN_POD" \
        -n "$NUCLIO_NAMESPACE" \
        --image=node:22-alpine \
        --restart=Never \
        --command -- sleep 1200 \
        >"$LOG_DIR/loadgen.log" 2>&1
    kubectl wait --for=condition=Ready "pod/$LOADGEN_POD" \
        -n "$NUCLIO_NAMESPACE" --timeout=120s \
        >>"$LOG_DIR/loadgen.log" 2>&1
    kubectl cp "$PROJECT_DIR/scripts" \
        "$NUCLIO_NAMESPACE/$LOADGEN_POD:/tmp/" \
        >>"$LOG_DIR/loadgen.log" 2>&1

    HPA_SAMPLE_FILE="$LOG_DIR/hpa-samples.tsv"
    hpa_name="nuclio-$CANARY_FUNCTION_NAME"
    (
        while true; do
            current="$(kubectl get hpa "$hpa_name" -n "$NUCLIO_NAMESPACE" -o jsonpath='{.status.currentReplicas}' 2>/dev/null || true)"
            desired="$(kubectl get hpa "$hpa_name" -n "$NUCLIO_NAMESPACE" -o jsonpath='{.status.desiredReplicas}' 2>/dev/null || true)"
            utilization="$(kubectl get hpa "$hpa_name" -n "$NUCLIO_NAMESPACE" -o jsonpath='{.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null || true)"
            if [ -n "$current" ]; then
                printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$current" "$desired" "$utilization"
            fi
            sleep 5
        done
    ) >"$HPA_SAMPLE_FILE" 2>/dev/null &
    HPA_SAMPLE_PID=$!
    scenario_exit=0
    scenario_args=(
        kubectl exec "$LOADGEN_POD" -n "$NUCLIO_NAMESPACE" --
        node /tmp/scripts/stress-scenario.js
        --config "/tmp/scripts/$scenario_config_name"
        --url "http://nuclio-$CANARY_FUNCTION_NAME.$NUCLIO_NAMESPACE.svc.cluster.local:8080"
        --dashboard "http://nuclio-dashboard.$NUCLIO_NAMESPACE.svc.cluster.local:8070"
        --function "$CANARY_FUNCTION_NAME"
        --namespace "$NUCLIO_NAMESPACE"
        --project "$NUCLIO_PROJECT"
        --concurrency "$AUTOSCALE_CONCURRENCY"
        --output /tmp/autoscale-scenario.json
    )
    if [ -n "$AUTOSCALE_PHASE_DURATION" ]; then
        scenario_args+=(--duration "$AUTOSCALE_PHASE_DURATION")
    fi
    "${scenario_args[@]}" || scenario_exit=$?
    kubectl cp "$NUCLIO_NAMESPACE/$LOADGEN_POD:/tmp/autoscale-scenario.json" \
        "$LOG_DIR/autoscale-scenario.json" \
        >>"$LOG_DIR/loadgen.log" 2>&1 || true
    kill "$HPA_SAMPLE_PID" 2>/dev/null || true
    wait "$HPA_SAMPLE_PID" 2>/dev/null || true
    HPA_SAMPLE_PID=""
    if [ "$scenario_exit" != "0" ]; then
        exit "$scenario_exit"
    fi
    echo "Autoscaling scenario result: $LOG_DIR/autoscale-scenario.json"
    python3 - "$LOG_DIR/autoscale-scenario.json" <<'PY_AUTOSCALE_SUMMARY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    result = json.load(stream)
samples = [sample for phase in result.get("phases", []) for sample in phase.get("samples", [])]
replicas = [sample["replicas"] for sample in samples if isinstance(sample.get("replicas"), int)]
if replicas:
    print(f"Observed replica range: {min(replicas)}-{max(replicas)} across {len(replicas)} status samples")
else:
    print("Observed replica range: unavailable")
PY_AUTOSCALE_SUMMARY
    python3 - "$HPA_SAMPLE_FILE" <<'PY_HPA_SUMMARY'
import sys

rows = []
with open(sys.argv[1], encoding="utf-8") as stream:
    for line in stream:
        parts = line.rstrip().split("\t")
        if len(parts) >= 3:
            rows.append(parts)
if rows:
    current = [int(row[1]) for row in rows]
    desired = [int(row[2]) for row in rows if row[2].isdigit()]
    print(f"HPA replica range: {min(current)}-{max(current)} current across {len(rows)} samples")
    if desired:
        print(f"HPA desired replica range: {min(desired)}-{max(desired)}")
else:
    print("HPA replica range: unavailable")
PY_HPA_SUMMARY
    echo "HPA samples: $HPA_SAMPLE_FILE"
    kubectl get hpa -n "$NUCLIO_NAMESPACE" -o wide || true
    kubectl top pods -n "$NUCLIO_NAMESPACE" 2>/dev/null || true
fi
