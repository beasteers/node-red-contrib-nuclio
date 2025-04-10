# Deploy Nuclio Functions with Node-Red.

Deploy Nuclio Functions directly from a Node-Red script. These are essentially Python or Go HTTP endpoints that nodered calls.

The "nuclio" node acts essentially like a function node, giving you a code editor. Once the node is deployed, it will deploy the function to nuclio and act as an HTTP request node, making requests to the nuclio function.

> NOTE: This node is specifically intended for the `sourceCode` [code entry type](https://docs.nuclio.io/en/latest/reference/function-configuration/code-entry-types.html) and the default [HTTP trigger](https://docs.nuclio.io/en/latest/reference/triggers/http.html), though there isn't anything stopping you from customizing the function config to get the desired functionality (e.g. setting `spec.image` or `build.codeEntryType=archive, build.path=<URL>`). 

## Install

> This is a prototype - I look forward to hearing your experience, feedback, and ideas for improvements.

```bash
npm i node-red-contrib-nuclio
```

In order to use this node, you must have the Nuclio dashboard running. It doesn't need to be public, it just needs to be accessible by Node-Red.

Using the docker-compose test install below will give you a fully functioning system to experiment with.

## Test Install
To test/develop
```bash
docker-compose up -d --build
```
You can access: 
 * Node-Red dashboard [here](http://localhost:1881). 
 * The Nuclio dashboard can be found [here](http://localhost:8070).
