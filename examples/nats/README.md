# Native NATS Suite example

This example installs [node-red-contrib-nats-suite](https://flows.nodered.org/node/node-red-contrib-nats-suite) in the example image and demonstrates common native NATS pipelines with visible Nuclio worker nodes:

- Core pub/sub with a Nuclio worker and queue group
- Native request/reply with a Nuclio worker
- JetStream persistence, consumers, acknowledgements, and a Nuclio stream worker
- KV-backed configuration and change watching, with a Nuclio KV reader

Start it with:

```bash
bash examples/run-compose.sh nats up -d
```

Open [Node-RED](http://localhost:1882), deploy the flow, and use the inject buttons. The `nuclio` nodes are visible deployment/control markers for the workers; their NATS triggers are intentionally not represented as Node-RED wires.

The Core NATS tab demonstrates `Node-RED → NATS → Nuclio → NATS → Node-RED`. The JetStream tab uses the same pattern with a durable `EVENTS` stream: create the stream and consumer, publish an event, then consume the Nuclio-produced output. On the KV tab, put `config.timeout` first, then choose `Read through Nuclio`; the worker reads the same NATS KV bucket and returns the value over NATS request/reply. `Get config.timeout` and `Watch config.*` show the native Node-RED KV operations.

Stop it with:

```bash
bash examples/run-compose.sh nats down
```

The stack is intentionally local and unauthenticated. It is a learning example, not a production NATS configuration. The separate [nats-mqtt](../nats-mqtt/) example demonstrates using Node-RED's built-in MQTT nodes as an adapter to NATS.
