# Runnable examples

These are repository-local demonstrations of the Node-RED/Nuclio message paths.
Each Compose scenario is independent and should be run one at a time because
the default host ports are shared.

The launcher detects `amd64` and `arm64` hosts and selects the matching Nuclio
dashboard image. Override `NUCLIO_ARCH` when cross-building.

## HTTP request/reply with Compose

The smallest example: Node-RED invokes a Python function over Nuclio's HTTP
endpoint and displays success and error paths.

```bash
bash examples/run-compose.sh http up -d
```

Open [Node-RED](http://localhost:1882), deploy the flow, and click **Invoke HTTP
example**. Stop it with `bash examples/run-compose.sh http down`.

### Kubernetes reference

The same HTTP path has a minimal Kubernetes reference under
[`http/k8s`](http/k8s/). It uses Helm for the Nuclio platform and Kustomize for
the Node-RED Deployment, Service, ConfigMaps, and example flow:

```bash
kubectl apply -k examples/http/k8s
kubectl port-forward service/node-red-http 1880:1880
```

See [`http/k8s/README.md`](http/k8s/README.md) for the image and Nuclio
prerequisites. This is intentionally separate from the disposable
[`hack/kind`](../hack/kind/) canary.

## Cron trigger

Nuclio owns a 30-second schedule. Node-RED owns the function declaration and
status view but does not send each invocation.

```bash
bash examples/run-compose.sh cron up -d
```

Open the function Status tab and refresh **Run logs**. Stop it with
`bash examples/run-compose.sh cron down`.

## Batching

Node-RED emits four messages. Nuclio's HTTP trigger waits for four messages or
one second, then invokes the function once with the batch.

```bash
bash examples/run-compose.sh batching up -d
```

Deploy the flow and click **Send four messages**. Stop it with
`bash examples/run-compose.sh batching down`.

## Direct MQTT trigger

This example runs Mosquitto and a native Nuclio MQTT trigger. Node-RED publishes
the input and observes the transformed output directly through MQTT; the
message does not pass through a Nuclio Invoke node.

```bash
bash examples/run-compose.sh mqtt up -d
```

Deploy the flow and click **Publish MQTT example event**. Stop it with
`bash examples/run-compose.sh mqtt down`.

## Native NATS request/reply

Nuclio consumes a native NATS request and returns the handler result on the NATS
reply subject. The example intentionally has no Node-RED message path.

```bash
bash examples/run-compose.sh nats-request up -d
docker run --rm --network nuclio-nats-request-example_default natsio/nats-box:latest \
  nats request -s nats://nats:4222 example.nats.input '{"message":"hello"}'
```

Stop it with `bash examples/run-compose.sh nats-request down`.

## NATS MQTT bridge

Node-RED publishes through NATS's MQTT listener. The Nuclio NATS trigger
consumes the native subject, publishes a transformed result natively, and NATS
delivers that result back to Node-RED over MQTT.

```bash
bash examples/run-compose.sh nats-mqtt up -d
```

Deploy the flow and click **Publish NATS MQTT example event**. Stop it with
`bash examples/run-compose.sh nats-mqtt down`.

To run a focused example beside another stack, override its published ports:

```bash
NODE_RED_PORT=3882 NUCLIO_PORT=3872 bash examples/run-compose.sh http up -d
```

The Compose examples use local, unauthenticated dashboards and are intended for
development and demonstration only. MQTT and NATS triggers are Nuclio
tech-preview features in the referenced Nuclio release.

The disposable Kubernetes canary is maintainer tooling, not a user example. See
[`hack/kind/README.md`](../hack/kind/README.md).
