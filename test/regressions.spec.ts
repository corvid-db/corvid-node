/**
 * regressions.spec.ts — acceptance-review regressions, kept separate
 * from the golden port (whose 256-line fixture count must stay
 * untouched). Each test pins a reviewed contract:
 *
 * - B1: negative safe integers map to engine Int (like every other
 *   binding); only -0.0 is excluded from the Int mapping. Observables:
 *   the group-aggregation key tag (`i:-5`, never `f:-5`) and the
 *   kind-strict schema check (an `int` field accepts Int, rejects
 *   Float).
 * - M7: unbounded JS nesting converts to a clean InvalidArgument
 *   CorvidError (depth cap), never a native stack overflow.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';

import { CorvidError, Db, ErrorCode } from '../index.js';

let db: ReturnType<typeof Db.openMemory>;

beforeAll(() => {
  db = Db.openMemory();
});

afterAll(() => {
  db.close();
});

function expectCode(fn: () => unknown, code: number, ctx: string): void {
  let threw: unknown = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!(threw instanceof CorvidError)) {
    throw new Error(`${ctx}: threw ${String(threw)} (not a CorvidError)`);
  }
  expect(threw.code, `${ctx}: error code`).toBe(code);
}

// ---------------------------------------------------------------------------
// B1 — negative integers are Ints
// ---------------------------------------------------------------------------

test('B1(a): plain JS -5 round-trips as engine Int — group key i:-5', () => {
  const c = db.collection('b1-group');
  c.insert('neg', { n: -5 });
  c.insert('pos', { n: 5 }); // positive control
  expect(c.get('neg'), 'B1(a): document round trip').toEqual({ n: -5 });
  const groups = c.query().groupCount('n');
  expect(Object.keys(groups), 'B1(a): group keys (engine ascending order)').toEqual(['i:-5', 'i:5']);
  expect(groups['i:-5'], 'B1(a): -5 grouped as Int').toBe(1);
  c.close();
});

test('B1(b): an int-typed schema field accepts negative numbers', () => {
  const c = db.collection('b1-schema');
  c.setSchema([{ name: 'n', type: 'int' }]);
  c.insert('k', { n: -5 });
  expect(c.get('k'), 'B1(b): stored document').toEqual({ n: -5 });
  c.close();
});

test('B1(c): -0.0 still maps to engine Float (the original intent)', () => {
  const c = db.collection('b1-negzero');
  c.insert('fz', { n: -0.0 }); // plain JS -0 → Float by design
  c.insert('iz', { n: 0 }); // plain JS 0 → Int
  const groups = c.query().groupCount('n');
  expect(groups['f:0'], 'B1(c): -0.0 grouped as Float').toBe(1);
  expect(groups['i:0'], 'B1(c): 0 grouped as Int').toBe(1);
  // The kind-strict mirror: an int schema must keep rejecting -0.0.
  const s = db.collection('b1-negzero-schema');
  s.setSchema([{ name: 'n', type: 'int' }]);
  expectCode(() => s.insert('z', { n: -0.0 }), ErrorCode.SchemaViolation, 'B1(c): int schema rejects -0.0');
  c.close();
  s.close();
});

// ---------------------------------------------------------------------------
// M7 — depth cap on recursive value conversion
// ---------------------------------------------------------------------------

test('M7: deeply nested values throw InvalidArgument (depth cap), not a native crash', () => {
  const c = db.collection('m7-depth');
  let deep: unknown = 0;
  for (let i = 0; i < 5_000; i++) deep = [deep];
  expectCode(() => c.insert('deep', { deep }), ErrorCode.InvalidArgument, 'M7: depth cap');
  // A structure comfortably under the cap still round-trips.
  let shallow: unknown = 0;
  for (let i = 0; i < 100; i++) shallow = [shallow];
  c.insert('shallow', { shallow });
  expect(c.get('shallow'), 'M7: under-cap round trip').toEqual({ shallow });
  c.close();
});

// ---------------------------------------------------------------------------
// The frozen error-code table (docs/SURFACE.tsv: the corvid::Error rows).
// The fixtures prove the codes the suite can trigger (err:10/11/12/14/15/17);
// the redb-internal fault variants have no public trigger (engine radar
// exempts them), so the table itself is the proof every variant maps to its
// frozen code (FFI.md §1.3: values are never renumbered).
// ---------------------------------------------------------------------------

test('error-code table is frozen (every engine Error variant maps to its documented code)', () => {
  expect(ErrorCode, 'the frozen table, verbatim').toEqual({
    Database: 1,
    Transaction: 2,
    Table: 3,
    Storage: 4,
    Commit: 5,
    SetDurability: 6,
    Compaction: 7,
    Decode: 8,
    CorruptIndex: 9,
    ReservedCollection: 10,
    InvalidName: 11,
    InvalidArgument: 12,
    IncompatibleFormat: 13,
    EmptyIndexTraining: 14,
    SchemaViolation: 15,
    InvalidDump: 16,
    BackupTargetExists: 17,
    Io: 18,
    Busy: 19, // FFI-only: compact exclusivity, no engine Error variant
  });
});
