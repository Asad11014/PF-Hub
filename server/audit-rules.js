// ─── server/audit-rules.js ────────────────────────────────────────────────────
// Re-runs a client's Mintsoft order rules on an order, to work out which rework
// items the order should carry (Invoice Audit, stage I2). Pure functions.
//
// Semantics (verified against billed data, 2026-11-04):
//   · ConditionType AND = every condition true; OR = any true; no conditions = always.
//   · List fields (product SKUs / names / categories) match if ANY item matches
//     (Equals, Contains, StartsWith); negated operators need NO item to match.
//     This fits Luff Sleep's courier rules better than matching the joined list.
//   · Text comparisons ignore case and surrounding spaces.
//   · OrderVolume = Σ width × height × depth × qty / 1,000,000 (cm → m³); this
//     reproduces Serendipity's SW-BOX / DW-BOX billing on 98.9 % of orders.
//   · Fields we cannot compute make a condition "unknown" (null): the rule's
//     outcome is then unknown too and is never guessed.

const LIST_FIELDS = {
  OrderItemProductSKUS: f => f.skus,
  OrderItemProductNames: f => f.names,
  OrderItemProductCategory: f => f.categories,
};
const TEXT_FIELDS = {
  OrderNumber: f => f.orderNumber, ExternalOrderReference: f => f.externalReference, FirstName: f => f.firstName,
  CompanyName: f => f.companyName, Address1: f => f.address1, Address2: f => f.address2, Town: f => f.town,
  County: f => f.county, PostCode: f => f.postcode, PhoneNumber: f => f.phone, MobileNumber: f => f.mobile,
  Email: f => f.email, CourierService: f => f.courierService, Channel: f => f.channel,
  GiftMessages: f => f.giftMessages, DeliveryNotes: f => f.deliveryNotes,
};
const NUMBER_FIELDS = {
  TotalWeight: f => f.totalWeight, OrderValue: f => f.orderValue, OrderVolume: f => f.orderVolume,
  NumberOfParcels: f => f.parcels, TotalItems: f => f.totalItems, LargestProductDimension: f => f.largestDimension,
};
const SUPPORTED_FIELDS = [...Object.keys(LIST_FIELDS), ...Object.keys(TEXT_FIELDS), ...Object.keys(NUMBER_FIELDS)];

// Actions that put a charge on the invoice. Others (courier changes, holds,
// added inserts, …) affect the order but not this audit.
const CHARGING_ACTIONS = new Set(['AddReworkItem']);

const norm = v => String(v ?? '').trim().toLowerCase();
const toNum = v => { const n = Number(String(v ?? '').trim()); return Number.isFinite(n) ? n : null; };

function compareText(op, actual, expected) {
  const a = norm(actual), e = norm(expected);
  switch (op) {
    case 'Equals': return a === e;
    case 'NotEqual': return a !== e;
    case 'Contains': return a.includes(e);
    case 'DoesNotContain': return !a.includes(e);
    case 'StartsWith': return a.startsWith(e);
    case 'DoesNotStartWith': return !a.startsWith(e);
    case 'Empty': return a === '';
    case 'IsNotEmpty': return a !== '';
    case 'GreaterThan': case 'LessThan': case 'EqualsOrGreaterThan': case 'EqualsOrLessThan': {
      const x = toNum(actual), y = toNum(expected);
      return x == null || y == null ? null : compareNumber(op, x, y);
    }
    default: return null;
  }
}

function compareNumber(op, actual, expected) {
  if (op === 'Empty') return actual == null || actual === 0;
  if (op === 'IsNotEmpty') return actual != null && actual !== 0;
  const a = actual == null ? null : Number(actual), e = toNum(expected);
  if (a == null || e == null) return null;
  switch (op) {
    case 'Equals': return a === e;
    case 'NotEqual': return a !== e;
    case 'GreaterThan': return a > e;
    case 'LessThan': return a < e;
    case 'EqualsOrGreaterThan': return a >= e;
    case 'EqualsOrLessThan': return a <= e;
    default: return null; // Contains etc. on numbers: not meaningful
  }
}

const NEGATED = new Set(['NotEqual', 'DoesNotContain', 'DoesNotStartWith']);
const POSITIVE_OF = { NotEqual: 'Equals', DoesNotContain: 'Contains', DoesNotStartWith: 'StartsWith' };

function compareList(op, list, expected) {
  const items = (list || []).map(norm).filter(Boolean);
  if (op === 'Empty') return items.length === 0;
  if (op === 'IsNotEmpty') return items.length > 0;
  if (NEGATED.has(op)) return !items.some(v => compareText(POSITIVE_OF[op], v, expected));
  if (['Equals', 'Contains', 'StartsWith'].includes(op)) return items.some(v => compareText(op, v, expected));
  return null; // numeric operators on a list
}

