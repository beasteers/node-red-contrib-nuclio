#!/usr/bin/env bash
set -Eeuo pipefail

# The KinD canary is deliberately staged:
#
#   hack/kind/run.sh up [scenario]
#   hack/kind/run.sh test-scenario [scenario]
#   hack/kind/run.sh down
#
# With no command it retains the historical one-shot behavior. Keeping the
# stages separate makes the cluster, logs, and Node-RED fixture useful while
# debugging a failed scenario.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/fixture"
SCENARIO_DIR="$SCRIPT_DIR/scenarios"

KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-nuclio-node-red-canary}"
NUCLIO_NAMESPACE="${NUCLIO_NAMESPACE:-nuclio}"
NUCLIO_PROJECT="${NUCLIO_PROJECT:-node-red-canary}"
NUCLIO_VERSION="${NUCLIO_VERSION:-1.17.3}"
NUCLIO_CHART_VERSION="${NUCLIO_CHART_VERSION:-0.23.3}"
CANARY_IMAGE="${CANARY_IMAGE:-node-red-nuclio-kind-canary:latest}"
CANARY_FUNCTION_NAME="node-red-kind-canary"
CANARY_FUNCTION_SERVICE="nuclio-$CANARY_FUNCTION_NAME"
CANARY_LOADGEN_POD="$CANARY_FUNCTION_NAME-stress-loadgen"
CANARY_HPA_NAME="$CANARY_FUNCTION_SERVICE"
CANARY_PATH="/kind-canary"
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
AUTOSCALE_SCENARIO_CONFIG="${AUTOSCALE_SCENARIO_CONFIG:-$SCENARIO_DIR/autoscale.json}"

DASHBOARD_PORT="${DASHBOARD_PORT:-18070}"
NODE_RED_PORT="${NODE_RED_PORT:-18880}"
FUNCTION_PORT="${FUNCTION_PORT:-18080}"
STATE_DIR="${KIND_CANARY_STATE_DIR:-${TMPDIR:-/tmp}/nuclio-kind-canary-$KIND_CLUSTER_NAME}"
STATE_FILE="$STATE_DIR/state.env"
PID_DIR="$STATE_DIR/pids"
LOG_DIR="$STATE_DIR/logs"
NODE_RED_USER_DIR="$STATE_DIR/node-red"

KIND_CANARY_ARCH_INPUT="${NUCLIO_ARCH:-$(uname -m)}"
case "$KIND_CANARY_ARCH_INPUT" in
    x86_64|amd64) NUCLIO_ARCH=amd64 ;;
    arm64|aarch64) NUCLIO_ARCH=arm64 ;;
    *) echo "Unsupported host architecture: $KIND_CANARY_ARCH_INPUT" >&2; exit 2 ;;
esac
export NUCLIO_ARCH

usage() {
    cat >&2 <<'EOF_USAGE'
Usage:
  hack/kind/run.sh up [basic|autoscale|scale-to-zero]
  hack/kind/run.sh test-scenario [basic|autoscale|scale-to-zero]
  hack/kind/run.sh down

No command runs the basic scenario and then tears the fixture down, preserving
the historical `npm run test:kind` behavior. Set KIND_CANARY_KEEP_CLUSTER=1
when using the one-shot form to retain the cluster and state directory.
EOF_USAGE
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "Missing required command: $1" >&2
        exit 2
    }
}

preflight_up() {
    for command in docker kind kubectl helm curl python3 node; do
        require_command "$command"
    done
    if [ ! -f "$PROJECT_DIR/node_modules/node-red/red.js" ]; then
        echo "Node-RED is not installed. Run npm ci before starting the canary." >&2
        exit 2
    fi
    for file in "$FIXTURE_DIR/Dockerfile" "$FIXTURE_DIR/main.py" "$FIXTURE_DIR/settings.js" "$FIXTURE_DIR/flows.json"; do
        [ -f "$file" ] || { echo "Missing KinD fixture asset: $file" >&2; exit 2; }
    done
}

