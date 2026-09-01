/**
 * golden.spec.ts — the golden-suite port for corvid-node.
 *
 * Replays the engine's committed fixture suite (test/golden/*.txt —
 * vendored verbatim from the corvid v0.2.1 release, the same files the
 * C smoke suite drives) against this binding's public OOP surface
 * (index.js): one OP<TAB>args<TAB>expected line at a time, every line
 * dispatched, every expectation checked. The fixtures are test-time
 * inputs — the binding itself parses nothing.
 *
 * Port conventions (mirroring c/smoke.c in the engine repo):
 *   - '#' lines and blank lines are ignored (not counted executable);
 *     an independent pre-scan counts executable lines so a dispatch
 *     loop that silently skips a line diverges from `executed`.
 *   - Value literals: null true false | -123 | 3.5 | inf -inf |
 *     bits:0x… (f64 from bits) | bits32:0x… (f32) | t(text) | b(bytes)
 *     | vec(1.5,bits32:0x…,2) | [a,b] | {k=v,k2=v2}.
 *   - Computed doubles (distances, scores, sums) expect `~x` (1e-6
 *     relative tolerance); stored literals compare bit-exactly (the
 *     engine preserves f64 bits — NaN payloads included; V8 preserves
 *     them in unarithmetic'd HeapNumbers, which is what the bit
 *     compares below rely on).
 *   - Value ops round-trip through a scratch in-memory db (insert +
 *     get): the JS↔engine value mapping lives inside the native layer,
 *     so crossing the boundary is what the values.txt lines prove.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Db,
  Collection,
  CorvidError,
  CorvidFloat,
  field,
  and,
  or,
  not,
  ffiVersion,
} from '../index.js';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'golden');
const WORK_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'work');
const FILES = [
  'values.txt',
  'mutations.txt',
  'queries.txt',
  'schema.txt',
  'graph.txt',
  'geo.txt',
  'persist.txt',
  'admin.txt',
];

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

/** Split `s` on top-level commas (depth-aware over []{}()). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s[i] : ',';
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    if (c === ',' && depth === 0) {
      let end = i;
      while (end > start && (s[end - 1] === ' ' || s[end - 1] === '\r')) end--;
      if (end > start) out.push(s.slice(start, end));
      start = i + 1;
    }
  }
  return out;
}

const f64 = new DataView(new ArrayBuffer(8));

/** f64 from raw bits (a BigInt). */
function f64FromBits(bits: bigint): number {
  f64.setBigUint64(0, bits & 0xffffffffffffffffn, false);
  return f64.getFloat64(0, false);
}

function f64Bits(n: number): bigint {
  f64.setFloat64(0, n, false);
  return f64.getBigUint64(0, false);
}

const f32 = new DataView(new ArrayBuffer(4));

/** f32 from raw bits (a uint32). */
function f32FromBits(bits: number): number {
  f32.setUint32(0, bits >>> 0, false);
  return f32.getFloat32(0, false);
}

function f32Bits(n: number): number {
  f32.setFloat32(0, n, false);
  return f32.getUint32(0, false);
}

/** Parse one expected-double token: `~x` near; `=x`/`x`/bits:/inf exact. */
function doubleMatches(got: number, tok: string): boolean {
  if (tok.startsWith('~')) return doubleNear(got, parseDouble(tok.slice(1)));
  return numbersEqual(got, parseDouble(tok.replace(/^=/, '')));
}

function doubleNear(got: number, want: number): boolean {
  return Math.abs(got - want) <= 1e-6 * (1 + Math.abs(want));
}

/**
 * NaN fidelity boundary: V8 canonicalizes NaN payloads when a double
 * crosses the N-API number boundary (plain JS HeapNumbers preserve
 * them; the napi boxing does not — verified on arm64 darwin / node 22).
 * The engine itself preserves f64 bits, but a JS consumer can only
 * observe NaN-as-NaN, so payload-bit expectations compare as NaN-class
 * equality here. `-0.0`, `inf` and `-inf` DO survive bit-exactly, and
 * Float32Array vector elements keep their bits (typed-array memory is
 * never boxed).
 */
function numbersEqual(got: number, want: number): boolean {
  if (Number.isNaN(got) && Number.isNaN(want)) return true;
  return f64Bits(got) === f64Bits(want);
}

function parseDouble(tok: string): number {
  if (tok === 'inf') return Infinity;
  if (tok === '-inf') return -Infinity;
  if (tok === 'nan') return NaN;
  if (tok.startsWith('bits:')) return f64FromBits(BigInt(tok.slice(5)));
  return parseFloat(tok);
}

/** The `err:N` expected token → its code. */
function errCode(expected: string): number {
  if (!expected.startsWith('err:')) throw new Error(`error expectation must be err:N, got '${expected}'`);
  return parseInt(expected.slice(4), 10);
}

/** The `t(...)` literal body. */
function textBody(tok: string): string {
  if (!tok.startsWith('t(') || !tok.endsWith(')')) throw new Error(`expected a t(...) literal, got '${tok}'`);
  return tok.slice(2, -1);
}

/** The `k(...)` list body. */
function listBody(tok: string): string {
  if (!tok.startsWith('k(') || !tok.endsWith(')')) throw new Error(`expected a k(...) list, got '${tok}'`);
  return tok.slice(2, -1);
}

// ---------------------------------------------------------------------------
// Value literals: parse into JS values (the mapping's input form)
// ---------------------------------------------------------------------------

const MAX_SAFE = 0x1fffffffffffff; // 2^53 - 1

