# corvid-node

Node.js binding for [corvid](https://github.com/corvid-db/corvid) — an
embedded database with typed values, vector/text/hybrid search, graph
edges, geo, TTL, and schemas. The engine is compiled in (a Rust napi
crate pinned to an exact corvid release tag) and exposed as idiomatic
synchronous OOP: `Db`, `Collection`, a fluent `Query` builder, and
`field()` predicates. No SQL, no JSON, no serialization on the data
path — values map natively (see the value mapping below).

Its correctness story is the engine's **golden suite**: the same
267-line fixture files the C ABI smoke harness runs are replayed
against this binding's public API on every CI run
(`test/golden.spec.ts`).

**Documentation:** the [corvid docs site](https://corvid-db.github.io/docs/)
is canonical — this binding has its own
[corvid-node page](https://corvid-db.github.io/docs/bindings/corvid-node/),
and the engine concepts behind the API (query builder semantics, indexes,
equality rules, TTL, transactions) each have a section there.

## Install

```sh
npm i corvid-node
```

Published to npm by the release workflow (`.github/workflows/release.yml`
— a tag push builds the platform matrix and publishes
`corvid-node-<platform>` then this package, docs/PLAN.md §5) via npm
trusted publishing — no registry token secret involved.

Prebuilt binaries (`optionalDependencies`) cover
`darwin-arm64` / `darwin-x64` / `linux-x64-gnu` / `linux-arm64-gnu` /
`win32-x64-msvc`. Other platforms (musl, windows-arm64) build from
source — Node ≥ 20 (CI exercises 24/22/20), Rust ≥ 1.88 + a C
toolchain:

```sh
npm run build
```

## Usage

```js
const { Db, field } = require('corvid-node');

const db = Db.open('app.redb');           // or Db.openMemory()
const docs = db.collection('docs');

docs.insert('p1', {
  title: 'rust embedded database',
  kind: 'doc',
  v: new Float32Array([1.0, 0.0]),
});

// hybrid retrieval: filter + vector + BM25, fused (RRF) + reranked (MMR)
const rows = docs
  .query()
  .filter(field('kind').eq('doc'))
  .vector('v', new Float32Array([1.0, 0.0]), 10, 'cosine')
  .text('title', 'rust database', 10)
  .fuseRrf(60)
  .rerankMmr(1.0)
  .limit(5)
  .run();                                  // [{ key, doc, score }]

for (const { key, doc, score } of rows) console.log(key, score, doc.title);

// predicates everywhere (queries and deletes)
docs.deleteWhere(field('kind').eq('draft'));

// scalar/compound/text/geo/vector indexes (incl. quantized + PQ + on-disk)
docs.createVectorIndex('v', 'cosine');

// TTL, graph, geo, schema, CAS, bulk-writes, dump/backup/compact …
docs.close();
db.close();
```

TypeScript types ship in `index.d.ts`; every failure throws a
`CorvidError` with the engine error `code` (the C ABI's frozen table,
exported as `ErrorCode`).

## Examples

Six runnable programs in [`examples/`](examples/) — one per concept,
with deterministic output, executed on every CI leg: the quickstart
(open, insert, kNN), **hybrid** (filter + vector + BM25, RRF fusion,
MMR rerank), **vector-index** (in-memory / on-disk /
binary-quantized HNSW vs exact, across a reopen), **text-search**
(BM25, English + CJK bigram segmentation), **graph**
(link/neighbors/traverse + the delete cascade), and **geo**
(radius / bbox / nearest-k over real coordinates).

```sh
npm run build && node examples/hybrid.js
```

## Value mapping

| JS | engine |
| --- | --- |
| `null`, `boolean`, `string` | Null / Bool / Text |
| `number` (integer-valued, ≤ 2^53) | Int — `2` and `2.0` collapse; `CorvidFloat(n)` forces the Float kind |
| `number` (`0.5`, `inf`, `NaN`, `-0.0`), `bigint` | Float / Int (full i64) |
| `Buffer` / `Uint8Array` | Bytes |
| `Float32Array` | Vector |
| `Array` / plain object | Array / Map |

Reading back: Int → `number` (or `bigint` beyond ±2^53), Float →
`number` with f64 bits preserved **except NaN payloads**, which V8
canonicalizes at the N-API number boundary (`-0.0`, `±inf` are exact;
vector elements keep their f32 bits). Keys are strings (UTF-8) or
Buffers. One reserved corner: the `CorvidFloat` protocol consumes any
plain object whose single own key is `__corvidFloat` — such an object
maps to a Float, not a Map (rename the field or add a second key).

## Surface manifest (docs/SURFACE.tsv)

Every construct of the engine's public surface (the radar-enforced list the
engine publishes as `scripts/bindings/surface.tsv` at each release tag) is
resolved in `docs/SURFACE.tsv`: the JS API exposing it plus the test that
proves it (golden fixture line references), or `N/A` + reason where the v1
binding deliberately does not expose it. `scripts/surface-gate.sh` fails CI
when a line is unresolved, a cell is empty, or the N/A count drifts from the
committed baseline — so an engine pin bump that changes the surface lands in
this gate, not in a user's bug report.

## Development

```sh
npm install                 # @napi-rs/cli + vitest
npm run build               # build the native binary for this platform
npm test                    # the golden suite (267 lines)
npm run lint                # cargo fmt --check + clippy -D warnings
```

The plan — architecture ruling (engine compiled in via napi vs
JS-side FFI), the full OOP surface, the value contract, and follow-up
tasks — is [docs/PLAN.md](docs/PLAN.md).

## License

MIT.