preflight_test() {
    for command in kubectl curl python3; do
        require_command "$command"
    done
}

preflight_down() {
    require_command kind
    require_command kubectl
}

set_urls() {
    dashboard_url="http://127.0.0.1:$DASHBOARD_PORT"
    node_red_url="http://127.0.0.1:$NODE_RED_PORT"
    kube_context="kind-$KIND_CLUSTER_NAME"
}

scenario_from_environment() {
    if [ "$KIND_CANARY_SCALE_TO_ZERO" = "1" ]; then
        printf '%s\n' scale-to-zero
    elif [ "$KIND_CANARY_AUTOSCALE" = "1" ]; then
        printf '%s\n' autoscale
    else
        printf '%s\n' basic
    fi
}

configure_scenario() {
    local scenario="$1"
    case "$scenario" in
        basic)
            KIND_CANARY_AUTOSCALE=0
            KIND_CANARY_SCALE_TO_ZERO=0
            CANARY_MIN_REPLICAS=1
            CANARY_MAX_REPLICAS=1
            CANARY_TARGET_CPU=""
            CANARY_CPU_BURN_MS=0
            ;;
        autoscale)
            KIND_CANARY_AUTOSCALE=1
            KIND_CANARY_SCALE_TO_ZERO=0
            [ "$CANARY_MAX_REPLICAS" = "1" ] && CANARY_MAX_REPLICAS=3
            [ -z "$CANARY_TARGET_CPU" ] && CANARY_TARGET_CPU=50
            [ "$CANARY_CPU_BURN_MS" = "0" ] && CANARY_CPU_BURN_MS=20
            ;;
        scale-to-zero)
            KIND_CANARY_AUTOSCALE=1
            KIND_CANARY_SCALE_TO_ZERO=1
            CANARY_MIN_REPLICAS=0
            [ "$CANARY_MAX_REPLICAS" = "1" ] && CANARY_MAX_REPLICAS=3
            [ -z "$CANARY_TARGET_CPU" ] && CANARY_TARGET_CPU=50
            [ "$CANARY_CPU_BURN_MS" = "0" ] && CANARY_CPU_BURN_MS=20
            ;;
        *) echo "Unknown KinD scenario: $scenario" >&2; usage; exit 2 ;;
    esac
    SCENARIO="$scenario"
}

write_state_var() {
    local name="$1"
    printf '%s=%q\n' "$name" "${!name}"
}

write_state() {
    mkdir -p "$PID_DIR" "$LOG_DIR"
    {
        for name in KIND_CLUSTER_NAME NUCLIO_NAMESPACE NUCLIO_PROJECT NUCLIO_VERSION NUCLIO_CHART_VERSION CANARY_IMAGE \
            KIND_CANARY_KEEP_CLUSTER KIND_CANARY_AUTOSCALE KIND_CANARY_SCALE_TO_ZERO CANARY_MIN_REPLICAS \
            CANARY_MAX_REPLICAS CANARY_TARGET_CPU CANARY_CPU_BURN_MS METRICS_SERVER_VERSION AUTOSCALE_PHASE_DURATION \
            AUTOSCALE_CONCURRENCY AUTOSCALE_SCENARIO_CONFIG DASHBOARD_PORT NODE_RED_PORT FUNCTION_PORT NUCLIO_ARCH SCENARIO; do
            write_state_var "$name"
        done
    } >"$STATE_FILE"
}

load_state() {
    [ -f "$STATE_FILE" ] || {
        echo "KinD fixture is not up. Run: hack/kind/run.sh up [scenario]" >&2
        exit 2
    }
    # state.env is generated with printf %q by this script, not supplied by a
    # user. Sourcing it preserves arbitrary configured paths and ports safely.
    # shellcheck disable=SC1090
    source "$STATE_FILE"
    set_urls
    LOG_DIR="$STATE_DIR/logs"
    PID_DIR="$STATE_DIR/pids"
    NODE_RED_USER_DIR="$STATE_DIR/node-red"
}

