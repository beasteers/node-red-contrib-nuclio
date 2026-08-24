(function(root, factory) {
    const status = factory();
    if (typeof module === 'object' && module.exports) module.exports = status;
    if (root) root.NUCLIO_FUNCTION_STATUS = status;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
    class Poller {
        constructor(fn, interval) {
            this.fn = fn;
            this.interval = interval;
            this.timer = null;
            this.running = false;
            this.inFlight = false;
        }

        start() {
            if (this.running) return;
            this.running = true;
            this.tick();
        }

        async tick() {
            if (!this.running || this.inFlight) return;
            this.inFlight = true;
            try {
                await this.fn();
            } catch {
                // The poll callback owns its display of request failures.
            } finally {
                this.inFlight = false;
                if (this.running) this.timer = setTimeout(() => this.tick(), this.interval);
            }
        }

        stop() {
            this.running = false;
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
        }
    }

    const create = ({ node, RED, $, ajaxJson }) => {
        let destroyed = false;
        const detailRequests = {};
        const detailCodeIds = {
            runLogs: 'nuclio-logs',
            buildLogs: 'nuclio-deploy-logs',
            spec: 'nuclio-spec',
        };
        const toggleHandlers = [];
        const statusElement = id => document.getElementById(id);
        const asList = value => Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);

        // escape anything API/log-derived before it goes into innerHTML
        const esc = value => `${value}`.replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));

        const stripAnsi = value => `${value ?? ''}`
            .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
            .replace(/\u009B[0-?]*[ -/]*[@-~]/g, '')
            .replace(/\r\n/g, '\n');

        const humanizeKey = key => `${key}`
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[_-]+/g, ' ')
            .replace(/\bhttp\b/gi, 'HTTP')
            .replace(/\burl(s?)\b/gi, 'URL$1')
            .replace(/\bapi\b/gi, 'API')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^\w/, c => c.toUpperCase());

        const fmt = obj => Object.entries(obj).map(([key, value]) => {
            if (typeof value === 'string' && value.includes('\n')) {
                return `<div class="nuclio-kv-row"><span class="nuclio-kv-key">${esc(humanizeKey(key))}</span><span class="nuclio-kv-value nuclio-kv-multiline">${esc(stripAnsi(value))}</span></div>`;
            }
            return `<div class="nuclio-kv-row"><span class="nuclio-kv-key">${esc(humanizeKey(key))}</span><span class="nuclio-kv-value">${esc(stripAnsi(JSON.stringify(value)))}</span></div>`;
        }).join('');

        const statusChips = obj => Object.entries(obj || {}).map(([key, value]) => {
            const text = stripAnsi(typeof value === 'string' ? value : JSON.stringify(value));
            return `<span class="nuclio-chip"><span class="nuclio-chip-key">${esc(humanizeKey(key))}</span><span class="nuclio-chip-value">${esc(text)}</span></span>`;
        }).join('');

        const canUpdateElement = element => {
            if (destroyed || !element) return !destroyed;
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed) return true;
            if (!selection.rangeCount) return true;
            const range = selection.getRangeAt(0);
            return !element.contains(range.commonAncestorContainer);
        };

        const statusTone = state => {
            if (!state || typeof state !== 'string') return 'unknown';
            if (state === 'unavailable') return 'unavailable';
            if (state === 'ready') return 'ok';
            if (state === 'error' || state === 'unhealthy') return 'error';
            if (state === 'scaledToZero') return 'idle';
            if (state.includes('waiting') || state === 'building' || state === 'configuringResources') return 'working';
            return 'warn';
        };

        const renderEndpoints = (status, invocation) => {
            if (destroyed) return;
            const preference = invocation?.preference || 'service';
            const activeUrls = new Set(asList(invocation?.urls));
            const groups = [
                { key: 'service', label: 'Service', urls: asList(invocation?.serviceUrls) },
                { key: 'internal', label: 'Internal', urls: asList(invocation?.internalUrls || status.internalInvocationUrls) },
                { key: 'external', label: 'External', urls: asList(invocation?.externalUrls || status.externalInvocationUrls) },
            ];
            const endpoints = groups.flatMap(({ key, label, urls }) => urls.map(url => ({
                label,
                url,
                active: activeUrls.has(url) && key === preference,
            })));
            const container = $('#nuclio-endpoints');
            if (!endpoints.length) {
                container.html('<div class="nuclio-status-section-note">No invocation endpoint available.</div>');
                return;
            }
            container.html(endpoints.map(({ label, url, active }) =>
                `<div class="nuclio-endpoint-row"><span class="nuclio-endpoint-label">${esc(label)}</span><span class="nuclio-endpoint-value" title="${esc(url)}">${esc(url)}</span>${active ? '<span class="nuclio-endpoint-active">Active</span>' : '<span></span>'}</div>`
            ).join(''));
        };

        const renderSummary = data => {
            if (destroyed) return;
            const status = data?.status || {};
            const invocation = data?.invocation || {};
            const metadata = data?.metadata || {};
            const spec = data?.spec || {};
            const state = status.state || 'unknown';
            const tone = statusTone(state);
            const server = RED.nodes.node(node.server);
            const preference = invocation.preference || server?.invocationUrlPreference || 'service';
            const mode = preference === 'internal'
                ? 'Internal'
                : preference === 'external'
                    ? 'External'
                    : 'Service';
            const numberValue = value => {
                if (typeof value === 'number' && Number.isFinite(value)) return value;
                if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
                return undefined;
            };
            const readyReplicas = numberValue(status.readyReplicas ?? status.availableReplicas ?? status.activeReplicas);
            const desiredReplicas = numberValue(status.desiredReplicas ?? status.replicas ?? spec.replicas);
            const observedReplicas = readyReplicas === undefined
                ? desiredReplicas === undefined ? '' : `${desiredReplicas}`
                : desiredReplicas === undefined ? `${readyReplicas}` : `${readyReplicas}/${desiredReplicas}`;
            const fixedReplicas = numberValue(spec.replicas);
            const autoscaled = fixedReplicas === 0 || spec.targetCPU !== undefined;
            const scaleMin = numberValue(spec.minReplicas);
            const scaleMax = numberValue(spec.maxReplicas);
            const scaleValue = observedReplicas || (autoscaled
                ? `${scaleMin ?? '—'}–${scaleMax ?? '—'}`
                : fixedReplicas === undefined ? '—' : `${fixedReplicas}`);
            const scaleMeta = autoscaled
                ? `Autoscaling ${scaleMin ?? '—'}–${scaleMax ?? '—'} · target ${spec.targetCPU ?? 75}% CPU`
                : `Fixed · ${fixedReplicas ?? 'YAML-configured'} replica(s)`;
            const replicaMeta = status.replicaStatusStale
                ? `Replica data stale${status.replicaStatusError ? ` (${status.replicaStatusError})` : ''}`
                : status.replicaStatusError
                    ? `Replica data unavailable (${status.replicaStatusError})`
                    : '';

            $('#nuclio-status-function-name').text(metadata.name || node.name || '—');
            $('#nuclio-status-state').text(state);
            $('#nuclio-status-chip').attr('data-tone', tone);
            $('#nuclio-status-updated').text(`Updated ${new Date().toLocaleTimeString()}`);
            $('#nuclio-deployment-value').text(state);
            $('#nuclio-deployment-meta').text(status.error || status.message || metadata.namespace || 'Nuclio deployment state');
            $('#nuclio-runtime-value').text(spec.runtime || '—');
            $('#nuclio-runtime-meta').text(spec.handler ? `Handler: ${spec.handler}` : 'Handler not reported');
            $('#nuclio-scale-value').text(scaleValue);
            $('#nuclio-scale-meta').text([scaleMeta, replicaMeta].filter(Boolean).join(' · '));
            $('#nuclio-invocation-mode').text(`Strategy: ${mode}`);
            if (canUpdateElement(statusElement('nuclio-status'))) {
                const signals = { ...status };
                delete signals.state;
                delete signals.internalInvocationUrls;
                delete signals.externalInvocationUrls;
                delete signals.replicas;
                delete signals.availableReplicas;
                delete signals.readyReplicas;
                delete signals.desiredReplicas;
                delete signals.activeReplicas;
                delete signals.replicaStatusError;
                delete signals.replicaStatusStale;
                const signalHtml = statusChips(signals);
                $('#nuclio-status').html(signalHtml);
                $('#nuclio-status-signals').toggleClass('nuclio-hidden', !signalHtml);
            }
            renderEndpoints(status, invocation);
        };

        const detailError = (key, error) => {
            if (destroyed) return;
            const message = error?.responseJSON?.error || error?.statusText || 'Unable to load this detail.';
            $(`#${detailCodeIds[key]}`).text(stripAnsi(message));
        };

        const loadDetail = (key, force = false) => {
            const details = {
                runLogs: {
                    url: `/nuclio/api/functions/logs?id=${node.id}`,
                    render: data => {
                        const entries = Object.entries(data || {}).map(([replica, log]) => {
                            const text = stripAnsi(typeof log === 'string' ? log : JSON.stringify(log));
                            return `<div class="nuclio-log-entry"><b class="nuclio-log-level">${esc(replica)}</b><div>${esc(text || '-- no logs --')}</div></div>`;
                        }).join('');
                        $('#nuclio-logs').html(entries || 'No replica logs available.');
                    },
                },
                buildLogs: {
                    url: `/nuclio/api/functions?id=${node.id}&view=logs`,
                    render: data => {
                        const entries = (data?.logs || []).map(({ level, message, time, name, requestID, ...log }) =>
                            `<div class="nuclio-log-entry"><b class="nuclio-log-level">${esc(stripAnsi(level || 'log'))}</b> ${esc(stripAnsi(message || ''))}${Object.keys(log).length ? `<div style="padding-left: 12px;">${fmt(log)}</div>` : ''}</div>`
                        ).join('');
                        $('#nuclio-deploy-logs').html(entries || 'No build logs available.');
                    },
                },
                spec: {
                    url: `/nuclio/api/functions?id=${node.id}&view=spec`,
                    render: data => {
                        // Secret paths are redacted server-side before this
                        // response leaves Node-RED.
                        $('#nuclio-spec').text(JSON.stringify({ metadata: data?.metadata, spec: data?.spec }, null, 2));
                    },
                },
            }[key];
            if (!details || (!force && detailRequests[key])) return detailRequests[key];
            $(`#${detailCodeIds[key]}`).text('Loading…');
            detailRequests[key] = ajaxJson({ url: details.url, method: 'GET' })
                .done(data => { if (!destroyed) details.render(data); })
                .fail(error => detailError(key, error))
                .always(() => { delete detailRequests[key]; });
            return detailRequests[key];
        };

        ['runLogs', 'buildLogs', 'spec'].forEach(key => {
            const detailsId = key === 'runLogs' ? 'nuclio-detail-run-logs' : key === 'buildLogs' ? 'nuclio-detail-build-logs' : 'nuclio-detail-spec';
            const element = statusElement(detailsId);
            if (!element) return;
            const handler = function() {
                if (this.open) loadDetail(key);
            };
            element.addEventListener('toggle', handler);
            toggleHandlers.push({ element, handler });
        });
        $('#nuclio-refresh-run-logs').off('click.nuclioStatus').on('click.nuclioStatus', () => loadDetail('runLogs', true));
        $('#nuclio-refresh-build-logs').off('click.nuclioStatus').on('click.nuclioStatus', () => loadDetail('buildLogs', true));
        $('#nuclio-refresh-spec').off('click.nuclioStatus').on('click.nuclioStatus', () => loadDetail('spec', true));

        const statusPoller = new Poller(() => {
            if (destroyed || !statusElement('nuclio-status-state')) {
                statusPoller.stop();
                return;
            }
            return ajaxJson({
                url: `/nuclio/api/functions?id=${node.id}&view=summary`,
                method: 'GET',
            }).done(renderSummary).fail(error => {
                if (destroyed) return;
                const message = error?.responseJSON?.error || error?.statusText || 'Unable to load function status.';
                if (!canUpdateElement(statusElement('nuclio-status'))) return;
                $('#nuclio-status').empty();
                $('#nuclio-status-signals').addClass('nuclio-hidden');
                $('#nuclio-status-state').text('unavailable');
                $('#nuclio-status-chip').attr('data-tone', 'unavailable');
                $('#nuclio-status-updated').text(`Last checked ${new Date().toLocaleTimeString()}`);
                $('#nuclio-deployment-value').text('Status unavailable');
                $('#nuclio-deployment-meta').text(`Nuclio status API unavailable: ${message}`);
                $('#nuclio-runtime-value').text('Unavailable');
                $('#nuclio-runtime-meta').text('Nuclio status API unavailable');
                $('#nuclio-scale-value').text('Unavailable');
                $('#nuclio-scale-meta').text('Nuclio status API unavailable');
                $('#nuclio-invocation-mode').text('Unavailable');
                $('#nuclio-endpoints').html('<div class="nuclio-status-section-note">Invocation endpoints unavailable.</div>');
            });
        }, 2400);

        return {
            onTabChange(tabId) {
                if (tabId === 'nuclio-tab-status') statusPoller.start();
                else statusPoller.stop();
            },
            destroy() {
                destroyed = true;
                statusPoller.stop();
                toggleHandlers.forEach(({ element, handler }) => element.removeEventListener('toggle', handler));
                $('#nuclio-refresh-run-logs, #nuclio-refresh-build-logs, #nuclio-refresh-spec').off('.nuclioStatus');
            },
        };
    };

    return { create };
}));
