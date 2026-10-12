let entries = [];
export function captureObservation(type, record) { entries.push({ type, record }); }
export function logLatency(record) { entries.push({ type: "latency", record }); }
export function incrementDegradationCount(record) { entries.push({ type: "count", record }); return true; }
export function recordDegradationOnce(record) { entries.push({ type: "once", record }); }
export function takeObservations() { const result = entries; entries = []; return result; }