kube() {
    kubectl --context "$kube_context" "$@"
}

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

save_pid() {
    printf '%s\n' "$2" >"$PID_DIR/$1.pid"
}

kill_pid() {
    local name="$1"
    local pid_file="$PID_DIR/$name.pid"
    [ -f "$pid_file" ] || return 0
    local pid
    pid="$(cat "$pid_file")"
    kill "$pid" 2>/dev/null || true
    rm -f "$pid_file"
}

delete_loadgen() {
    local pod="$CANARY_LOADGEN_POD"
    kube delete pod "$pod" -n "$NUCLIO_NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
}

stop_processes() {
    kill_pid hpa-sampler
    kill_pid function-port-forward
    kill_pid dashboard-port-forward
    kill_pid node-red
}

down_fixture() {
    preflight_down
    if [ ! -f "$STATE_FILE" ]; then
        echo "KinD fixture state not found: $STATE_DIR" >&2
        return 0
    fi
    # Retention is a command-level choice for `down`: a cluster kept by `up`
    # for inspection should still be removable with a plain `down`.
    local retain_cluster="$KIND_CANARY_KEEP_CLUSTER"
    load_state
    KIND_CANARY_KEEP_CLUSTER="$retain_cluster"
    stop_processes
    delete_loadgen
    if [ "$KIND_CANARY_KEEP_CLUSTER" != "1" ]; then
        kind delete cluster --name "$KIND_CLUSTER_NAME" >/dev/null 2>&1 || true
        rm -rf "$STATE_DIR"
        echo "KinD fixture stopped and cluster removed."
    else
        echo "KinD fixture stopped; cluster and state retained."
        echo "State directory: $STATE_DIR"
    fi
}

install_cluster_dependencies() {
    if [ "$KIND_CANARY_AUTOSCALE" = "1" ]; then
        echo "Installing Kubernetes metrics-server $METRICS_SERVER_VERSION"
        kube apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/$METRICS_SERVER_VERSION/components.yaml" \
            >"$LOG_DIR/metrics-server.log" 2>&1
        kube patch deployment metrics-server -n kube-system --type='json' \
            -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"},{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-preferred-address-types=InternalIP,Hostname,ExternalIP"}]' \
            >>"$LOG_DIR/metrics-server.log" 2>&1
        kube rollout status deployment/metrics-server -n kube-system --timeout=5m \
            >>"$LOG_DIR/metrics-server.log" 2>&1
    fi

    echo "Installing Nuclio $NUCLIO_VERSION from Helm chart $NUCLIO_CHART_VERSION"
    helm repo add nuclio https://nuclio.github.io/nuclio/charts --force-update >/dev/null
    helm repo update >/dev/null
    kube create namespace "$NUCLIO_NAMESPACE" --dry-run=client -o yaml | kube apply -f - >/dev/null
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
    kube rollout status deployment/nuclio-controller -n "$NUCLIO_NAMESPACE" --timeout=5m
    kube rollout status deployment/nuclio-dashboard -n "$NUCLIO_NAMESPACE" --timeout=5m
}

build_and_load_image() {
    echo "Building and loading canary function image: $CANARY_IMAGE"
    docker build --pull --platform "linux/$NUCLIO_ARCH" \
        --build-arg "NUCLIO_VERSION=$NUCLIO_VERSION" \
        --build-arg "NUCLIO_ARCH=$NUCLIO_ARCH" \
        --tag "$CANARY_IMAGE" "$FIXTURE_DIR" \
        >"$LOG_DIR/docker-build.log" 2>&1
    kind load docker-image "$CANARY_IMAGE" --name "$KIND_CLUSTER_NAME" \
        >"$LOG_DIR/kind-load.log" 2>&1
}

