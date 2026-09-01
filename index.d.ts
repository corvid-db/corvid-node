/**
 * corvid-node — public types for the idiomatic OOP surface.
 *
 * Value mapping (JS ↔ engine):
 * - `null`/`undefined` ↔ Null; `boolean` ↔ Bool; `string` ↔ Text
 * - `number` ↔ Int when integer-valued (not `-0`, within ±2^53), else
 *   Float; `bigint` ↔ Int (full i64 range); `CorvidFloat` forces Float
 * - `Buffer`/`Uint8Array` ↔ Bytes; `Float32Array` ↔ Vector;
 *   `Array` ↔ Array; plain object ↔ Map (string keys)
 * - Reading back: Int → `number` (or `bigint` beyond ±2^53), Float →
 *   `number` — f64 bits preserved **except NaN payloads**, which V8
 *   canonicalizes at the N-API number boundary (`-0.0`, `inf`, `-inf`
 *   survive bit-exactly; vector elements keep their f32 bits).
 */

/** A dotted field path for predicate building. */
export interface FieldRef {
  eq(value: unknown): Predicate;
  ne(value: unknown): Predicate;
  lt(value: unknown): Predicate;
  le(value: unknown): Predicate;
  gt(value: unknown): Predicate;
  ge(value: unknown): Predicate;
  exists(): Predicate;
  in(values: unknown[]): Predicate;
  between(low: unknown, high: unknown): Predicate;
  startsWith(prefix: string): Predicate;
  contains(substring: string): Predicate;
  withinKm(lat: number, lon: number, radiusKm: number): Predicate;
}

/** An opaque predicate (built via {@link field}, {@link and}, {@link or}, {@link not}). */
export declare class Predicate {
  private constructor();
}

/** Engine error codes (the C ABI's frozen `corvid_err` table). */
export declare const ErrorCode: Readonly<{
  Database: 1;
  Transaction: 2;
  Table: 3;
  Storage: 4;
  Commit: 5;
  SetDurability: 6;
  Compaction: 7;
  Decode: 8;
  CorruptIndex: 9;
  ReservedCollection: 10;
  InvalidName: 11;
  InvalidArgument: 12;
  IncompatibleFormat: 13;
  EmptyIndexTraining: 14;
  SchemaViolation: 15;
  InvalidDump: 16;
  BackupTargetExists: 17;
  Io: 18;
  Busy: 19;
}>;

/** Every engine failure: `code` (see {@link ErrorCode}) + the engine message. */
export declare class CorvidError extends Error {
  readonly code: number;
}

/**
 * Forces the engine Float kind for an integer-valued double (JS `2`
 * maps to Int). The distinction is observable in compare-and-set /
 * unique equality against stored floats and in group-aggregation key
 * tags. Escape-hatch cost: a plain object whose single own key is
 * `__corvidFloat` is consumed by the marker protocol, so such an
 * object cannot itself be stored as a Map (rename the field or add a
 * second key).
 */
export declare class CorvidFloat {
  constructor(value: number);
}

export type Metric = 'cosine' | 'dot' | 'l2';
export type Quantization = 'none' | 'binary' | 'scalar';
export type FieldType =
  | 'any'
  | 'bool'
  | 'int'
  | 'float'
  | 'text'
  | 'bytes'
  | 'vector'
  | 'array'
  | 'map';

/** A document key: a string (UTF-8) or a Buffer (raw bytes). */
export type Key = string | Buffer;

export interface SchemaField {
  name: string;
  type: FieldType;
  required?: boolean;
  unique?: boolean;
}

export interface Row {
  key: Key;
  doc: any;
  score: number;
}

export interface GeoHit {
  key: Key;
  doc: any;
  distanceKm: number;
}

export interface Page {
  rows: { key: Key; doc: any }[];
  next: Key | null;
}

