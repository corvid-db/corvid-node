'use strict';

/**
 * corvid-node — the idiomatic OOP surface over the native engine
 * binding (docs/PLAN.md §3): `Db`, `Collection`, `Query` fluent
 * builder, `field()` predicate builders, `CorvidError`.
 *
 * This file also resolves the platform binary: the local build in
 * development, the `@corvid/node-<platform>` optional dependency when
 * installed from npm.
 */

const fs = require('node:fs');
const path = require('node:path');

// -- platform resolution ---------------------------------------------------

// Platform keys and package names follow @napi-rs/cli's conventions
// (the `napi artifacts`/`napi publish` pipeline produces exactly these).
const PLATFORM_MODULES = {
  'darwin-x64': 'corvid-node-darwin-x64',
  'darwin-arm64': 'corvid-node-darwin-arm64',
  'linux-x64-gnu': 'corvid-node-linux-x64-gnu',
  'linux-x64-musl': 'corvid-node-linux-x64-musl',
  'linux-arm64-gnu': 'corvid-node-linux-arm64-gnu',
  'linux-arm64-musl': 'corvid-node-linux-arm64-musl',
  'win32-x64-msvc': 'corvid-node-win32-x64-msvc',
};

function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    return require('child_process')
      .execSync('ldd --version', { encoding: 'utf8' })
      .includes('musl');
  } catch {
    return false;
  }
}

function platformKey() {
  const { platform, arch } = process;
  if (platform === 'win32') return 'win32-x64-msvc';
  if (platform === 'darwin') return `darwin-${arch}`;
  return `linux-${arch}-${isMusl() ? 'musl' : 'gnu'}`;
}

function loadNative() {
  // 0. An explicit override (tests, exotic layouts).
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
    return require(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
  }
  const key = platformKey();
  // 1. A sibling binary built locally (`npm run build`) — named by napi's
  // binaryName (index-native), never `index.*` (that is THIS file).
  const local = path.join(__dirname, `index-native.${key}.node`);
  if (fs.existsSync(local)) {
    return require(local);
  }
  // 2. The optionalDependency for this platform.
  const pkg = PLATFORM_MODULES[key];
  if (pkg) {
    try {
      return require(pkg);
    } catch {
      /* fall through to the error below */
    }
  }
  throw new Error(
    `corvid-node: no native binary for ${key}. ` +
      'Build locally with `npm run build` (requires Rust + a C toolchain) ' +
      'or install the platform package as an optionalDependency.',
  );
}

const native = loadNative();

// -- errors ------------------------------------------------------------------

/** Engine error codes (the C ABI's frozen `corvid_err` table). */
const ErrorCode = Object.freeze({
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
  Busy: 19,
});

/**
 * Every engine failure surfaces as a `CorvidError` carrying the C-ABI
 * error code (`e.code`, see {@link ErrorCode}) and the engine message.
 */
class CorvidError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'CorvidError';
    this.code = code;
  }
}

// The native layer throws plain napi Errors whose message carries the
// code as JSON (napi-rs cannot attach properties to thrown errors).
function toCorvidError(e) {
  if (e instanceof CorvidError) return e;
  try {
    const wire = JSON.parse(e.message);
    if (wire && typeof wire.corvidCode === 'number') {
      return new CorvidError(wire.corvidCode, String(wire.corvidMessage ?? ''));
    }
  } catch {
    /* not our wire form */
  }
  return e;
}

function call(fn, thisArg, args) {
  try {
    return fn.apply(thisArg, args);
  } catch (e) {
    throw toCorvidError(e);
  }
}

// -- typed floats --------------------------------------------------------------

/**
 * The value mapping sends integer-valued JS numbers to engine Ints
 * (`2` → Int). `CorvidFloat` forces the engine Float kind — the corner
 * where the distinction is observable: compare-and-set / unique
 * equality against stored `-0.0`-typed floats, and group-aggregation
 * key tags (`f:2` vs `i:2`).
 */
class CorvidFloat extends Number {
  /** @param {number} value */
  constructor(value) {
    super(value);
    /** Internal marker consumed by the native mapping. */
    this.__corvidFloat = Number(value);
  }
}

// -- predicates ---------------------------------------------------------------

/**
 * Build a predicate over a (dotted) field path. Compose with
 * {@link and}/{@link or}/{link not}: `and(field('n').gt(2), field('tag').eq('x'))`.
 *
 * @param {string} path
 */