start_dashboard_forward() {
    echo "Forwarding the Nuclio dashboard"
    kube port-forward -n "$NUCLIO_NAMESPACE" service/nuclio-dashboard "$DASHBOARD_PORT:8070" \
        >"$LOG_DIR/dashboard-port-forward.log" 2>&1 &
    save_pid dashboard-port-forward "$!"
    wait_for_http "$dashboard_url/api/functions"
}

start_node_red() {
    mkdir -p "$NODE_RED_USER_DIR/node_modules/@bea.steers"
    ln -sfn "$PROJECT_DIR" "$NODE_RED_USER_DIR/node_modules/@bea.steers/node-red-contrib-nuclio"
    cp "$FIXTURE_DIR/settings.js" "$NODE_RED_USER_DIR/settings.js"
    cp "$FIXTURE_DIR/flows.json" "$NODE_RED_USER_DIR/flows.json"

    export NODE_RED_PORT
    export NUCLIO_DASHBOARD_URL="$dashboard_url"
    export NUCLIO_NAMESPACE NUCLIO_PROJECT
    export NUCLIO_FUNCTION_HOST="127.0.0.1:$FUNCTION_PORT"
    export CANARY_IMAGE CANARY_MIN_REPLICAS CANARY_MAX_REPLICAS CANARY_TARGET_CPU CANARY_CPU_BURN_MS

    echo "Starting Node-RED with the working-tree package"
    node "$PROJECT_DIR/node_modules/node-red/red.js" --userDir "$NODE_RED_USER_DIR" --port "$NODE_RED_PORT" \
        >"$LOG_DIR/node-red.log" 2>&1 &
    save_pid node-red "$!"
    wait_for_http "$node_red_url"
}

wait_for_function_ready() {
    echo "Waiting for the canary function to become ready"
    local state=""
    local i
    for i in $(seq 1 120); do
        state="$(dashboard_get "/api/functions/$CANARY_FUNCTION_NAME" 2>/dev/null \
            | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status", {}).get("state", ""))' \
            2>/dev/null || true)"
        case "$state" in
            ready) return 0 ;;
            error|unhealthy)
                echo "Canary function entered state: $state" >&2
                kube get nucliofunction "$CANARY_FUNCTION_NAME" -n "$NUCLIO_NAMESPACE" -o yaml >&2 || true
                return 1
                ;;
        esac
        if [ "$i" = "120" ]; then
            echo "Timed out waiting for function; last state: ${state:-unknown}" >&2
            kube get nucliofunction "$CANARY_FUNCTION_NAME" -n "$NUCLIO_NAMESPACE" -o yaml >&2 || true
            return 1
        fi
        sleep 2
    done
}

up_fixture() {
    local scenario="${1:-$(scenario_from_environment)}"
    preflight_up
    set_urls
    configure_scenario "$scenario"
    if [ -f "$STATE_FILE" ]; then
        echo "KinD fixture is already up: $STATE_DIR" >&2
        exit 2
    fi
    if kind get clusters 2>/dev/null | grep -Fxq "$KIND_CLUSTER_NAME"; then
        echo "KinD cluster already exists: $KIND_CLUSTER_NAME; run down or choose another KIND_CLUSTER_NAME" >&2
        exit 2
    fi

    mkdir -p "$PID_DIR" "$LOG_DIR"
    write_state
    kind_args=(create cluster --name "$KIND_CLUSTER_NAME")
    if [ -n "${KIND_NODE_IMAGE:-}" ]; then kind_args+=(--image "$KIND_NODE_IMAGE"); fi
    echo "Creating KinD cluster: $KIND_CLUSTER_NAME"
    kind "${kind_args[@]}" >"$LOG_DIR/kind.log" 2>&1
    kube config use-context "$kube_context" >/dev/null

    install_cluster_dependencies
    build_and_load_image
    start_dashboard_forward
    start_node_red
    wait_for_function_ready
    echo "KinD fixture is up for scenario: $SCENARIO"
    echo "State directory: $STATE_DIR"
}