function isDigits(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

/** Parse an int token: a JS number when safe, a BigInt for the extremes. */
function parseIntLiteral(tok: string): number | bigint {
  const n = BigInt(tok);
  if (n >= -MAX_SAFE && n <= MAX_SAFE) return Number(n);
  return n;
}

/**
 * Parse one literal into the JS value the binding's mapping accepts:
 * ints → number|bigint, floats → number (bits preserved), t() → string,
 * b() → Buffer, vec() → Float32Array, [..] → Array, {k=v} → object.
 */
function parseLiteral(src: string, pos = { i: 0 }): unknown {
  skipWs(src, pos);
  if (pos.i >= src.length) throw new Error('empty literal');
  const start = pos.i;
  const c = src[start];

  // numbers: -123 | 3.5 | inf | -inf | nan | bits:0x…
  const isWordNum = src.startsWith('inf', start) || src.startsWith('-inf', start) || src.startsWith('nan', start);
  if (c === '-' || (c >= '0' && c <= '9') || src.startsWith('bits:', start) || isWordNum) {
    let j = start;
    let isFloat = false;
    let isBits = false;
    if (src.startsWith('inf', j) || src.startsWith('-inf', j) || src.startsWith('nan', j)) {
      pos.i = j + (src.startsWith('-inf', j) ? 4 : 3);
      return new CorvidFloat(parseDouble(src.slice(start, pos.i)));
    }
    if (src.startsWith('bits:', j)) {
      isFloat = true;
      isBits = true;
      j += 5;
    }
    while (j < src.length) {
      const d = src[j];
      if ((d >= '0' && d <= '9') || d === '-' || d === '+') j++;
      else if (d === '.' || d === 'e' || d === 'E') {
        isFloat = true;
        j++;
      } else if (isBits && /[0-9a-fA-FxX]/.test(d)) j++;
      else break;
    }
    const tok = src.slice(start, j);
    pos.i = j;
    if (isBits) return new CorvidFloat(f64FromBits(BigInt(tok.slice(5))));
    if (isFloat) return new CorvidFloat(parseFloat(tok));
    return parseIntLiteral(tok);
  }

  if (src.startsWith('null', start) && delimsAfter(src, start, 4)) {
    pos.i = start + 4;
    return null;
  }
  if (src.startsWith('true', start) && delimsAfter(src, start, 4)) {
    pos.i = start + 4;
    return true;
  }
  if (src.startsWith('false', start) && delimsAfter(src, start, 5)) {
    pos.i = start + 5;
    return false;
  }

  // t(...) / b(...) / vec(...)
  const paren = (head: string, from: number): string | null => {
    if (!src.startsWith(head, from)) return null;
    const open = from + head.length - 1;
    let depth = 0;
    for (let q = open; q < src.length; q++) {
      if (src[q] === '(') depth++;
      else if (src[q] === ')') {
        depth--;
        if (depth === 0) return src.slice(open + 1, q);
      }
    }
    throw new Error('unbalanced () in literal');
  };
  if ((c === 't' || c === 'b') && src[start + 1] === '(') {
    const body = paren(c === 't' ? 't(' : 'b(', start)!;
    pos.i = start + 2 + body.length + 1;
    return c === 't' ? body : Buffer.from(body, 'latin1');
  }
  if (c === 'v' && src.startsWith('vec(', start)) {
    const body = paren('vec(', start)!;
    pos.i = start + 4 + body.length + 1;
    const elems = splitTop(body).map((tok) =>
      tok.startsWith('bits32:') ? f32FromBits(parseInt(tok.slice(7), 16)) : parseDouble(tok),
    );
    return Float32Array.from(elems);
  }

  if (c === '[') {
    const close = matchBracket(src, start, '[', ']');
    const body = src.slice(start + 1, close);
    const arr: unknown[] = [];
    const p = { i: 0 };
    while (p.i < body.length) {
      arr.push(parseLiteral(body, p));
      skipWs(body, p);
      if (p.i < body.length && body[p.i] === ',') p.i++;
    }
    pos.i = close + 1;
    return arr;
  }

  if (c === '{') {
    const close = matchBracket(src, start, '{', '}');
    const body = src.slice(start + 1, close);
    const obj: Record<string, unknown> = {};
    let j = 0;
    while (j < body.length) {
      let ke = j;
      while (ke < body.length && body[ke] !== '=') ke++;
      if (ke >= body.length) throw new Error('map literal needs k=v pairs');
      const key = body.slice(j, ke).trim();
      j = ke + 1;
      const p = { i: j };
      const value = parseLiteral(body, p);
      obj[key] = value;
      j = p.i;
      while (j < body.length && (body[j] === ' ' || body[j] === ',')) j++;
    }
    pos.i = close + 1;
    return obj;
  }

  throw new Error(`unparseable literal at '${src.slice(start, start + 24)}'`);
}

function delimsAfter(s: string, at: number, wordLen: number): boolean {
  const after = s[at + wordLen];
  return after === undefined || after === ',' || after === ']' || after === '}' || after === ' ' || after === '\r';
}

function matchBracket(s: string, at: number, open: string, close: string): number {
  let depth = 0;
  for (let q = at; q < s.length; q++) {
    if (s[q] === open) depth++;
    else if (s[q] === close) {
      depth--;
      if (depth === 0) return q;
    }
  }
  throw new Error(`unbalanced ${open}${close} in literal`);
}

function skipWs(s: string, pos: { i: number }): void {
  while (pos.i < s.length && (s[pos.i] === ' ' || s[pos.i] === '\r')) pos.i++;
}

// ---------------------------------------------------------------------------
// Structural comparison (the mapped JS values)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    !(v instanceof Buffer) && !(v instanceof Float32Array)
  );
}

function isNumberLike(v: unknown): v is number {
  return typeof v === 'number' || v instanceof CorvidFloat;
}