function field(path) {
  if (typeof path !== 'string') throw new CorvidError(ErrorCode.InvalidArgument, 'field() wants a dotted path string');
  return {
    eq: (value) => ({ op: 'cmp', path, cmp: 'eq', value }),
    ne: (value) => ({ op: 'cmp', path, cmp: 'ne', value }),
    lt: (value) => ({ op: 'cmp', path, cmp: 'lt', value }),
    le: (value) => ({ op: 'cmp', path, cmp: 'le', value }),
    gt: (value) => ({ op: 'cmp', path, cmp: 'gt', value }),
    ge: (value) => ({ op: 'cmp', path, cmp: 'ge', value }),
    exists: () => ({ op: 'exists', path }),
    in: (values) => ({ op: 'in', path, values }),
    between: (low, high) => ({ op: 'between', path, low, high }),
    startsWith: (prefix) => ({ op: 'startsWith', path, prefix }),
    contains: (substring) => ({ op: 'contains', path, substring }),
    withinKm: (lat, lon, radiusKm) => ({ op: 'geoWithin', path, lat, lon, radiusKm }),
  };
}

/** Logical AND of predicates. @param {...object} preds */
function and(...preds) {
  if (preds.length === 0) throw new CorvidError(ErrorCode.InvalidArgument, 'and() needs at least one predicate');
  return { op: 'and', children: preds };
}

/** Logical OR of predicates. @param {...object} preds */
function or(...preds) {
  if (preds.length === 0) throw new CorvidError(ErrorCode.InvalidArgument, 'or() needs at least one predicate');
  return { op: 'or', children: preds };
}

/** Logical NOT of a predicate. @param {object} pred */
function not(pred) {
  return { op: 'not', child: pred };
}

// -- Db ------------------------------------------------------------------------

/** A database handle. File-backed via {@link Db.open}, in-memory via {@link Db.openMemory}. */
class Db {
  #node;

  /** @private */
  constructor(node) {
    this.#node = node;
  }

  /** Open (or create) a file-backed database at `path`. */
  static open(path) {
    return new Db(call((p) => new native.DbNode(p), null, [path]));
  }

  /** Open a private, in-memory database. */
  static openMemory() {
    return new Db(call(() => new native.DbNode(null), null, []));
  }

