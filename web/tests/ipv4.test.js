'use strict';

// Category: unit-tested behaviour (pure functions).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCIDR, parseIPv4, intToIPv4, rangesOverlap, allocateAddress, defaultReserved } = require('../server/utils/ipv4');

test('parses canonical private CIDRs', () => {
  const r = parseCIDR('10.42.0.0/24');
  assert.equal(r.ok, true);
  assert.equal(r.value.cidr, '10.42.0.0/24');
  assert.equal(r.value.size, 256);
  assert.equal(parseCIDR('172.16.0.0/16').ok, true);
  assert.equal(parseCIDR('100.64.10.0/29').ok, true);
});

test('rejects malformed, misaligned, public and out-of-range CIDRs', () => {
  assert.equal(parseCIDR('10.42.0.0').code, 'CIDR_INVALID');
  assert.equal(parseCIDR('10.42.0.256/24').code, 'CIDR_INVALID');
  assert.equal(parseCIDR('010.1.0.0/24').code, 'CIDR_INVALID');
  assert.equal(parseCIDR('10.42.0.5/24').code, 'CIDR_NOT_ALIGNED');
  assert.match(parseCIDR('10.42.0.5/24').message, /10\.42\.0\.0\/24/);
  assert.equal(parseCIDR('8.8.8.0/24').code, 'CIDR_NOT_PRIVATE');
  assert.equal(parseCIDR('172.15.0.0/16').code, 'CIDR_NOT_PRIVATE');
  assert.equal(parseCIDR('10.0.0.0/8').code, 'CIDR_PREFIX_OUT_OF_RANGE');
  assert.equal(parseCIDR('10.0.0.0/30').code, 'CIDR_PREFIX_OUT_OF_RANGE');
  assert.equal(parseCIDR({}).ok, false);
});

test('overlap detection is exact at boundaries', () => {
  const a = parseCIDR('10.1.0.0/24').value;
  const b = parseCIDR('10.1.1.0/24').value;
  const c = parseCIDR('10.1.0.0/16').value;
  const d = parseCIDR('10.1.0.128/25').value;
  assert.equal(rangesOverlap(a, b), false);
  assert.equal(rangesOverlap(a, c), true);
  assert.equal(rangesOverlap(a, d), true);
});

test('allocation skips network, reserved (.1), used and broadcast addresses', () => {
  const r = parseCIDR('192.168.50.0/29').value; // .0 - .7
  const reserved = defaultReserved(r.start);
  const used = [];
  const got = [];
  for (;;) {
    const n = allocateAddress({ start: r.start, end: r.end, used, reserved });
    if (n === null) break;
    used.push(n);
    got.push(intToIPv4(n));
  }
  assert.deepEqual(got, ['192.168.50.2', '192.168.50.3', '192.168.50.4', '192.168.50.5', '192.168.50.6']);
});

test('ipv4 int round trip handles high bit', () => {
  assert.equal(intToIPv4(parseIPv4('255.255.255.255')), '255.255.255.255');
  assert.equal(parseIPv4('192.168.0.1'), 3232235521);
});
