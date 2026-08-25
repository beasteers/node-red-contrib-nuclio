# Kubernetes HTTP reference

This is the smallest Kubernetes example for the Node-RED Nuclio node. Nuclio
is installed with Helm; Kustomize deploys Node-RED and mounts the example flow
and settings as ConfigMaps.

The example assumes the Nuclio platform is already installed in the `nuclio`
namespace and configured to build source functions on the cluster. Nuclio's
Kubernetes installation and registry requirements are documented in the
[Nuclio Kubernetes guide](https://docs.nuclio.io/en/latest/setup/k8s/running-in-production-k8s.html).

Build the repository's current Node-RED image, then make it available to the
cluster. With KinD, for example:

```bash
docker build -t nodered-nuclio-reference:local .
kind load docker-image nodered-nuclio-reference:local
```

For another Kubernetes cluster, push the image to a registry and replace the
image in `deployment.yaml` or add a Kustomize overlay.

Apply the reference deployment:

```bash
kubectl apply -k examples/http/k8s
kubectl port-forward service/node-red-http 1880:1880
```

Open [Node-RED](http://localhost:1880), deploy the **Kubernetes HTTP example**
flow, and click **Invoke HTTP example**. The response appears in the debug
sidebar.

Remove it with:

```bash
kubectl delete -k examples/http/k8s
```

This example intentionally does not install Nuclio, create a KinD cluster, or
run stress and autoscaling scenarios. Those responsibilities belong to the
Helm installation and the maintainer-only [`hack/kind`](../../../hack/kind/)
canary.
