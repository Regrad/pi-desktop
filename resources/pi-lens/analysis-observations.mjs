let entries = [];
export function captureObservation(type, record) { entries.push({ type, record }); }
export function takeObservations() { const result = entries; entries = []; return result; }
