// Unit tests for the subscription access rule. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveModules, isEntitled, moduleForPath } = require('./entitlements');

const now = new Date('2026-10-21T12:00:00Z');
const row = (module_key, status = 'active', extra = {}) => ({ module_key, status, starts_at: null, ends_at: null, ...extra });
const keys = set => [...set].sort();

test('active and in-date trial entitlements count; suspended, cancelled and expired do not', () => {
  assert.equal(isEntitled(row('core'), now), true);
  assert.equal(isEntitled(row('core', 'trial', { ends_at: '2026-11-01T00:00:00Z' }), now), true);
  assert.equal(isEntitled(row('core', 'trial', { ends_at: '2026-10-01T00:00:00Z' }), now), false);
  assert.equal(isEntitled(row('core', 'active', { ends_at: '2026-10-20T00:00:00Z' }), now), false);
  assert.equal(isEntitled(row('core', 'active', { starts_at: '2026-11-01T00:00:00Z' }), now), false);
  assert.equal(isEntitled(row('core', 'suspended'), now), false);
  assert.equal(isEntitled(row('core', 'cancelled'), now), false);
});

test('add-ons need Basic: without core a client has nothing', () => {
  assert.deepEqual(keys(resolveModules([row('core'), row('forecasting')], [], now)), ['core', 'forecasting']);
  assert.deepEqual(keys(resolveModules([row('core', 'suspended'), row('forecasting')], [], now)), []);
  assert.deepEqual(keys(resolveModules([row('forecasting')], [], now)), []);
});

test('a client with no rows gets the defaults; any row means explicit configuration', () => {
  assert.deepEqual(keys(resolveModules([], ['core'], now)), ['core']);
  assert.deepEqual(keys(resolveModules([row('core', 'cancelled')], ['core'], now)), []);
  assert.deepEqual(keys(resolveModules([], ['core', 'unknown-module'], now)), ['core']);
});

test('paths map to the module they need', () => {
  assert.equal(moduleForPath('/api/me'), null);
  assert.equal(moduleForPath('/api/login'), null);
  assert.equal(moduleForPath('/api/dashboard'), 'core');
  assert.equal(moduleForPath('/api/report/best-sellers'), 'core');
  assert.equal(moduleForPath('/api/forecasting/plan'), 'forecasting');
  assert.equal(moduleForPath('/api/stock/bbe'), 'bbe');
  assert.equal(moduleForPath('/api/stock/quarantine'), 'quarantine');
  assert.equal(moduleForPath('/app/stock/inventory-planner'), null);
});
