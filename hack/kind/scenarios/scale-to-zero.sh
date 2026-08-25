run_scale_to_zero_scenario() {
    echo "Requesting the function's desired state to become scaledToZero"
    curl -fsS -X PATCH "$dashboard_url/api/functions/$CANARY_FUNCTION_NAME" \
        -H "x-nuclio-function-namespace: $NUCLIO_NAMESPACE" \
        -H "x-nuclio-project-name: $NUCLIO_PROJECT" \
        -H 'Content-Type: application/json' --data '{"desiredState":"scaledToZero"}' \
        >"$LOG_DIR/scale-to-zero-patch.log"
    wait_for_scale_state scaledToZero 0
    echo "Function reached scaledToZero with zero active replicas."
    start_function_forward
    echo "Invoking through Node-RED to verify scale-from-zero"
    local started
    started="$(python3 -c 'import time; print(time.monotonic())')"
    invoke_and_assert scale-from-zero scale-from-zero
    local elapsed
    elapsed="$(python3 -c 'import sys,time; print(f"{time.monotonic() - float(sys.argv[1]):.3f}")' "$started")"
    echo "Scale-from-zero invocation succeeded in ${elapsed}s."
    wait_for_scale_state ready 1
    echo "Scale-to-zero canary passed: scaled down, woke on invocation, and returned to ready."
}
