run_basic_scenario() {
    start_function_forward
    echo "Invoking through the Node-RED nuclio node"
    invoke_and_assert basic basic
    echo "Basic canary passed."
}
