(function(root, factory) {
    const samples = factory();
    if (typeof module === 'object' && module.exports) module.exports = samples;
    if (root) root.NUCLIO_FUNCTION_SAMPLES = samples;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
    const configCode = `
apiVersion: "nuclio.io/v1"
kind: NuclioFunction
metadata:
  labels: {}
  annotations: {}
spec:
  build:
    commands: []
    # - pip install requests numpy pandas

  # # add multiple workers:
  # triggers:
  #   mh:
  #     kind: http
  #     numWorkers: 4
      
  #############
  # Kubernetes:
  
  # env: []
  # envFrom: []
  # volumes: []

  # # Pod replica auto-scaling:
  # minReplicas: 1
  # maxReplicas: 1
  # resources: {}
  #   # Kubernetes Limits & Requests for the function's CPU and memory usage.
  #   requests:
  #     cpu: 1
  #     memory: 128M
  #   limits:
  #     cpu: 2
  #     memory: 256M
  #     nvidia.com/gpu: 1
    `.trim();

    const samples = {
        python: {
            config: configCode,
            entrypoint: 'handler',
            code: `
import nuclio_sdk

async def handler(context: nuclio_sdk.Context, event: nuclio_sdk.Event):
    # reverse the input, return JSON
    return {
        "some-output": event.body[::-1],
        "hi": "Hello, from Nuclio :]",
    }
    `.trim()
        },
        golang: {
            config: configCode,
            entrypoint: 'Handler',
            code: `
package main

import (
	"github.com/nuclio/nuclio-sdk-go"
)

func Handler(context *nuclio.Context, event nuclio.Event) (interface{}, error) {
	context.Logger.Info("This is an unstructured %s", "log")

	return nuclio.Response{
		StatusCode:  200,
		ContentType: "application/text",
		Body:        []byte("Hello, from Nuclio :]"),
	}, nil
}
    `.trim()
        },
        java: {
            config: configCode,
            entrypoint: 'EmptyHandler',
            code: `
import io.nuclio.Context;
import io.nuclio.Event;
import io.nuclio.EventHandler;
import io.nuclio.Response;

public class EmptyHandler implements EventHandler {
    @Override
    public Response handleEvent(Context context, Event event) {
        return new Response().setBody("Hello, from Nuclio :]");
    }
}
    `.trim()
        },
        dotnetcore: {
            config: configCode,
            entrypoint: 'nuclio:empty',
            code: `
using Nuclio.Sdk;

public class nuclio
{
    public object empty(Context context, Event eventBase)
    {
        return new Response()
        {
            StatusCode = 200,
            ContentType = "application/text",
            Body = "Hello, from Nuclio :)"
        };
    }
}
    `.trim()
        },
        nodejs: {
            config: configCode,
            entrypoint: 'handler',
            code: `
exports.handler = function(context, event) {
    var body = event.body.toString();
    context.logger.info('reversing: ' + body);
    context.callback(body.split('').reverse().join(''));
};
        `.trim()
        },
        shell: {
            config: configCode,
            code: `
#!/bin/sh

# reverse the input
rev /dev/stdin
        `.trim()
        },
    };

    return { configCode, samples };
}));
