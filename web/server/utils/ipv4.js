'use strict';

/**
 * IPv4 / CIDR helpers. Addresses are handled as unsigned 32-bit integers so
 * range checks are exact comparisons rather than string manipulation.
 */

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

// RFC 1918 private space plus RFC 6598 shared address space (common for overlays).
const PRIVATE_RANGES = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
];

const MIN_PREFIX = 16;
const MAX_PREFIX = 29;

function parseIPv4(str) {
  if (typeof str !== 'string' || !IPV4_RE.test(str)) return null;
  return str.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0) >>> 0;
}

function intToIPv4(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function prefixMask(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function rangeOf(networkInt, prefix) {
  const mask = prefixMask(prefix);
  const start = (networkInt & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return { start, end };
}

const PRIVATE_BLOCKS = PRIVATE_RANGES.map(([ip, p]) => ({ cidr: `${ip}/${p}`, ...rangeOf(parseIPv4(ip), p) }));

/**
 * Parses and validates a network CIDR. Returns { ok: true, value } or
 * { ok: false, code, message } — never throws on user input.
 */
function parseCIDR(input) {
  if (typeof input !== 'string') return { ok: false, code: 'CIDR_INVALID', message: 'CIDR must be a string' };
  const m = input.trim().match(/^([^/]+)\/(\d{1,2})$/);
  if (!m) return { ok: false, code: 'CIDR_INVALID', message: 'Expected IPv4 CIDR notation, e.g. 10.42.0.0/24' };
  const ip = parseIPv4(m[1]);
  const prefix = Number(m[2]);
  if (ip === null) return { ok: false, code: 'CIDR_INVALID', message: `"${m[1]}" is not a valid IPv4 address` };
  if (prefix < MIN_PREFIX || prefix > MAX_PREFIX) {
    return {
      ok: false,
      code: 'CIDR_PREFIX_OUT_OF_RANGE',
      message: `Prefix length must be between /${MIN_PREFIX} and /${MAX_PREFIX}`,
    };
  }
  const { start, end } = rangeOf(ip, prefix);
  if (start !== ip) {
    return {
      ok: false,
      code: 'CIDR_NOT_ALIGNED',
      message: `Host bits are set. Did you mean ${intToIPv4(start)}/${prefix}?`,
    };
  }
  const inside = PRIVATE_BLOCKS.find((b) => start >= b.start && end <= b.end);
  if (!inside) {
    return {
      ok: false,
      code: 'CIDR_NOT_PRIVATE',
      message: `Range must sit entirely inside private space (${PRIVATE_RANGES.map(([i, p]) => `${i}/${p}`).join(', ')})`,
    };
  }
  return {
    ok: true,
    value: { cidr: `${intToIPv4(start)}/${prefix}`, prefix, start, end, size: end - start + 1 },
  };
}

function rangesOverlap(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * First usable host address = network + 1 is reserved (future relay / gateway),
 * so allocation starts at network + 2 and stops before the broadcast address.
 */
function defaultReserved(start) {
  return [start + 1];
}

/** Lowest free host addresses, in order (at most `limit`). */
function freeAddresses({ start, end, used, reserved }, limit = 1) {
  const blocked = new Set([...(used || []), ...(reserved || defaultReserved(start))]);
  const out = [];
  for (let n = start + 1; n < end && out.length < limit; n++) {
    if (!blocked.has(n)) out.push(n);
  }
  return out;
}

function allocateAddress(opts) {
  return freeAddresses(opts, 1)[0] ?? null;
}

module.exports = {
  parseIPv4,
  intToIPv4,
  parseCIDR,
  rangesOverlap,
  allocateAddress,
  freeAddresses,
  defaultReserved,
  PRIVATE_RANGES,
  MIN_PREFIX,
  MAX_PREFIX,
};