// → true | false | null (unknown field / operator)
function evaluateCondition(cond, f) {
  const field = cond.Field, op = cond.Operator, value = cond.Value;
  if (LIST_FIELDS[field]) return compareList(op, LIST_FIELDS[field](f), value);
  if (NUMBER_FIELDS[field]) return compareNumber(op, NUMBER_FIELDS[field](f), value);
  if (TEXT_FIELDS[field]) return compareText(op, TEXT_FIELDS[field](f), value);
  return null;
}

// The order's value for a field, for showing next to a condition.
function fieldValue(field, f) {
  if (LIST_FIELDS[field]) return LIST_FIELDS[field](f) || [];
  if (NUMBER_FIELDS[field]) return NUMBER_FIELDS[field](f) ?? null;
  if (TEXT_FIELDS[field]) return TEXT_FIELDS[field](f) ?? null;
  return undefined; // a field the audit cannot read
}

// Operators the condition evaluator understands (for the audit rule builder).
const OPERATORS = ['Equals', 'NotEqual', 'Contains', 'DoesNotContain', 'StartsWith', 'DoesNotStartWith', 'Empty', 'IsNotEmpty',
  'GreaterThan', 'LessThan', 'EqualsOrGreaterThan', 'EqualsOrLessThan'];

// Same as evaluateRule, with every condition's result and the order's value.
function explainRule(rule, f) {
  const conds = rule.OrderRuleConditions || [];
  const { applies, unknownFields } = evaluateRule(rule, f);
  const channelMismatch = !!(rule.ChannelId && f.channelId && Number(rule.ChannelId) !== Number(f.channelId));
  return {
    applies, unknownFields, channelMismatch,
    conditions: conds.map(c => ({ field: c.Field, operator: c.Operator, value: c.Value, actual: fieldValue(c.Field, f) ?? null, result: evaluateCondition(c, f) })),
  };
}

// → { applies: true | false | null, unknownFields: [...] }
function evaluateRule(rule, f) {
  if (!rule.Active) return { applies: false, unknownFields: [] };
  if (rule.ChannelId && f.channelId && Number(rule.ChannelId) !== Number(f.channelId)) return { applies: false, unknownFields: [] };
  if (rule.WarehouseId && f.warehouseId && Number(rule.WarehouseId) !== Number(f.warehouseId)) return { applies: false, unknownFields: [] };
  const conds = rule.OrderRuleConditions || [];
  if (!conds.length) return { applies: true, unknownFields: [] };
  const results = conds.map(c => evaluateCondition(c, f));
  const unknownFields = [...new Set(conds.filter((c, i) => results[i] == null).map(c => c.Field))];
  if (rule.ConditionType === 'OR') {
    if (results.some(r => r === true)) return { applies: true, unknownFields };
    return { applies: results.some(r => r == null) ? null : false, unknownFields };
  }
  if (results.some(r => r === false)) return { applies: false, unknownFields };
  return { applies: results.some(r => r == null) ? null : true, unknownFields };
}

// "BEDDING;1" → { code: 'BEDDING', qty: 1 }; "SW-BOX" → { code: 'SW-BOX', qty: 1 }
function parseParam(param) {
  const [code, qty] = String(param ?? '').split(';');
  const n = parseInt(qty, 10);
  return { code: code.trim(), qty: Number.isFinite(n) && n > 0 ? n : 1 };
}

// Rework items the client's rules add to this order. Rules last edited after
// the order was placed are reported as uncertain (their earlier version is not
// known), never applied silently.
function expectedRework(rules, f) {
  const items = new Map(); // code → qty
  const fired = [], unknown = [], editedAfter = [];
  const sorted = [...rules].filter(r => CHARGING_ACTIONS.has(r.Action)).sort((a, b) => (b.Priority || 0) - (a.Priority || 0));
  for (const rule of sorted) {
    const { applies, unknownFields } = evaluateRule(rule, f);
    const ruleDate = rule.LastUpdated ? new Date(rule.LastUpdated) : null;
    if (ruleDate && f.orderDate && f.orderDate < ruleDate) editedAfter.push(rule.ID);
    if (applies == null) { unknown.push({ ruleId: rule.ID, fields: unknownFields }); continue; }
    if (!applies) continue;
    const { code, qty } = parseParam(rule.Param);
    if (!code) continue;
    fired.push({ ruleId: rule.ID, code, qty, comments: rule.Comments || null });
    items.set(code, rule.OverwriteExisting ? qty : (items.get(code) || 0) + qty);
  }
  return { items: [...items].map(([code, qty]) => ({ code, qty })), fired, unknown, editedAfterOrder: editedAfter };
}

module.exports = {
  SUPPORTED_FIELDS, OPERATORS, CHARGING_ACTIONS, evaluateCondition, evaluateRule, explainRule, fieldValue, parseParam, expectedRework,
};
