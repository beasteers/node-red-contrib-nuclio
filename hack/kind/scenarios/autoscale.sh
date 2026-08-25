run_autoscale_scenario() {
    local loadgen_pod="$CANARY_LOADGEN_POD"
    local scenario_config_name
    scenario_config_name="$(basename "$AUTOSCALE_SCENARIO_CONFIG")"
    echo "Starting in-cluster stress load generator: $loadgen_pod"
    kube run "$loadgen_pod" -n "$NUCLIO_NAMESPACE" --image=node:22-alpine --restart=Never --command -- sleep 1200 \
        >"$LOG_DIR/loadgen.log" 2>&1
    kube wait --for=condition=Ready "pod/$loadgen_pod" -n "$NUCLIO_NAMESPACE" --timeout=120s \
        >>"$LOG_DIR/loadgen.log" 2>&1
    kube cp "$PROJECT_DIR/scripts/stress-scenario.js" "$NUCLIO_NAMESPACE/$loadgen_pod:/tmp/stress-scenario.js" \
        >>"$LOG_DIR/loadgen.log" 2>&1
    kube cp "$AUTOSCALE_SCENARIO_CONFIG" "$NUCLIO_NAMESPACE/$loadgen_pod:/tmp/$scenario_config_name" \
        >>"$LOG_DIR/loadgen.log" 2>&1

    local hpa_sample_file="$LOG_DIR/hpa-samples.tsv"
    local hpa_name="$CANARY_HPA_NAME"
    (
        while true; do
            current="$(kube get hpa "$hpa_name" -n "$NUCLIO_NAMESPACE" -o jsonpath='{.status.currentReplicas}' 2>/dev/null || true)"
            desired="$(kube get hpa "$hpa_name" -n "$NUCLIO_NAMESPACE" -o jsonpath='{.status.desiredReplicas}' 2>/dev/null || true)"
            utilization="$(kube get hpa "$hpa_name" -n "$NUCLIO_NAMESPACE" -o jsonpath='{.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null || true)"
            if [ -n "$current" ]; then
                printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$current" "$desired" "$utilization"
            fi
            sleep 5
        done
    ) >"$hpa_sample_file" 2>/dev/null &
    save_pid hpa-sampler "$!"

    local scenario_exit=0
    local scenario_args=(
        kube exec "$loadgen_pod" -n "$NUCLIO_NAMESPACE" --
        node /tmp/stress-scenario.js
        --config "/tmp/$scenario_config_name"
        --url "http://$CANARY_FUNCTION_SERVICE.$NUCLIO_NAMESPACE.svc.cluster.local:8080"
        --dashboard "http://nuclio-dashboard.$NUCLIO_NAMESPACE.svc.cluster.local:8070"
        --function "$CANARY_FUNCTION_NAME"
        --namespace "$NUCLIO_NAMESPACE"
        --project "$NUCLIO_PROJECT"
        --concurrency "$AUTOSCALE_CONCURRENCY"
        --output /tmp/autoscale-scenario.json
    )
    if [ -n "$AUTOSCALE_PHASE_DURATION" ]; then scenario_args+=(--duration "$AUTOSCALE_PHASE_DURATION"); fi
    "${scenario_args[@]}" || scenario_exit=$?
    kube cp "$NUCLIO_NAMESPACE/$loadgen_pod:/tmp/autoscale-scenario.json" "$LOG_DIR/autoscale-scenario.json" \
        >>"$LOG_DIR/loadgen.log" 2>&1 || true
    kill_pid hpa-sampler
    kube delete pod "$loadgen_pod" -n "$NUCLIO_NAMESPACE" --ignore-not-found >>"$LOG_DIR/loadgen.log" 2>&1 || true
    if [ "$scenario_exit" != "0" ]; then return "$scenario_exit"; fi

    python3 - "$LOG_DIR/autoscale-scenario.json" <<'PY_AUTOSCALE_SUMMARY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    result = json.load(stream)
samples = [sample for phase in result.get("phases", []) for sample in phase.get("samples", [])]
replicas = [sample["replicas"] for sample in samples if isinstance(sample.get("replicas"), int)]
print(f"Observed replica range: {min(replicas)}-{max(replicas)} across {len(replicas)} status samples" if replicas else "Observed replica range: unavailable")
PY_AUTOSCALE_SUMMARY
    python3 - "$hpa_sample_file" <<'PY_HPA_SUMMARY'
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
    echo "HPA samples: $hpa_sample_file"
    kube get hpa -n "$NUCLIO_NAMESPACE" -o wide || true
    kube top pods -n "$NUCLIO_NAMESPACE" 2>/dev/null || true
}
