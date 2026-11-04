// Unit tests for the Invoice Audit engine's pure parts. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { mode, learnModel, cardModel, formula, counts, fitPicking } = require('./audit-engine');

test('mode picks the most common value (rounded to the penny)', () => {
  assert.deepEqual(mode([1.75, 1.75, 2.14, 1.7500001]), { value: 1.75, n: 3, of: 4 });
  assert.equal(mode([]), null);
});

const row = (units, billed, extra = {}) => ({ c: { units, lines: units, skus: 1, ...extra.c }, billed, pick: extra.pick ?? billed, extra: extra.extra ?? 0 });

test('per-item pattern: standard + additional per extra unit, learned from billing', () => {
  const card = { PickingCalculationType: 'PerItem', NumberOfItemsIncludedInStandardPick: 1 };
  const rows = [row(1, 1.75), row(1, 1.75), row(2, 2.14), row(3, 2.53), row(4, 2.92)];
  const m = learnModel(rows, card);
  assert.equal(m.S, 1.75); assert.equal(m.A, 0.39); assert.equal(m.by, 'units');
  assert.equal(formula.byCount(m, { units: 6 }), 3.7);
});

test('per order + per SKU + per unit pattern (Afida / Vending Warehouse)', () => {
  const card = { PickingCalculationType: 'PerOrderPerSkuPerUnit' };
  const r = (units, skus, extra) => ({ c: { units, skus, lines: skus }, pick: 0.62, extra, billed: 0.62 + extra });
  const m = learnModel([r(1, 1, 1.03), r(1, 1, 1.03), r(2, 1, 1.65), r(4, 1, 2.89), r(2, 2, 2.06)], card);
  assert.deepEqual({ S: m.S, K: m.K, U: m.U }, { S: 0.62, K: 0.41, U: 0.62 });
  assert.equal(formula.perSkuPerUnit(m, { units: 2, skus: 2 }), 2.68);
});

test('rate card → model for each Mintsoft picking method', () => {
  assert.equal(cardModel({ PickingCalculationType: 'PerItem', StandardPickingCost: 1.95, AdditionalPickingCostPerItem: 0.37 }).by, 'units');
  assert.equal(cardModel({ PickingCalculationType: 'PerOrderLine', StandardPickingCost: 1.45, AdditionalPickingCostPerItem: 1.45 }).by, 'lines');
  assert.equal(cardModel({ PickingCalculationType: 'PerOrderPerSkuPerUnit', StandardPickingCost: 0.19, PickingSKUCost: 0.19, AdditionalPickingCostPerItem: 0.19 }).kind, 'perSkuPerUnit');
  assert.equal(cardModel({ PickingCalculationType: 'Tiered' }), null);
});

test('non-charged SKUs are left out of the counts', () => {
  const items = [{ sku: 'BOTTLE', quantity: 2 }, { sku: 'SPRAYHEAD', quantity: 2 }];
  assert.deepEqual(counts(items, new Set(['SPRAYHEAD'])), { units: 2, lines: 1, skus: 1 });
});

test('an order matches if the rate card OR the learned pattern explains it', () => {
  const card = { PickingCalculationType: 'PerOrderLine', StandardPickingCost: 1.45, AdditionalPickingCostPerItem: 1.45, NumberOfItemsIncludedInStandardPick: 1 };
  const it = (n) => Array.from({ length: n }, (_, i) => ({ sku: `S${i}`, quantity: 1 }));
  const retail = [1, 1, 2, 2, 3].map(n => ({ items: it(n), channel: 'Web', billed: [1.75, 1.75, 2.14, 2.14, 2.53][[1, 1, 2, 2, 3].indexOf(n)] ?? 1.75, pick: 0, extra: 0 }));
  retail.forEach((r, i) => { r.billed = [1.75, 1.75, 2.14, 2.14, 2.53][i]; });
  const b2b = { items: it(7), channel: 'B2B', billed: 10.15, pick: 1.45, extra: 8.7 };   // at the rate card: 1.45 × 7 lines
  const fit = fitPicking({ '2026-09': [...retail, b2b] }, card, new Set());
  assert.equal(fit.matched, 6);
  assert.equal(fit.months['2026-09'].cardMatched, 1);
});