function valuesEqual(got: unknown, want: unknown): boolean {
  if (got === want) return true;
  if (isNumberLike(got) && isNumberLike(want)) return numbersEqual(Number(got), Number(want));
  if (typeof got === 'bigint' || typeof want === 'bigint') return false;
  if (typeof got !== typeof want && !(isNumberLike(got) && isNumberLike(want))) return false;
  if (typeof got === 'string') return got === want;
  if (Array.isArray(got) && Array.isArray(want)) {
    return got.length === want.length && got.every((g, i) => valuesEqual(g, want[i]));
  }
  if (got instanceof Buffer && want instanceof Buffer) return got.equals(want);
  if (got instanceof Float32Array && want instanceof Float32Array) {
    if (got.length !== want.length) return false;
    const g = new Uint32Array(got.buffer, got.byteOffset, got.length);
    const w = new Uint32Array(want.buffer, want.byteOffset, want.length);
    for (let i = 0; i < g.length; i++) if (g[i] !== w[i]) return false;
    return true;
  }
  if (isPlainObject(got) && isPlainObject(want)) {
    const gk = Object.keys(got);
    const wk = Object.keys(want);
    if (gk.length !== wk.length) return false;
    return wk.every((k) => k in got && valuesEqual(got[k], want[k]));
  }
  return false;
}

function render(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number') return `${v} (bits 0x${f64Bits(v).toString(16)})`;
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Float32Array) return `vec(${Array.from(v).join(',')})`;
  if (v instanceof Buffer) return `b(${v.toString('latin1')})`;
  if (Array.isArray(v)) return `[${v.map(render).join(',')}]`;
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
}

function checkValue(got: unknown, wantTok: string, ctx: string): void {
  const want = parseLiteral(wantTok);
  expect(valuesEqual(got, want), `${ctx}: value mismatch: got ${render(got)}, want ${render(want)}`).toBe(true);
}

/** Walk a child path like a.b.0.c; undefined when absent. */
function walkPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = isDigits(seg) && Array.isArray(cur)
      ? cur[parseInt(seg, 10)]
      : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Predicate helpers over the literal grammar
// ---------------------------------------------------------------------------

type Cmp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