  /** Acquire a collection handle (lazily created by the engine on first write). */
  collection(name) {
    return new Collection(call(this.#node.collection, this.#node, [name]));
  }

  /** The names of the database's collections. */
  collections() {
    return call(this.#node.collections, this.#node, []);
  }

  /** Copy the database to `path` (which must not already exist). */
  backup(path) {
    call(this.#node.backup, this.#node, [path]);
  }

  /**
   * Compact the database file. Requires quiescence: every Collection /
   * Query derived from this db must be closed or executed, otherwise a
   * `Busy` CorvidError is thrown. Returns whether data was moved out.
   */
  compact() {
    return call(this.#node.compact, this.#node, []);
  }

  /** Dump the whole database (documents, indexes, schemas, TTLs, edges) to `path`. */
  dumpToPath(path) {
    call(this.#node.dumpToPath, this.#node, [path]);
  }

  /** Replay a dump file into this database (merging). */
  loadFromPath(path) {
    call(this.#node.loadFromPath, this.#node, [path]);
  }

  /**
   * Replay a dump file, renaming collections per `renames`
   * (`[{ from, to }]`); targets are validated before the stream is read.
   */
  loadFromPathWithRenames(path, renames) {
    const pairs = renames.map((r) => [r.from, r.to]);
    call(this.#node.loadFromPathWithRenames, this.#node, [path, pairs]);
  }

  /** Close the handle (idempotent). Derived handles may outlive it. */
  close() {
    call(this.#node.close, this.#node, []);
  }

  [Symbol.for('Symbol.dispose')]() {
    this.close();
  }
}

// `using` support (TS 5.2+ / explicit-resource-management runtimes).
if (typeof Symbol.dispose === 'symbol') {
  Db.prototype[Symbol.dispose] = Db.prototype[Symbol.for('Symbol.dispose')];
}

// -- Collection ------------------------------------------------------------------

/** A collection handle: mutations, reads, TTL, indexes, schema, graph, geo, queries. */
class Collection {
  #node;

  /** @private */
  constructor(node) {
    this.#node = node;
  }

  /** The collection's name. */
  get name() {
    return call(() => this.#node.name, null, []);
  }

  // mutations

  insert(key, doc) {
    call(this.#node.insert, this.#node, [key, doc]);
  }

  /** Bulk atomic insert (`put_many`): one transaction; a violating pair rolls the whole batch back. */
  insertMany(entries) {
    call(this.#node.insertMany, this.#node, [entries]);
  }

  /** Insert with an engine-generated key (20-digit, strictly monotonic per collection); returns the key. */
  insertAuto(doc) {
    return call(this.#node.insertAuto, this.#node, [doc]);
  }

  /**
   * Read-modify-write: the callback receives the current document (or
   * `null` when absent) and returns the new document — `null`/`undefined`
   * to delete. A throwing callback aborts (InvalidArgument) and writes
   * nothing. The callback must NOT call methods on this same
   * Collection: the handle's lock is non-reentrant (the FFI's portable
   * contract), so a reentrant call deadlocks.
   */
  update(key, fn) {
    call(this.#node.update, this.#node, [key, fn]);
  }

  /** Merge the top-level fields of `patch` into the document at `key` (creating it if absent). */
  patch(key, patch) {
    call(this.#node.patch, this.#node, [key, patch]);
  }

  /**
   * Atomically write `replacement` only if the current value equals
   * `expected` (`null` = must be absent; `replacement: null` deletes on
   * match). Returns whether the write was applied.
   */
  compareAndSet(key, expected, replacement) {
    return call(this.#node.compareAndSet, this.#node, [key, expected, replacement]);
  }

  /** Delete `key`; returns whether it existed. */
  delete(key) {
    return call(this.#node.delete, this.#node, [key]);
  }

  /** Delete every document matching `pred` (see {@link field}); returns the removed count. */
  deleteWhere(pred) {
    return call(this.#node.deleteWhere, this.#node, [pred]);
  }

  /** Delete a batch of keys; returns the removed count. */
  deleteBatch(keys) {
    return call(this.#node.deleteBatch, this.#node, [keys]);
  }

  // TTL

  /** Insert with an expiry instant (`expiresAt`, epoch units of your choosing). */
  insertWithTtl(key, doc, expiresAt) {
    call(this.#node.insertWithTtl, this.#node, [key, doc, expiresAt]);
  }

  /** Set (or clear, with `null`) the expiry for an existing key. */
  setTtl(key, expiresAt) {
    call(this.#node.setTtl, this.#node, [key, expiresAt]);
  }

  /** The key's expiry instant, or `null` when it has no TTL. */
  getTtl(key) {
    return call(this.#node.getTtl, this.#node, [key]);
  }

  /** Remove every expired key as of `now`; returns the purged count. */
  purgeExpired(now) {
    return call(this.#node.purgeExpired, this.#node, [now]);
  }

  // reads

  /** The document at `key`, or `null` when absent. */
  get(key) {
    return call(this.#node.get, this.#node, [key]);
  }

  /** Every `{ key, doc }` in key order. */
  scan() {
    return call(() => this.#node.scanRows().map(([key, doc]) => ({ key, doc })), null, []);
  }

  /**
   * Stream with a callback `(key, doc) => boolean` — returning `false`
   * stops the walk early (not an error). Returns the rows visited.
   * The callback must NOT call methods on this same Collection: the
   * handle's lock is non-reentrant (the FFI's portable contract), so a
   * reentrant call deadlocks.
   */
  scanEach(cb) {
    return call(this.#node.scanCb, this.#node, [cb]);
  }

  /**
   * Keyset pagination: up to `limit` rows strictly after `after`
   * (`null` starts at the beginning). Returns
   * `{ rows: [{key, doc}], next }` — `next` is the resume cursor or
   * `null` at the end.
   */
  page(after, limit) {
    const [rows, next] = call(this.#node.page, this.#node, [after ?? null, limit]);
    return { rows: rows.map(([key, doc]) => ({ key, doc })), next };
  }

  /** The number of documents. */
  len() {
    return call(this.#node.len, this.#node, []);
  }

  /** Whether the collection is empty. */
  isEmpty() {
    return call(this.#node.isEmpty, this.#node, []);
  }

  /**
   * DIRECT positional phrase search (engine v0.3.0; no query builder):
   * documents whose `field` TEXT contains `phrase` as a consecutive,
   * in-order run of analyzed tokens — stop words collapse out of
   * adjacency (`'embedded the database'` matches `'embedded
   * database'`). Most relevant first, ties by key, up to `k` rows as
   * `{ key, doc, score }[]`; `score` is the BM25 phrase sum (not the
   * builder's fused RRF scale). `k === 0` answers `[]` — inert.
   */
  phraseSearch(field, phrase, k) {
    return call(() => this.#node.phraseSearch(field, phrase, k).map(rows), null, []);
  }

  // indexes

  createScalarIndex(field) {
    call(this.#node.createScalarIndex, this.#node, [field]);
  }

  createCompoundIndex(fields) {
    call(this.#node.createCompoundIndex, this.#node, [fields]);
  }

  createTextIndex(field) {
    call(this.#node.createTextIndex, this.#node, [field]);
  }

  createTextIndexOndisk(field) {
    call(this.#node.createTextIndexOndisk, this.#node, [field]);
  }

  createGeoIndex(field) {
    call(this.#node.createGeoIndex, this.#node, [field]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric */
  createVectorIndex(field, metric) {
    call(this.#node.createVectorIndex, this.#node, [field, metric]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric @param {'none'|'binary'|'scalar'} quant */
  createVectorIndexQuantized(field, metric, quant) {
    call(this.#node.createVectorIndexQuantized, this.#node, [field, metric, quant]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric */
  createVectorIndexOndisk(field, metric) {
    call(this.#node.createVectorIndexOndisk, this.#node, [field, metric]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric @param {'none'|'binary'|'scalar'} quant */
  createVectorIndexOndiskQuantized(field, metric, quant) {
    call(this.#node.createVectorIndexOndiskQuantized, this.#node, [field, metric, quant]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric */
  createVectorIndexPq(field, metric, m, k) {
    call(this.#node.createVectorIndexPq, this.#node, [field, metric, m, k]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric */
  createVectorIndexOndiskPq(field, metric, m, k) {
    call(this.#node.createVectorIndexOndiskPq, this.#node, [field, metric, m, k]);
  }

  // schema

  /**
   * Declare the schema: `[{ name, type, required, unique }]` with
   * `type` one of `any|bool|int|float|text|bytes|vector|array|map`.
   * Replaces any previous declaration.
   */
  setSchema(fields) {
    call(this.#node.setSchema, this.#node, [
      fields.map((f) => ({ name: f.name, ty: f.type, required: !!f.required, unique: !!f.unique })),
    ]);
  }

  /** The declared schema (`[{ name, type, required, unique }]`), or `null` when none. */
  schema() {
    const got = call(this.#node.schema, this.#node, []);
    return got === null
      ? null
      : got.map((f) => ({ name: f.name, type: f.ty, required: f.required, unique: f.unique }));
  }

  // graph

  link(from, relation, to) {
    call(this.#node.link, this.#node, [from, relation, to]);
  }

  linkWeighted(from, relation, to, weight) {
    call(this.#node.linkWeighted, this.#node, [from, relation, to, weight]);
  }

  /** Remove an edge; returns whether it existed. */
  unlink(from, relation, to) {
    return call(this.#node.unlink, this.#node, [from, relation, to]);
  }

  neighbors(from, relation) {
    return call(this.#node.neighbors, this.#node, [from, relation]);
  }

  inNeighbors(to, relation) {
    return call(this.#node.inNeighbors, this.#node, [to, relation]);
  }

  /** Weighted out-edges as `[{ key, weight }]`. */
  neighborsWeighted(from, relation) {
    return call(
      () => this.#node.neighborsWeighted(from, relation).map(([key, weight]) => ({ key, weight })),
      null,
      [],
    );
  }

  /** BFS `hops` out over `relation` (cycle-safe). */
  traverse(start, relation, hops) {
    return call(this.#node.traverse, this.#node, [start, relation, hops]);
  }

  // geo

  /** Radius search, nearest first (ties by key): `[{ key, doc, distanceKm }]`. */
  geoWithinRadius(field, lat, lon, radiusKm) {
    return call(() => this.#node.geoWithinRadius(field, lat, lon, radiusKm).map(hits), null, []);
  }

  /** Bounding-box search (key order; no center, so distances are 0). */
  geoWithinBBox(field, minLat, minLon, maxLat, maxLon) {
    return call(() => this.#node.geoWithinBbox(field, minLat, minLon, maxLat, maxLon).map(hits), null, []);
  }

  /** The `k` nearest points: `[{ key, doc, distanceKm }]`. */
  geoNearest(field, lat, lon, k) {
    return call(() => this.#node.geoNearest(field, lat, lon, k).map(hits), null, []);
  }

  // queries

  /** Begin a fluent query over this collection. */
  query() {
    return new Query(call(this.#node.query, this.#node, []));
  }

  /** Release the handle (idempotent); also runs on GC. */
  close() {
    call(this.#node.close, this.#node, []);
  }

  [Symbol.for('Symbol.dispose')]() {
    this.close();
  }
}

if (typeof Symbol.dispose === 'symbol') {
  Collection.prototype[Symbol.dispose] = Collection.prototype[Symbol.for('Symbol.dispose')];
}

function hits([key, distanceKm, doc]) {
  return { key, doc, distanceKm };
}

// -- Query -----------------------------------------------------------------------

/**
 * A fluent query builder (one per execution). Filter, add vector/text
 * sources, fuse (RRF) and rerank (MMR), then run a terminal operation:
 *
 * ```js
 * db.collection('docs')
 *   .query()
 *   .filter(field('kind').eq('doc'))
 *   .vector('v', probe, 10, 'cosine')
 *   .text('body', 'rust database', 10)
 *   .fuseRrf(60)
 *   .rerankMmr(1.0)
 *   .limit(5)
 *   .run(); // [{ key, doc, score }]
 * ```
 *
 * Terminal operations (`run` and every aggregation) consume the builder.
 */
class Query {
  #node;

  /** @private */
  constructor(node) {
    this.#node = node;
  }

  /** Restrict to documents matching `pred` (multiple filters AND together). */
  filter(pred) {
    call(this.#node.filter, this.#node, [pred]);
    return this;
  }

  /** Add a vector source over `field` (`query` is a Float32Array), contributing up to `k` candidates. */
  vector(field, query, k, metric = 'cosine') {
    call(this.#node.vector, this.#node, [field, query, k, metric]);
    return this;
  }

  /** Add a BM25 text source over `field`, contributing up to `k` candidates. */
  text(field, query, k) {
    call(this.#node.text, this.#node, [field, query, k]);
    return this;
  }

  /** Set the Reciprocal Rank Fusion constant (default 60; validated at execution). */
  fuseRrf(k) {
    call(this.#node.fuseRrf, this.#node, [k]);
    return this;
  }

  /** Rerank fused candidates for diversity (lambda in [0, 1]; validated at execution). */
  rerankMmr(lambda) {
    call(this.#node.rerankMmr, this.#node, [lambda]);
    return this;
  }

  /** Prefer index-backed approximate execution where available. */
  approx() {
    call(this.#node.approx, this.#node, []);
    return this;
  }

  limit(n) {
    call(this.#node.limit, this.#node, [n]);
    return this;
  }

  offset(n) {
    call(this.#node.offset, this.#node, [n]);
    return this;
  }

  /** Order by `field` (numbers first in value order, missing-field rows last, ties by key). */
  orderBy(field, descending = false) {
    call(this.#node.orderBy, this.#node, [field, descending]);
    return this;
  }

  /** Project results to the named top-level fields. */
  select(fields) {
    call(this.#node.select, this.#node, [fields]);
    return this;
  }

  /** Execute; rows as `{ key, doc, score }[]` (score 0 for pure filter/order queries). */
  run() {
    return call(() => this.#node.run().map(rows), null, []);
  }

  /** Count matching documents (sources/ranking/limit ignored). */
  count() {
    return call(this.#node.count, this.#node, []);
  }

  countDistinct(field) {
    return call(this.#node.countDistinct, this.#node, [field]);
  }

  sum(field) {
    return call(this.#node.sum, this.#node, [field]);
  }

  /** The filtered mean, or `null` when no document has the field. */
  avg(field) {
    return call(this.#node.avg, this.#node, [field]);
  }

  min(field) {
    return call(this.#node.min, this.#node, [field]);
  }

  max(field) {
    return call(this.#node.max, this.#node, [field]);
  }

  /**
   * Group counts; the returned object's keys are the engine's group-key
   * formatting (text bare, int/float type-tagged `i:1` / `f:0.5`),
   * in ascending order — `Object.keys()`/entries preserve that order,
   * except that array-index-like text keys (e.g. `42`) are hoisted to
   * the front by JS numeric-key ordering; lookups by key are
   * unaffected.
   */
  groupCount(field) {
    return call(() => Object.fromEntries(this.#node.groupCount(field)), null, []);
  }

  groupSum(groupField, valueField) {
    return call(() => Object.fromEntries(this.#node.groupSum(groupField, valueField)), null, []);
  }

  groupAvg(groupField, valueField) {
    return call(() => Object.fromEntries(this.#node.groupAvg(groupField, valueField)), null, []);
  }

  /** Abandon the builder without executing. */
  close() {
    call(this.#node.close, this.#node, []);
  }

  [Symbol.for('Symbol.dispose')]() {
    this.close();
  }
}

if (typeof Symbol.dispose === 'symbol') {
  Query.prototype[Symbol.dispose] = Query.prototype[Symbol.for('Symbol.dispose')];
}

function rows([key, doc, score]) {
  return { key, doc, score };
}

// -- exports ---------------------------------------------------------------

module.exports = {
  Db,
  Collection,
  Query,
  CorvidError,
  CorvidFloat,
  ErrorCode,
  field,
  and,
  or,
  not,
  ffiVersion: () => call(native.ffiVersion, null, []),
};
