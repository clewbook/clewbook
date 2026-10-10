// The recount report hash (SPEC section 5): SHA-256 over a canonical JSON text, so the same report always gives the same hash.
// Canonical JSON: object keys sorted by their UTF-16 code units, no whitespace, strings as JSON.stringify writes them,
// whole numbers in plain decimal, any other number with exactly 8 decimal places, arrays in their given order.

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('A report cannot contain a number that is not finite.');
    return Number.isInteger(value) ? BigInt(value).toString() : value.toFixed(8);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new Error('A report can only contain text, numbers, true/false, lists and objects.');
}

export async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The hash a recount shows: version 1 of the envelope, then the campaign, the chain height it read up to, and the report. */
export function reportEnvelope(rulesId, endHeight, report) {
  return canonicalJson({ v: 1, rules_id: rulesId, end_height: endHeight, report });
}