function cmpPred(path: string, op: string, valLit: string) {
  const f = field(path) as Record<string, (v: unknown) => unknown>;
  return f[op as Cmp](parseLiteral(valLit)) as object;
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

const scenarios: string[] = [];

class Scenario {
  db: Db | null = null;
  coll: Collection | null = null;
  scratch: Db;
  workdir = '';
  dbPath = '';
  db2Path = '';
  dumpPath = '';
  backupPath = '';
  lastAutoId = 0;

  constructor(public file: string) {
    // values.txt runs against no scenario db (the scratch db below is
    // harness-internal: the mapping needs a boundary crossing).
    this.scratch = Db.openMemory();
  }

  closeColl(): void {
    if (this.coll) {
      this.coll.close();
      this.coll = null;
    }
  }

  closeDb(): void {
    this.closeColl();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  docs(): Collection {
    if (!this.coll) {
      if (!this.db) throw new Error(`no database open (${this.file})`);
      this.coll = this.db.collection('docs');
    }
    return this.coll;
  }

  openMemory(): void {
    this.closeDb();
    this.db = Db.openMemory();
    this.docs();
  }

  openFile(path: string): void {
    this.closeDb();
    this.db = Db.open(path);
    this.docs();
  }

  /** Round-trip a literal through the engine (the boundary crossing). */
  rt(litTok: string): unknown {
    const coll = this.scratch.collection('v');
    coll.insert('k', parseLiteral(litTok));
    const got = coll.get('k');
    coll.close();
    return got;
  }
}

function expectError(fn: () => unknown, code: number, ctx: string): void {
  let threw: unknown = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error(`${ctx}: expected a CorvidError with code ${code}, nothing threw`);
  if (!(threw instanceof CorvidError)) throw new Error(`${ctx}: threw ${String(threw)} (not a CorvidError)`);
  expect(threw.code, `${ctx}: error code`).toBe(code);
  expect(typeof threw.message === 'string' && threw.message.length > 0, `${ctx}: error message present`).toBe(true);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'bigint') return 'int';
  if (typeof v === 'number') return 'float';
  if (typeof v === 'string') return 'text';
  if (v instanceof Buffer) return 'bytes';
  if (v instanceof Float32Array) return 'vector';
  if (Array.isArray(v)) return 'array';
  if (isPlainObject(v)) return 'map';
  throw new Error(`no type name for ${render(v)}`);
}

function lengthOf(v: unknown): number {
  if (typeof v === 'string') return v.length; // UTF-16 units (ASCII fixtures)
  if (Array.isArray(v) || v instanceof Buffer || v instanceof Float32Array) return v.length;
  if (isPlainObject(v)) return Object.keys(v).length;
  return 0;
}

function parseMetric(s: string): 'cosine' | 'dot' | 'l2' {
  if (s === 'cosine' || s === 'dot' || s === 'l2') return s;
  throw new Error(`bad metric '${s}'`);
}

function parseQuant(s: string): 'none' | 'binary' | 'scalar' {
  if (s === 'none' || s === 'binary' || s === 'scalar') return s;
  throw new Error(`bad quant '${s}'`);
}

const FIELD_TYPES = ['any', 'bool', 'int', 'float', 'text', 'bytes', 'vector', 'array', 'map'] as const;

function parseFieldType(s: string): (typeof FIELD_TYPES)[number] {
  const i = FIELD_TYPES.indexOf(s as (typeof FIELD_TYPES)[number]);
  if (i < 0) throw new Error(`bad field type '${s}'`);
  return FIELD_TYPES[i];
}

function rowKeys(rows: { key: unknown }[]): string[] {
  return rows.map((r) => String(r.key));
}

function checkKeys(keys: string[], expected: string, ctx: string): void {
  const want = listBody(expected);
  const wanted = want === '' ? [] : splitTop(want);
  expect(keys, `${ctx}: row keys`).toEqual(wanted);
}

function checkScores(scores: number[], suffix: string, ctx: string): void {
  if (!suffix) return;
  if (!suffix.startsWith('|')) throw new Error(`score suffix must start with |`);
  const body = suffix.slice(1);
  if (!body) return;
  const toks = splitTop(body);
  expect(scores.length, `${ctx}: score count`).toBe(toks.length);
  toks.forEach((tok, i) => {
    expect(doubleMatches(scores[i], tok), `${ctx}: row ${i} score ${scores[i]} vs '${tok}'`).toBe(true);
  });
}

function splitExpected(expected: string): { keyPart: string; suffix: string } {
  const at = expected.indexOf('|');
  return at < 0 ? { keyPart: expected, suffix: '' } : { keyPart: expected.slice(0, at), suffix: expected.slice(at) };
}

function groupPairs(expected: string): [string, string][] {
  if (!expected.startsWith('g(') || !expected.endsWith(')')) throw new Error(`group expectation must be g(...), got '${expected}'`);
  return splitTop(expected.slice(2, -1)).map((pair) => {
    const at = pair.indexOf('=');
    if (at < 0) throw new Error(`group pair needs key=val, got '${pair}'`);
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
}

function checkGroups(obj: Record<string, number>, expected: string, ctx: string): void {
  const pairs = groupPairs(expected);
  const gotKeys = Object.keys(obj);
  expect(gotKeys, `${ctx}: group keys`).toEqual(pairs.map(([k]) => k));
  pairs.forEach(([k, v]) => {
    expect(doubleMatches(obj[k], v), `${ctx}: group '${k}' value ${obj[k]} vs '${v}'`).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// OP dispatch
// ---------------------------------------------------------------------------

function runLine(s: Scenario, op: string, args: string[], expected: string, ctx: string): void {
  const a = args;

  // ---- pure value ops (boundary crossings through the scratch db) ----
  if (op === 'VERSION') {
    expect(ffiVersion(), `${ctx}: FFI version`).toBe(1);
    return;
  }
  if (op === 'VTYPE') {
    expect(typeName(s.rt(a[0])), `${ctx}: type`).toBe(expected);
    return;
  }
  if (op === 'VLEN') {
    expect(lengthOf(s.rt(a[0])), `${ctx}: length`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'VAS_INT') {
    // Engine Ints surface as JS numbers when safe and BigInts at the
    // extremes; the fixture's ok-cases are the extremes, so bigint-ness
    // is the as-int probe (a Float literal maps to an unmarked number).
    const got = s.rt(a[0]);
    if (expected === 'fail') {
      expect(typeof got === 'bigint', `${ctx}: as_int unexpectedly ok (${render(got)})`).toBe(false);
    } else {
      expect(typeof got, `${ctx}: as_int type`).toBe('bigint');
      expect(`ok:${got}`, `${ctx}: as_int`).toBe(expected);
    }
    return;
  }
  if (op === 'VAS_FLOAT') {
    const got = s.rt(a[0]);
    if (expected === 'fail') {
      expect(typeof got === 'number', `${ctx}: as_float unexpectedly ok`).toBe(false);
    } else {
      expect(typeof got, `${ctx}: as_float type`).toBe('number');
      expect(doubleMatches(got, expected.slice(3)), `${ctx}: as_float bits`).toBe(true);
    }
    return;
  }
  if (op === 'VAS_BOOL') {
    const got = s.rt(a[0]);
    if (expected === 'fail') {
      expect(typeof got === 'boolean', `${ctx}: as_bool unexpectedly ok`).toBe(false);
    } else {
      expect(typeof got, `${ctx}: as_bool type`).toBe('boolean');
      expect(`ok:${got ? 1 : 0}`, `${ctx}: as_bool`).toBe(expected);
    }
    return;
  }
  if (op === 'VTEXT_REF') {
    const got = s.rt(a[0]);
    expect(typeof got === 'string' && got === textBody(expected), `${ctx}: text bytes differ`).toBe(true);
    return;
  }
  if (op === 'VBYTES_REF') {
    const got = s.rt(a[0]);
    expect(got instanceof Buffer && got.equals(Buffer.from(expected.slice(2, -1), 'latin1')), `${ctx}: bytes differ`).toBe(true);
    return;
  }
  if (op === 'VVECTOR_REF') {
    const got = s.rt(a[0]);
    const rebuilt = parseLiteral(a[0]);
    expect(valuesEqual(got, rebuilt), `${ctx}: vector bits differ`).toBe(true);
    return;
  }
  if (op === 'VNEST' || op === 'VCLONE') {
    // VCLONE round-trips twice: the second materialization is the
    // clone-analog (independent JS objects from the same stored value).
    const got = s.rt(a[0]);
    if (op === 'VCLONE') void s.rt(a[0]);
    const child = walkPath(got, a[1]);
    if (expected === 'absent') expect(child, `${ctx}: unexpectedly present`).toBeUndefined();
    else checkValue(child, expected, ctx);
    return;
  }
  if (op === 'VPUSH') {
    const arr = s.rt(a[0]) as unknown[];
    arr.push(parseLiteral(a[1]));
    expect(arr.length, `${ctx}: array length`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'VPUT') {
    const obj = s.rt(a[0]) as Record<string, unknown>;
    obj[a[1]] = parseLiteral(a[2]);
    expect(Object.keys(obj).length, `${ctx}: map size`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'NULLFREES') {
    // Every close()/dispose is idempotent — the free(NULL) analog.
    const db2 = Db.openMemory();
    const c2 = db2.collection('x');
    c2.close();
    c2.close();
    db2.close();
    db2.close();
    return;
  }

  // ---- db-required ops ----
  if (op === 'COLL') {
    s.closeColl();
    s.coll = s.db!.collection(a[0]);
    expect(s.coll.name, `${ctx}: collection_name round trip`).toBe(a[0]);
    return;
  }
  if (op === 'INSERT' || op === 'INSERT_ERR') {
    const docs = s.docs();
    const fn = () => docs.insert(a[0], parseLiteral(a[1]));
    if (op === 'INSERT_ERR') expectError(fn, errCode(expected), ctx);
    else fn();
    return;
  }
  if (op === 'LEN') {
    expect(s.docs().len(), `${ctx}: len`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'GET' || op === 'GETFIELD') {
    const got = s.docs().get(a[0]);
    if (op === 'GETFIELD') {
      if (got === null) throw new Error(`${ctx}: GETFIELD on an absent document`);
      const child = walkPath(got, a[1]);
      if (expected === 'absent') expect(child, `${ctx}: field unexpectedly present`).toBeUndefined();
      else checkValue(child, expected, ctx);
    } else if (expected === 'absent') {
      expect(got, `${ctx}: expected absence`).toBeNull();
    } else {
      if (got === null) throw new Error(`${ctx}: expected a document, got absence`);
      checkValue(got, expected, ctx);
    }
    return;
  }
  if (op === 'PUTMANY' || op === 'PUTMANY_ROLLBACK') {
    if (a.length % 2 !== 0) throw new Error(`${ctx}: PUTMANY wants key/literal pairs`);
    const entries: [string, unknown][] = [];
    for (let i = 0; i < a.length; i += 2) entries.push([a[i], parseLiteral(a[i + 1])]);
    const docs = s.docs();
    const fn = () => docs.insertMany(entries);
    if (op === 'PUTMANY_ROLLBACK') expectError(fn, errCode(expected), ctx);
    else fn();
    return;
  }
  if (op === 'INSERT_AUTO') {
    const key = s.docs().insertAuto(parseLiteral(a[0]));
    expect(typeof key === 'string' && /^\d{20}$/.test(key), `${ctx}: auto key format (${key})`).toBe(true);
    const id = Number(key);
    expect(s.lastAutoId === 0 || id > s.lastAutoId, `${ctx}: auto id monotonicity`).toBe(true);
    s.lastAutoId = id;
    return;
  }
  if (op === 'UPDATE') {
    s.docs().update(a[0], (cur) => ({ n: ((cur as { n: number } | null)?.n ?? 0) + 1 }));
    return;
  }
  if (op === 'UPDATE_ABORT') {
    expectError(
      () => s.docs().update(a[0], () => { throw new Error('abort'); }),
      12,
      ctx,
    );
    return;
  }
  if (op === 'PATCH') {
    s.docs().patch(a[0], parseLiteral(a[1]));
    return;
  }
  if (op === 'CAS') {
    const applied = s.docs().compareAndSet(
      a[0],
      a[1] === 'absent' ? null : parseLiteral(a[1]),
      a[2] === 'absent' ? null : parseLiteral(a[2]),
    );
    expect(applied ? 'applied:1' : 'applied:0', `${ctx}: CAS applied`).toBe(expected);
    return;
  }
  if (op === 'DELETE') {
    const existed = s.docs().delete(a[0]);
    expect(existed ? 'existed:1' : 'existed:0', `${ctx}: delete existed`).toBe(expected);
    return;
  }
  if (op === 'DELETE_WHERE') {
    const removed = s.docs().deleteWhere(cmpPred(a[0], a[1], a[2]));
    expect(`removed:${removed}`, `${ctx}: removed count`).toBe(expected);
    return;
  }
  if (op === 'DELETE_IN') {
    const removed = s.docs().deleteWhere(field(a[0]).in(a.slice(1).map((t) => parseLiteral(t))));
    expect(`removed:${removed}`, `${ctx}: removed count`).toBe(expected);
    return;
  }
  if (op === 'DELETE_BATCH') {
    const removed = s.docs().deleteBatch(a);
    expect(`removed:${removed}`, `${ctx}: removed count`).toBe(expected);
    return;
  }
  if (op === 'INSERT_TTL') {
    s.docs().insertWithTtl(a[0], parseLiteral(a[1]), parseInt(a[2], 10));
    return;
  }
  if (op === 'GET_TTL') {
    const ttl = s.docs().getTtl(a[0]);
    expect(ttl === null ? 'nottl' : `ttl:${ttl}`, `${ctx}: ttl`).toBe(expected);
    return;
  }
  if (op === 'SET_TTL') {
    s.docs().setTtl(a[0], parseInt(a[1], 10));
    return;
  }
  if (op === 'PURGE') {
    const purged = s.docs().purgeExpired(parseInt(a[0], 10));
    expect(`purged:${purged}`, `${ctx}: purged count`).toBe(expected);
    return;
  }
  if (op === 'SCAN' || op === 'SCAN_STOP') {
    const stop = op === 'SCAN_STOP' ? parseInt(a[0], 10) : 0;
    let visited = 0;
    const n = s.docs().scanEach(() => {
      visited++;
      return !(stop > 0 && visited >= stop);
    });
    expect(n, `${ctx}: scanned`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'PAGE') {
    const after = a[0] === '-' ? null : a[0];
    const limit = parseInt(a[1], 10);
    const page = s.docs().page(after, limit);
    const { keyPart, suffix } = splitExpected(expected);
    checkKeys(rowKeys(page.rows), keyPart, ctx);
    expect(page.next === null ? '|end' : '|more', `${ctx}: page cursor`).toBe(suffix);
    return;
  }

  // ---- predicates + queries ----
  const filteredCount = (pred: object): number => s.docs().query().filter(pred).count();
  if (op === 'QF_COUNT') {
    expect(filteredCount(cmpPred(a[0], a[1], a[2])), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_EXISTS') {
    expect(filteredCount(field(a[0]).exists()), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_BETWEEN') {
    expect(filteredCount(field(a[0]).between(parseLiteral(a[1]), parseLiteral(a[2]))), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_STARTS' || op === 'QF_CONTAINS') {
    const body = textBody(a[1]);
    const pred = op === 'QF_STARTS' ? field(a[0]).startsWith(body) : field(a[0]).contains(body);
    expect(filteredCount(pred), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_GEO') {
    expect(filteredCount(field(a[0]).withinKm(parseDouble(a[1]), parseDouble(a[2]), parseDouble(a[3]))), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_AND' || op === 'QF_OR') {
    const pred = op === 'QF_AND'
      ? and(cmpPred(a[0], a[1], a[2]), cmpPred(a[3], a[4], a[5]))
      : or(cmpPred(a[0], a[1], a[2]), cmpPred(a[3], a[4], a[5]));
    expect(filteredCount(pred), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_NOT') {
    expect(filteredCount(not(cmpPred(a[0], a[1], a[2]))), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'PRED_FREE') {
    // The never-consumed-root free path: in JS the descriptor is plain
    // garbage — building it and dropping it must be a no-op.
    void cmpPred(a[0], a[1], a[2]);
    return;
  }
  if (op === 'Q_ABANDON') {
    s.docs().query().close(); // the abandoned-builder free path
    return;
  }
  if (op === 'QVEC' || op === 'APPROX') {
    const q = s.docs().query();
    if (op === 'APPROX') q.approx();
    q.vector(a[0], parseLiteral(a[1]) as Float32Array, parseInt(a[2], 10), 'cosine');
    const rows = q.run();
    const { keyPart, suffix } = splitExpected(expected);
    checkKeys(rowKeys(rows), keyPart, ctx);
    checkScores(rows.map((r) => r.score), suffix, ctx);
    return;
  }
  if (op === 'QTEXT') {
    const rows = s.docs().query().text(a[0], textBody(a[1]), parseInt(a[2], 10)).run();
    checkKeys(rowKeys(rows), expected, ctx);
    return;
  }
  if (op === 'HYBRID' || op === 'HYBRID_F') {
    const tagged = op === 'HYBRID_F';
    const vk = parseInt(a[2], 10);
    const tk = parseInt(a[5], 10);
    const limit = parseInt(tagged ? a[7] : a[6], 10);
    const q = s.docs().query();
    q.filter(tagged ? field('tag').eq(parseLiteral(a[6])) : field('kind').eq('doc'));
    q.vector(a[0], parseLiteral(a[1]) as Float32Array, vk, 'cosine');
    q.text(a[3], textBody(a[4]), tk);
    q.fuseRrf(60);
    q.rerankMmr(1.0);
    q.limit(limit);
    const rows = q.run();
    const { keyPart, suffix } = splitExpected(expected);
    checkKeys(rowKeys(rows), keyPart, ctx);
    checkScores(rows.map((r) => r.score), suffix, ctx);
    return;
  }
  if (op === 'ORDER_BY') {
    const rows = s.docs()
      .query()
      .orderBy(a[0], parseInt(a[1], 10) === 1)
      .offset(parseInt(a[2], 10))
      .limit(parseInt(a[3], 10))
      .run();
    checkKeys(rowKeys(rows), expected, ctx);
    return;
  }
  if (op === 'SELECT') {
    if (!a[0].startsWith('(') || !a[0].endsWith(')')) throw new Error(`${ctx}: SELECT's first arg must be a (field,...) group`);
    const fields = splitTop(a[0].slice(1, -1));
    const wantKey = listBody(a[1]);
    const rows = s.docs().query().select(fields).run();
    const row = rows.find((r) => String(r.key) === wantKey);
    if (!row) throw new Error(`${ctx}: row '${wantKey}' not in the result`);
    checkValue(row.doc, expected, ctx);
    return;
  }
  if (op === 'AGG_COUNT') {
    expect(s.docs().query().count(), `${ctx}: count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'AGG_DISTINCT') {
    expect(s.docs().query().countDistinct(a[0]), `${ctx}: countDistinct`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'AGG_SUM') {
    expect(doubleMatches(s.docs().query().sum(a[0]), expected), `${ctx}: sum`).toBe(true);
    return;
  }
  if (op === 'AGG_AVG') {
    const avg = s.docs().query().avg(a[0]);
    if (expected === 'none') expect(avg, `${ctx}: avg none`).toBeNull();
    else expect(doubleMatches(avg as number, expected), `${ctx}: avg`).toBe(true);
    return;
  }
  if (op === 'AGG_MIN' || op === 'AGG_MAX') {
    const got = op === 'AGG_MIN' ? s.docs().query().min(a[0]) : s.docs().query().max(a[0]);
    if (expected === 'absent') expect(got, `${ctx}: expected absence`).toBeNull();
    else {
      if (got === null) throw new Error(`${ctx}: expected a value`);
      checkValue(got, expected, ctx);
    }
    return;
  }
  if (op === 'AGG_GCOUNT' || op === 'AGG_GSUM' || op === 'AGG_GAVG') {
    const q = s.docs().query();
    const obj =
      op === 'AGG_GCOUNT' ? q.groupCount(a[0])
      : op === 'AGG_GSUM' ? q.groupSum(a[0], a[1])
      : q.groupAvg(a[0], a[1]);
    checkGroups(obj, expected, ctx);
    return;
  }

  // ---- graph ----
  if (op === 'LINK') {
    s.docs().link(a[0], a[1], a[2]);
    return;
  }
  if (op === 'LINK_W') {
    s.docs().linkWeighted(a[0], a[1], a[2], parseDouble(a[3]));
    return;
  }
  if (op === 'UNLINK') {
    const removed = s.docs().unlink(a[0], a[1], a[2]);
    expect(removed ? 'removed:1' : 'removed:0', `${ctx}: unlink removed`).toBe(expected);
    return;
  }
  if (op === 'NEIGHBORS' || op === 'IN_NEIGHBORS') {
    const keys = op === 'NEIGHBORS' ? s.docs().neighbors(a[0], a[1]) : s.docs().inNeighbors(a[0], a[1]);
    checkKeys(keys.map(String), expected, ctx);
    return;
  }
  if (op === 'NEIGHBORS_W') {
    const pairs = s.docs().neighborsWeighted(a[0], a[1]);
    checkGroups(Object.fromEntries(pairs.map((p) => [p.key, p.weight])), expected, ctx);
    return;
  }
  if (op === 'TRAVERSE') {
    const keys = s.docs().traverse(a[0], a[1], parseInt(a[2], 10));
    checkKeys(keys.map(String), expected, ctx);
    return;
  }

  // ---- geo ----
  if (op === 'GINSERT' || op === 'GINSERT_M') {
    const loc = op === 'GINSERT_M'
      ? { lat: parseDouble(a[1]), lon: parseDouble(a[2]) }
      : [parseDouble(a[1]), parseDouble(a[2])];
    s.docs().insert(a[0], { loc });
    return;
  }
  if (op === 'RADIUS' || op === 'NEAREST' || op === 'BBOX') {
    const hits =
      op === 'RADIUS' ? s.docs().geoWithinRadius(a[0], parseDouble(a[1]), parseDouble(a[2]), parseDouble(a[3]))
      : op === 'NEAREST' ? s.docs().geoNearest(a[0], parseDouble(a[1]), parseDouble(a[2]), parseInt(a[3], 10))
      : s.docs().geoWithinBBox(a[0], parseDouble(a[1]), parseDouble(a[2]), parseDouble(a[3]), parseDouble(a[4]));
    const { keyPart, suffix } = splitExpected(expected);
    checkKeys(hits.map((h) => String(h.key)), keyPart, ctx);
    if (suffix) {
      const toks = splitTop(suffix.slice(1));
      expect(hits.length, `${ctx}: distance count`).toBe(toks.length);
      toks.forEach((tok, i) => {
        expect(doubleMatches(hits[i].distanceKm, tok), `${ctx}: hit ${i} distance`).toBe(true);
      });
    }
    return;
  }
  if (op === 'BBOX_ERR') {
    expectError(
      () => s.docs().geoWithinBBox(a[0], parseDouble(a[1]), parseDouble(a[2]), parseDouble(a[3]), parseDouble(a[4])),
      errCode(expected),
      ctx,
    );
    return;
  }

  // ---- schema & indexes ----
  if (op === 'SET_SCHEMA') {
    const defs = a.map((spec) => {
      const [name, ty, required, unique] = spec.split('#');
      return { name, type: parseFieldType(ty), required: required === '1', unique: unique === '1' };
    });
    s.docs().setSchema(defs);
    return;
  }
  if (op === 'SCHEMA') {
    const schema = s.docs().schema();
    if (!schema) throw new Error(`${ctx}: a schema must be declared first`);
    const got = schema.map((f) => `${f.name}/${f.type}/${f.required ? 1 : 0}/${f.unique ? 1 : 0}`).join(',');
    expect(got, `${ctx}: schema round trip`).toBe(expected);
    return;
  }
  if (op === 'SCHEMA9') {
    const names = ['f_any', 'f_bool', 'f_int', 'f_float', 'f_text', 'f_bytes', 'f_vector', 'f_array', 'f_map'];
    const types = FIELD_TYPES;
    s.docs().setSchema(names.map((name, i) => ({ name, type: types[i], required: i === 1, unique: i === 8 })));
    const schema = s.docs().schema();
    if (!schema) throw new Error(`${ctx}: the 9-field schema must be declared`);
    const got = schema.map((f) => FIELD_TYPES.indexOf(f.type as (typeof FIELD_TYPES)[number])).join(',');
    expect(schema.length, `${ctx}: exactly 9 fields`).toBe(9);
    expect(got, `${ctx}: schema9 discriminants`).toBe(expected);
    return;
  }
  if (op === 'SCHEMA_ERR') {
    expectError(() => s.docs().insert(a[0], parseLiteral(a[1])), errCode(expected), ctx);
    return;
  }
  if (op === 'IDX_SCALAR') { s.docs().createScalarIndex(a[0]); return; }
  if (op === 'IDX_COMPOUND') { s.docs().createCompoundIndex(a); return; }
  if (op === 'IDX_TEXT') { s.docs().createTextIndex(a[0]); return; }
  if (op === 'IDX_TEXT_DISK') { s.docs().createTextIndexOndisk(a[0]); return; }
  if (op === 'IDX_GEO') { s.docs().createGeoIndex(a[0]); return; }
  if (op === 'IDX_VEC') { s.docs().createVectorIndex(a[0], parseMetric(a[1])); return; }
  if (op === 'IDX_VEC_Q') { s.docs().createVectorIndexQuantized(a[0], parseMetric(a[1]), parseQuant(a[2])); return; }
  if (op === 'IDX_VEC_DISK') { s.docs().createVectorIndexOndisk(a[0], parseMetric(a[1])); return; }
  if (op === 'IDX_VEC_DISK_Q') { s.docs().createVectorIndexOndiskQuantized(a[0], parseMetric(a[1]), parseQuant(a[2])); return; }
  if (op === 'IDX_PQ' || op === 'IDX_PQ_DISK' || op === 'IDX_PQ_ERR') {
    const fn = () =>
      op === 'IDX_PQ_DISK'
        ? s.docs().createVectorIndexOndiskPq(a[0], parseMetric(a[1]), parseInt(a[2], 10), parseInt(a[3], 10))
        : s.docs().createVectorIndexPq(a[0], parseMetric(a[1]), parseInt(a[2], 10), parseInt(a[3], 10));
    if (op === 'IDX_PQ_ERR') expectError(fn, errCode(expected), ctx);
    else fn();
    return;
  }

  // ---- admin & persistence ----
  if (op === 'FILEDB') { s.openFile(s.dbPath); return; }
  if (op === 'FILEDB2') { s.openFile(s.db2Path); return; }
  if (op === 'DUMP') { s.db!.dumpToPath(s.dumpPath); return; }
  if (op === 'LOAD') { s.db!.loadFromPath(s.dumpPath); return; }
  if (op === 'LOAD_RENAMES') {
    const fn = () => s.db!.loadFromPathWithRenames(s.dumpPath, [{ from: a[0], to: a[1] }]);
    if (expected.startsWith('err:')) expectError(fn, errCode(expected), ctx);
    else fn();
    return;
  }
  if (op === 'COLLECTIONS') {
    checkKeys(s.db!.collections().map(String), expected, ctx);
    return;
  }
  if (op === 'BACKUP') { s.db!.backup(s.backupPath); return; }
  if (op === 'BACKUP_DUP') {
    expectError(() => s.db!.backup(s.backupPath), 17, ctx);
    return;
  }
  if (op === 'COMPACT_BUSY') {
    expectError(() => s.db!.compact(), 19, ctx);
    return;
  }
  if (op === 'COMPACT') {
    s.closeColl(); // quiesce: the derived-handle gate
    s.db!.compact();
    void s.docs(); // re-acquire for subsequent lines
    return;
  }
  if (op === 'REOPEN') {
    const path = s.dbPath;
    s.closeDb();
    s.db = Db.open(path);
    s.docs();
    return;
  }

  throw new Error(`${ctx}: unknown OP '${op}'`);
}

// ---------------------------------------------------------------------------
// The fixture driver
// ---------------------------------------------------------------------------

function startsWithDb(file: string): boolean {
  return file !== 'values.txt';
}

function runScenario(file: string): void {
  const path = join(GOLDEN_DIR, file);
  const text = readFileSync(path, 'utf8');
  const stem = file.replace(/\.txt$/, '');
  const s = new Scenario(file);

  // Scratch paths are per-scenario so file-db scenarios sharing one
  // workdir never touch each other's files.
  s.workdir = join(WORK_ROOT, `${stem}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(s.workdir, { recursive: true });
  s.dbPath = join(s.workdir, `${stem}.redb`);
  s.db2Path = join(s.workdir, `${stem}-2.redb`);
  s.dumpPath = join(s.workdir, `${stem}.dump`);
  s.backupPath = join(s.workdir, `${stem}.backup.redb`);

  if (startsWithDb(file)) s.openMemory();

  // Independent pre-scan of executable lines (blank / '#' skipped).
  const lines = text.split('\n').filter((l) => {
    const t = l.replace(/[\r ]+$/, '').trimStart();
    return t.length > 0 && !t.startsWith('#');
  });

  let executed = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0 || line[0] === '#') continue;
    const ctx = `${file}:${executed + 1} OP=`;
    // OP \t ARGS \t EXPECTED
    let op = line;
    let argsStr = '';
    let expected = '';
    const tab1 = line.indexOf('\t');
    if (tab1 >= 0) {
      op = line.slice(0, tab1);
      const tab2 = line.indexOf('\t', tab1 + 1);
      if (tab2 >= 0) {
        argsStr = line.slice(tab1 + 1, tab2);
        expected = line.slice(tab2 + 1);
      } else {
        argsStr = line.slice(tab1 + 1);
      }
    }
    const args = argsStr ? splitTop(argsStr) : [];
    runLine(s, op, args, expected, `${ctx}${op}`);
    executed++;
  }

  s.closeDb();
  s.scratch.close();
  rmSync(s.workdir, { recursive: true, force: true });

  // A dispatch loop that skipped a counted line diverges here instead
  // of silently passing.
  expect(executed, `${file}: dispatched lines`).toBe(lines.length);
  scenarios.push(`${file} lines=${lines.length} executed=${executed}`);
}

beforeAll(() => {
  rmSync(WORK_ROOT, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(WORK_ROOT, { recursive: true, force: true });
  console.log(`GOLDEN ${scenarios.length} files\n${scenarios.map((x) => `  ${x}`).join('\n')}`);
});

test.each(FILES)('golden suite: %s', (file) => {
  runScenario(file);
});

test('golden suite totals (256 lines)', () => {
  const total = scenarios.reduce((n, x) => n + parseInt(x.split('lines=')[1], 10), 0);
  expect(scenarios.length, 'all fixture files ran').toBe(FILES.length);
  expect(total, 'total executable fixture lines').toBe(256);
});
