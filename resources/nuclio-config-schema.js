(function(root, factory) {
    const editor = factory();
    if (typeof module === 'object' && module.exports) module.exports = editor;
    if (root) root.NUCLIO_CONFIG_EDITOR = editor;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
    const integer = (description) => ({ type: 'integer', description });
    const string = (description) => ({ type: 'string', description });
    const boolean = (description) => ({ type: 'boolean', description });
    const enumValue = (values, description) => ({ type: 'string', enum: values, description });
    const map = (description) => ({ type: 'object', description });
    const list = (description) => ({ type: 'array', description });

    const SCHEMA = {
        apiVersion: string('Nuclio API version, normally nuclio.io/v1.'),
        kind: enumValue(['NuclioFunction', 'Function'], 'Nuclio function resource kind.'),
        metadata: {
            name: string('Function name.'),
            namespace: string('Nuclio namespace.'),
            labels: map('Lookup labels. Node-RED adds its ownership labels.'),
            annotations: map('Metadata annotations.'),
        },
        spec: {
            description: string('Human-readable function description.'),
            handler: string('Runtime handler in package:entrypoint form.'),
            runtime: string('Runtime, such as python:3.12, golang, nodejs, or shell.'),
            image: string('Pre-built function image.'),
            env: list('Runtime environment variables.'),
            envFrom: list('ConfigMap or Secret environment sources on Kubernetes.'),
            volumes: map('Function volumes.'),
            replicas: integer('Desired replicas; zero enables autoscaling.'),
            minReplicas: integer('Minimum autoscaled replicas.'),
            maxReplicas: integer('Maximum autoscaled replicas.'),
            targetCPU: integer('Autoscaling target CPU percentage.'),
            dataBindings: map('Named data sources available to the function.'),
            triggers: map('Named Nuclio triggers.'),
            build: {
                path: string('Git, archive, or source URL.'),
                functionSourceCode: string('Base64-encoded inline source code.'),
                registry: string('Registry for built images.'),
                noBaseImagePull: boolean('Use only locally available base images.'),
                noCache: boolean('Disable container build caching.'),
                baseImage: string('Function base image.'),
                commands: list('Commands run during the image build.'),
                directives: map('Container build directives.'),
                onbuildImage: string('Nuclio onbuild image.'),
                image: string('Built function image name.'),
                args: map('Container build arguments.'),
                flags: list('Container builder flags.'),
                codeEntryType: enumValue(['archive', 'git', 'github', 'image', 's3', 'sourceCode'], 'Function source type.'),
                codeEntryAttributes: map('Source-specific attributes.'),
                builderServiceAccount: string('Kubernetes builder service account.'),
            },
            runRegistry: string('Registry from which the platform pulls the image.'),
            runtimeAttributes: map('Runtime-specific attributes.'),
            resources: map('CPU, memory, and device requests and limits.'),
            readinessTimeoutSeconds: integer('Deployment readiness timeout.'),
            waitReadinessTimeoutBeforeFailure: boolean('Wait for the readiness timeout before failing.'),
            eventTimeout: string('Maximum event processing duration, such as 30s.'),
            securityContext: map('Container security context.'),
            serviceType: string('Service exposure type.'),
            affinity: map('Kubernetes scheduling affinity.'),
            nodeSelector: map('Kubernetes node selector.'),
            nodeName: string('Kubernetes node name.'),
            priorityClassName: string('Kubernetes priority class.'),
            preemptionPolicy: enumValue(['Never', 'PreemptLowerPriority'], 'Kubernetes pod preemption policy.'),
            tolerations: list('Kubernetes scheduling tolerations.'),
            customScalingMetricSpecs: list('Custom Kubernetes autoscaling metrics.'),
            disableDefaultHttpTrigger: boolean('Disable the default HTTP trigger.'),
            initContainers: list('Kubernetes init containers.'),
            sidecars: list('Kubernetes sidecars.'),
            readinessProbe: map('Kubernetes readiness probe.'),
            livenessProbe: map('Kubernetes liveness probe.'),
        },
    };

    const TRIGGER_SCHEMA = {
        kind: enumValue(['http', 'cron', 'eventhub', 'kafka-cluster', 'kinesis', 'nats', 'rabbit-mq'], 'Trigger kind.'),
        url: string('Trigger-specific URL.'),
        numWorkers: integer('Concurrent workers for this trigger.'),
        workerTerminationTimeout: string('Worker termination timeout.'),
        annotations: list('Trigger annotations.'),
        workerAvailabilityTimeoutMilliseconds: integer('Wait time for an available worker.'),
        attributes: map('Trigger-specific attributes.'),
        batch: {
            mode: enumValue(['enable', 'disable'], 'Enable or disable event batching.'),
            batchSize: integer('Maximum events per batch.'),
            timeout: string('Maximum time to wait for a batch.'),
        },
        mode: enumValue(['sync', 'async'], 'Event processing mode; async is Python HTTP only.'),
        async: {
            minConnectionsNumber: integer('Minimum async worker connections.'),
            maxConnectionsNumber: integer('Maximum async worker connections.'),
            connectionCreationMode: enumValue(['static', 'dynamic'], 'Async connection creation mode.'),
            connectionAvailabilityTimeout: string('Async connection allocation timeout.'),
        },
    };

    const NESTED_SCHEMA = {
        'spec.resources': {
            requests: map('Resource requests.'),
            limits: map('Resource limits.'),
        },
        'spec.securityContext': {
            runAsUser: integer('Container user ID.'),
            runAsGroup: integer('Container group ID.'),
            fsGroup: integer('Supplemental filesystem group.'),
        },
    };

    const getDefinition = (path) => {
        if (!Array.isArray(path) || !path.length) return SCHEMA;
        const joined = path.join('.');
        if (NESTED_SCHEMA[joined]) return NESTED_SCHEMA[joined];
        if (path[0] === 'spec' && path[1] === 'triggers') {
            if (path.length === 2) return { http: { type: 'object', description: 'Default HTTP trigger.' } };
            return TRIGGER_SCHEMA;
        }
        let current = SCHEMA;
        for (const segment of path) {
            if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) return {};
            current = current[segment];
        }
        return current && typeof current === 'object' && !current.type ? current : {};
    };

    const contextAt = (text, lineNumber, column) => {
        const lines = text.split(/\r?\n/);
        const stack = [];
        for (let index = 0; index < lineNumber; index += 1) {
            const line = lines[index];
            if (!line.trim() || /^\s*#/.test(line)) continue;
            const match = line.match(/^(\s*)(?:-\s*)?([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
            if (!match) continue;
            const indent = match[1].length;
            while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
            if (!match[3].trim()) stack.push({ indent, key: match[2] });
        }

        const line = lines[lineNumber] || '';
        const beforeCursor = line.slice(0, column);
        const keyMatch = beforeCursor.match(/^\s*(?:-\s*)?([A-Za-z_][\w.-]*)?\s*:\s*(.*)$/);
        const parentPath = stack.map(item => item.key);
        if (keyMatch) {
            const key = keyMatch[1];
            const value = keyMatch[2];
            if (key && beforeCursor.includes(':')) return { path: [...parentPath, key], value, keyPrefix: '' };
        }
        const prefix = (beforeCursor.match(/[A-Za-z_][\w.-]*$/) || [''])[0];
        return { path: parentPath, value: '', keyPrefix: prefix };
    };

    const completions = (text, lineNumber, column) => {
        const context = contextAt(text, lineNumber, column);
        const definition = getDefinition(context.path);
        const prefix = context.keyPrefix || '';
        return Object.entries(definition)
            .filter(([key]) => !prefix || key.startsWith(prefix))
            .map(([key, value]) => ({
                label: key,
                insertText: key,
                kind: 'property',
                detail: value.type || 'object',
                documentation: value.description || '',
            }));
    };

    const validate = (text) => {
        const annotations = [];
        const lines = text.split(/\r?\n/);
        lines.forEach((line, lineNumber) => {
            const match = line.match(/^(\s*)(?:-\s*)?([A-Za-z_][\w.-]*)\s*:\s*(.*?)\s*(?:#.*)?$/);
            if (!match || !match[3]) return;
            const context = contextAt(text, lineNumber, line.length);
            const definition = getDefinition(context.path.slice(0, -1))[match[2]] || {};
            const raw = match[3].replace(/^['"]|['"]$/g, '');
            if (raw.includes('${') || raw === 'null' || raw === '~') return;
            if (definition.enum && !definition.enum.includes(raw)) {
                annotations.push({ row: lineNumber, column: match[1].length, text: `${match[2]} must be one of: ${definition.enum.join(', ')}`, type: 'warning' });
            } else if (definition.type === 'integer' && !/^-?\d+$/.test(raw)) {
                annotations.push({ row: lineNumber, column: match[1].length, text: `${match[2]} should be an integer`, type: 'warning' });
            } else if (definition.type === 'boolean' && !/^(true|false)$/.test(raw)) {
                annotations.push({ row: lineNumber, column: match[1].length, text: `${match[2]} should be true or false`, type: 'warning' });
            }
        });
        return annotations;
    };

    const attach = (editor, { getRuntime } = {}) => {
        if (!editor) return { destroy() {} };
        const completer = {
            getCompletions(ed, session, position, prefix, callback) {
                const value = session.getValue();
                const items = completions(value, position.row, position.column).map(item => ({
                    caption: item.label,
                    value: item.insertText,
                    meta: item.detail,
                    docText: item.documentation,
                    type: 'property',
                }));
                callback(null, items);
            },
        };
        let aceAttached = false;
        if (editor.session && editor.session.setAnnotations && editor.completers) {
            editor.completers.unshift(completer);
            editor.setOptions?.({ enableBasicAutocompletion: true });
            aceAttached = true;
        }

        let monacoDisposable;
        if (rootMonaco() && editor.getModel) {
            const monaco = rootMonaco();
            monacoDisposable = monaco.languages.registerCompletionItemProvider('yaml', {
                triggerCharacters: [':', ' '],
                provideCompletionItems(model, position) {
                    const items = completions(model.getValue(), position.lineNumber - 1, position.column - 1);
                    const word = model.getWordUntilPosition(position);
                    const range = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: word.startColumn,
                        endColumn: position.column,
                    };
                    return { suggestions: items.map(item => ({
                        label: item.label,
                        insertText: item.insertText,
                        detail: item.detail,
                        documentation: item.documentation,
                        kind: monaco.languages.CompletionItemKind.Property,
                        range,
                    })) };
                },
            });
        }

        const annotate = () => {
            const value = editor.getValue();
            const annotations = validate(value);
            if (editor.session?.setAnnotations) editor.session.setAnnotations(annotations);
            if (rootMonaco() && editor.getModel) {
                rootMonaco().editor.setModelMarkers(editor.getModel(), 'nuclio-config', annotations.map(item => ({
                    startLineNumber: item.row + 1,
                    startColumn: item.column + 1,
                    endLineNumber: item.row + 1,
                    endColumn: item.column + 2,
                    message: item.text,
                    severity: rootMonaco().MarkerSeverity.Warning,
                })));
            }
        };
        const changeListener = editor.on?.('change', annotate);
        annotate();
        return {
            destroy() {
                if (aceAttached) editor.completers = editor.completers.filter(item => item !== completer);
                monacoDisposable?.dispose();
                changeListener?.off?.();
                if (editor.session?.setAnnotations) editor.session.setAnnotations([]);
            },
        };
    };

    const rootMonaco = () => typeof window !== 'undefined' && window.monaco ? window.monaco : null;

    return Object.freeze({ schema: SCHEMA, contextAt, getDefinition, completions, validate, attach });
}));
