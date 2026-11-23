import assert from 'node:assert/strict';
import { applyDateRange } from '../controller/ticket.controller.js';

const iso = (y, m, d, h = 0, min = 0, s = 0, ms = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, min, s, ms)).toISOString();

// Helper: run applyDateRange and return the createdAt filter built
const buildFilter = (dateFrom, dateTo) => {
  const filter = {};
  applyDateRange(filter, dateFrom, dateTo);
  return filter;
};

const getCreatedAt = (filter) => {
  const and = filter.$and && filter.$and.find((c) => c.createdAt);
  return and && and.createdAt;
};

console.log('Running applyDateRange tests...');

// 1. No dates -> filter unchanged
{
  const f = {};
  applyDateRange(f, undefined, undefined);
  assert.deepStrictEqual(f, {});
  console.log('  ✓ no dates leaves filter unchanged');
}

// 2. Only from (bare date -> start of day)
{
  const f = buildFilter('2026-10-01', undefined);
  const ca = getCreatedAt(f);
  assert.ok(ca.$gte, 'expected $gte');
  assert.strictEqual(ca.$gte.toISOString(), iso(2026, 10, 1, 0, 0, 0, 0));
  console.log('  ✓ bare from date -> start of day', ca.$gte.toISOString());
}

// 3. Only to (bare date -> end of day)
{
  const f = buildFilter(undefined, '2026-10-31');
  const ca = getCreatedAt(f);
  assert.ok(ca.$lte, 'expected $lte');
  assert.strictEqual(ca.$lte.toISOString(), iso(2026, 10, 31, 23, 59, 59, 999));
  console.log('  ✓ bare to date -> end of day', ca.$lte.toISOString());
}

// 4. Both dates (inclusive range)
{
  const f = buildFilter('2026-10-01', '2026-10-31');
  const clauses = f.$and.filter((c) => c.createdAt);
  assert.strictEqual(clauses.length, 2, 'expected two createdAt clauses');
  assert.strictEqual(clauses[0].createdAt.$gte.toISOString(), iso(2026, 10, 1, 0, 0, 0, 0));
  assert.strictEqual(clauses[1].createdAt.$lte.toISOString(), iso(2026, 10, 31, 23, 59, 59, 999));
  console.log('  ✓ both dates -> inclusive range');
}

// 5. Full ISO 8601 timestamps (time preserved, not coerced)
{
  const from = iso(2026, 10, 1, 6, 30, 0, 0);
  const to = iso(2026, 10, 31, 18, 45, 30, 123);
  const f = buildFilter(from, to);
  const clauses = f.$and.filter((c) => c.createdAt);
  assert.strictEqual(clauses[0].createdAt.$gte.toISOString(), from);
  assert.strictEqual(clauses[1].createdAt.$lte.toISOString(), to);
  console.log('  ✓ ISO timestamps preserved as-is');
}

// 6. Invalid date strings are ignored (no crash, no clause)
{
  const f = buildFilter('not-a-date', 'also-invalid');
  assert.strictEqual(f.$and, undefined, 'expected no $and for invalid dates');
  console.log('  ✓ invalid date strings ignored safely');
}

// 7. Empty strings treated as absent
{
  const f = buildFilter('', '');
  assert.deepStrictEqual(f, {});
  console.log('  ✓ empty strings treated as absent');
}

// 8. Mixed valid from + invalid to -> only from applied
{
  const f = buildFilter('2026-10-01', 'garbage');
  const clauses = f.$and.filter((c) => c.createdAt);
  assert.strictEqual(clauses.length, 1);
  assert.ok(clauses[0].createdAt.$gte);
  assert.strictEqual(clauses[0].createdAt.$gte.toISOString(), iso(2026, 10, 1, 0, 0, 0, 0));
  console.log('  ✓ mixed valid/invalid -> only valid applied');
}

console.log('\nAll applyDateRange tests passed.');