/** A database handle. */
export declare class Db {
  private constructor();
  /** Open (or create) a file-backed database at `path`. */
  static open(path: string): Db;
  /** Open a private, in-memory database. */
  static openMemory(): Db;
  /** Acquire a collection handle (lazily created by the engine on first write). */
  collection(name: string): Collection;
  /** The names of the database's collections. */
  collections(): string[];
  /** Copy the database to `path` (which must not already exist). */
  backup(path: string): void;
  /**
   * Compact the database file. Requires quiescence: every Collection /
   * Query derived from this db must be closed or executed, otherwise a
   * `Busy` CorvidError is thrown. Returns whether data was moved out.
   */
  compact(): boolean;
  /** Dump the whole database (documents, indexes, schemas, TTLs, edges) to `path`. */
  dumpToPath(path: string): void;
  /** Replay a dump file into this database (merging). */
  loadFromPath(path: string): void;
  /** Replay a dump file, renaming collections per `renames` (validated before the stream is read). */
  loadFromPathWithRenames(path: string, renames: { from: string; to: string }[]): void;
  /** Close the handle (idempotent). Derived handles may outlive it. */
  close(): void;
  [Symbol.dispose](): void;
}

/** A collection handle: mutations, reads, TTL, indexes, schema, graph, geo, queries. */
export declare class Collection {
  private constructor();
  get name(): string;
  insert(key: Key, doc: unknown): void;
  /** Bulk atomic insert (`put_many`): one transaction; a violating pair rolls the whole batch back. */
  insertMany(entries: [Key, unknown][]): void;
  /** Insert with an engine-generated key (20-digit, strictly monotonic per collection); returns the key. */
  insertAuto(doc: unknown): Key;
  /**
   * Read-modify-write: the callback receives the current document (or
   * `null` when absent) and returns the new document — `null` to
   * delete. A throwing callback aborts (InvalidArgument) and writes
   * nothing. The callback must NOT call methods on this same
   * Collection: the handle's lock is non-reentrant (the FFI's portable
   * contract), so a reentrant call deadlocks.
   */
  update(key: Key, fn: (current: any) => unknown): void;
  /** Merge the top-level fields of `patch` into the document at `key` (creating it if absent). */
  patch(key: Key, patch: unknown): void;
  /**
   * Atomically write `replacement` only if the current value equals
   * `expected` (`null` = must be absent; `replacement: null` deletes on
   * match). Returns whether the write was applied.
   */
  compareAndSet(key: Key, expected: unknown | null, replacement: unknown | null): boolean;
  /** Delete `key`; returns whether it existed. */
  delete(key: Key): boolean;
  /** Delete every document matching `pred`; returns the removed count. */
  deleteWhere(pred: Predicate): number;
  /** Delete a batch of keys; returns the removed count. */
  deleteBatch(keys: Key[]): number;
  insertWithTtl(key: Key, doc: unknown, expiresAt: number): void;
  setTtl(key: Key, expiresAt: number): void;
  /** The key's expiry instant, or `null` when it has no TTL. */
  getTtl(key: Key): number | null;
  /** Remove every expired key as of `now`; returns the purged count. */
  purgeExpired(now: number): number;
  /** The document at `key`, or `null` when absent. */
  get(key: Key): any;
  /** Every `{ key, doc }` in key order. */
  scan(): { key: Key; doc: any }[];
  /**
   * Stream with a callback; returning `false` stops early. Returns the
   * rows visited. The callback must NOT call methods on this same
   * Collection: the handle's lock is non-reentrant (the FFI's portable
   * contract), so a reentrant call deadlocks.
   */
  scanEach(cb: (key: Key, doc: any) => boolean | void): number;
  /** Keyset pagination: up to `limit` rows strictly after `after`. */
  page(after: Key | null, limit: number): Page;
  len(): number;
  isEmpty(): boolean;
  createScalarIndex(field: string): void;
  createCompoundIndex(fields: string[]): void;
  createTextIndex(field: string): void;
  createTextIndexOndisk(field: string): void;
  createGeoIndex(field: string): void;
  createVectorIndex(field: string, metric: Metric): void;
  createVectorIndexQuantized(field: string, metric: Metric, quant: Quantization): void;
  createVectorIndexOndisk(field: string, metric: Metric): void;
  createVectorIndexOndiskQuantized(field: string, metric: Metric, quant: Quantization): void;
  createVectorIndexPq(field: string, metric: Metric, m: number, k: number): void;
  createVectorIndexOndiskPq(field: string, metric: Metric, m: number, k: number): void;
  /** Declare the schema (replaces any previous declaration). */
  setSchema(fields: SchemaField[]): void;
  /** The declared schema, or `null` when none. */
  schema(): SchemaField[] | null;
  link(from: Key, relation: string, to: Key): void;
  linkWeighted(from: Key, relation: string, to: Key, weight: number): void;
  /** Remove an edge; returns whether it existed. */
  unlink(from: Key, relation: string, to: Key): boolean;
  neighbors(from: Key, relation: string): Key[];
  inNeighbors(to: Key, relation: string): Key[];
  neighborsWeighted(from: Key, relation: string): { key: Key; weight: number }[];
  /** BFS `hops` out over `relation` (cycle-safe). */
  traverse(start: Key, relation: string, hops: number): Key[];
  geoWithinRadius(field: string, lat: number, lon: number, radiusKm: number): GeoHit[];
  geoWithinBBox(field: string, minLat: number, minLon: number, maxLat: number, maxLon: number): GeoHit[];
  geoNearest(field: string, lat: number, lon: number, k: number): GeoHit[];
  /** Begin a fluent query over this collection. */
  query(): Query;
  /** Release the handle (idempotent); also runs on GC. */
  close(): void;
  [Symbol.dispose](): void;
}

