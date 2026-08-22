const numericValue = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return undefined;
};

const firstNumeric = (...values) => values
    .map(numericValue)
    .find(value => value !== undefined);

const replicaText = fnNode => {
    const status = fnNode?.statusSnapshot?.status || {};
    const ready = firstNumeric(status.readyReplicas, status.availableReplicas, status.replicas);
    const desired = firstNumeric(status.desiredReplicas, status.replicas);
    if (ready === undefined && desired === undefined) return '';
    if (ready === undefined) return `${desired}r`;
    if (desired === undefined) return `${ready}r`;
    return `${ready}/${desired}r`;
};

const inFlightText = node => {
    const active = Math.max(0, numericValue(node?.counter) ?? 0);
    const limit = Math.max(0, numericValue(node?.maxInFlight) ?? 0);
    if (active === 0) return '';
    return limit > 0 ? `${active}/${limit}i` : `${active}i`;
};

const capacityText = (fnNode, node) => [replicaText(fnNode), inFlightText(node)].filter(Boolean).join(' · ');

const decorateStatus = (status, fnNode, node) => {
    const capacity = capacityText(fnNode, node);
    if (!capacity) return status;
    const text = status?.text === undefined || status?.text === null ? '' : `${status.text}`.trim();
    return { ...status, text: [text, capacity].filter(Boolean).join(' · ') };
};

module.exports = {
    capacityText,
    decorateStatus,
    inFlightText,
    replicaText,
};