start_function_forward() {
    if [ -f "$PID_DIR/function-port-forward.pid" ]; then return 0; fi
    echo "Forwarding the canary function service"
    kube port-forward -n "$NUCLIO_NAMESPACE" "service/$CANARY_FUNCTION_SERVICE" "$FUNCTION_PORT:8080" \
        >"$LOG_DIR/function-port-forward.log" 2>&1 &
    save_pid function-port-forward "$!"
    sleep 2
}

invoke_and_assert() {
    local message="$1"
    local expected="$2"
    local response
    response="$(curl -fsS --max-time 120 -X POST "$node_red_url$CANARY_PATH" \
        -H 'Content-Type: application/json' --data "{\"hello\":\"$message\"}")"
    printf '%s\n' "$response"
    printf '%s' "$response" | python3 -c 'import json,sys; value=json.load(sys.stdin); assert value.get("ok") is True, value; assert value.get("echo") == {"hello": sys.argv[1]}, value' "$expected"
}

wait_for_scale_state() {
    local expected_state="$1"
    local expected_replicas="$2"
    local timeout="${3:-90}"
    local state=""
    local replicas=""
    local i
    for i in $(seq 1 "$timeout"); do
        state="$(dashboard_get "/api/functions/$CANARY_FUNCTION_NAME" 2>/dev/null \
            | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status", {}).get("state", ""))' 2>/dev/null || true)"
        replicas="$(dashboard_get "/api/functions/$CANARY_FUNCTION_NAME/replicas" 2>/dev/null \
            | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("names") or []))' 2>/dev/null || true)"
        if [ "$state" = "$expected_state" ] && [ "$replicas" = "$expected_replicas" ]; then return 0; fi
        if [ "$state" = "error" ] || [ "$state" = "unhealthy" ]; then
            echo "Function entered state: $state" >&2
            kube get nucliofunction "$CANARY_FUNCTION_NAME" -n "$NUCLIO_NAMESPACE" -o yaml >&2 || true
            return 1
        fi
        if [ "$i" = "$timeout" ]; then
            echo "Timed out waiting for state=$expected_state replicas=$expected_replicas; state=${state:-unknown}, replicas=${replicas:-unknown}" >&2
            kube get nucliofunction "$CANARY_FUNCTION_NAME" -n "$NUCLIO_NAMESPACE" -o yaml >&2 || true
            return 1
        fi
        sleep 2
    done
}

# Scenario implementations live beside their scenario JSON so this runner
# owns lifecycle and shared helpers while each scenario owns its assertions.
# shellcheck source=hack/kind/scenarios/basic.sh
source "$SCENARIO_DIR/basic.sh"
# shellcheck source=hack/kind/scenarios/scale-to-zero.sh
source "$SCENARIO_DIR/scale-to-zero.sh"
# shellcheck source=hack/kind/scenarios/autoscale.sh
source "$SCENARIO_DIR/autoscale.sh"

test_scenario() {
    local requested="${1:-}"
    preflight_test
    load_state
    if [ -n "$requested" ] && [ "$requested" != "$SCENARIO" ]; then
        echo "Fixture was started for scenario $SCENARIO, not $requested; run up $requested first." >&2
        exit 2
    fi
    case "$SCENARIO" in
        basic) run_basic_scenario ;;
        autoscale) run_autoscale_scenario ;;
        scale-to-zero) run_scale_to_zero_scenario ;;
        *) echo "Unknown stored scenario: $SCENARIO" >&2; exit 2 ;;
    esac
}

one_shot() {
    local scenario
    scenario="$(scenario_from_environment)"
    if ! up_fixture "$scenario"; then
        down_fixture || true
        return 1
    fi
    local result=0
    test_scenario "$scenario" || result=$?
    down_fixture || true
    return "$result"
}

set_urls
case "${1:-}" in
    '') one_shot ;;
    up)
        shift
        up_fixture "${1:-$(scenario_from_environment)}"
        ;;
    test-scenario|test)
        shift
        test_scenario "${1:-}"
        ;;
    down)
        down_fixture
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        usage
        exit 2
        ;;
esac