/** A fluent query builder; terminal operations consume it. */
export declare class Query {
  private constructor();
  /** Restrict to documents matching `pred` (multiple filters AND together). */
  filter(pred: Predicate): this;
  /** Add a vector source over `field`, contributing up to `k` candidates. */
  vector(field: string, query: Float32Array, k: number, metric?: Metric): this;
  /** Add a BM25 text source over `field`, contributing up to `k` candidates. */
  text(field: string, query: string, k: number): this;
  /** Set the Reciprocal Rank Fusion constant (default 60; validated at execution). */
  fuseRrf(k: number): this;
  /** Rerank fused candidates for diversity (lambda in [0, 1]; validated at execution). */
  rerankMmr(lambda: number): this;
  /** Prefer index-backed approximate execution where available. */
  approx(): this;
  limit(n: number): this;
  offset(n: number): this;
  /** Order by `field` (numbers first in value order, missing-field rows last, ties by key). */
  orderBy(field: string, descending?: boolean): this;
  /** Project results to the named top-level fields. */
  select(fields: string[]): this;
  /** Execute; rows as `{ key, doc, score }[]` (score 0 for pure filter/order queries). */
  run(): Row[];
  /** Count matching documents (sources/ranking/limit ignored). */
  count(): number;
  countDistinct(field: string): number;
  sum(field: string): number;
  /** The filtered mean, or `null` when no document has the field. */
  avg(field: string): number | null;
  min(field: string): any;
  max(field: string): any;
  /**
   * Group counts; keys use the engine's group-key formatting (text
   * bare, int/float type-tagged `i:1` / `f:0.5`), in ascending order —
   * `Object.keys()`/entries preserve that order, except that
   * array-index-like text keys (e.g. `42`) are hoisted to the front by
   * JS numeric-key ordering; lookups by key are unaffected.
   */
  groupCount(field: string): Record<string, number>;
  groupSum(groupField: string, valueField: string): Record<string, number>;
  groupAvg(groupField: string, valueField: string): Record<string, number>;
  /** Abandon the builder without executing. */
  close(): void;
  [Symbol.dispose](): void;
}

/** Build a predicate over a dotted field path. */
export declare function field(path: string): FieldRef;
/** Logical AND of predicates. */
export declare function and(...preds: Predicate[]): Predicate;
/** Logical OR of predicates. */
export declare function or(...preds: Predicate[]): Predicate;
/** Logical NOT of a predicate. */
export declare function not(pred: Predicate): Predicate;
/** The FFI-ABI generation this binding's OOP surface covers (1). */
export declare function ffiVersion(): number;
