# corvid-node — the Node.js binding plan

Date: 2026-09-01 · Status: bootstrap complete (this document) ·
Controller plan: `docs/superpowers/plans/2026-08-31-corvid-ffi.md` in
the engine repo (corvid-db/corvid).

corvid-node is the Node.js binding for
[corvid](https://github.com/corvid-db/corvid), Phase 1 of the bindings
program (alongside corvid-c). It follows the locked program rules:
**golden-suite port before ergonomic sugar**, OOP idiom gate (handles →
native classes, FFI symbols never in the public API), exact engine-tag
pinning, sync-first (the engine is sync; async variants are additive
later, decided by the FFI bench).

## 1. What shipped in this bootstrap

| Piece | Where |
| --- | --- |
| The napi crate (engine-binding layer) | `src/*.rs` — `DbNode`, `CollectionNode`, `QueryNode`, value mapping, error mapping |
| The OOP idiom layer | `index.js` — `Db`, `Collection`, `Query` (fluent), `field()`/`and`/`or`/`not`, `CorvidError`, `CorvidFloat` |
| Public types | `index.d.ts` (handwritten; the napi-generated `index-native.d.ts` is internal, gitignored) |
| The golden-suite port | `test/golden.spec.ts` driving `test/golden/*.txt` (vendored verbatim from the v0.2.1 release — the same fixtures the C smoke suite runs) |
| CI | `.github/workflows/ci.yml` — lint + build + golden suite × 4 platform legs (macos-arm64, linux-x64, linux-arm64, windows-x64; macos-x64 was retired with GitHub's macos-13 runners — no x86_64-darwin runner exists) |

The golden suite: **267/267 fixture lines** across 8 files
(values 42, mutations 70, queries 40, schema 28, graph 20, geo 19,
persist 13, admin 24), every line dispatched and every expectation
checked through the OOP surface, with the same independent pre-scan
discipline as the C harness (a skipped line diverges `executed` from
the counted total instead of silently passing).

## 2. Architecture ruling: Rust napi crate, engine compiled in

Two architectures were on the table:

1. **(chosen)** A Rust napi crate that links the engine crate directly
   (`corvid-db = { git = "https://github.com/corvid-db/corvid.git", tag = "v0.4.1" }`
   — the engine package is `corvid-db` with lib ident `corvid`; bare
   `corvid` on crates.io is an unrelated crate) and exposes the OOP
   surface through napi classes.
2. JS-side FFI (koffi/ffi-napi) against the release `cdylib`
   artifacts.

Ruling: **(1)**, because (2) drags unmaintained JS FFI dependencies
(`ffi-napi` is years stale; `koffi` is better maintained but still a
hand-rolled binding layer), loses the engine's type information at the
boundary, and re-implements ownership/threading rules in a language
with neither. With the engine compiled in, the Rust compiler checks
the entire handle/value/predicate surface against the real engine API
at build time, and one release pipeline (napi-rs + GitHub Actions)
produces prebuilt binaries for the platform matrix.

The **cdylib release artifacts remain the C/C++ story** (`corvid.h` +
platform libraries, consumed by corvid-c and any C consumer); Node
gets the engine compiled in. Both pin the same engine tag, and both
prove themselves against the same golden fixtures — one behavioral
truth, N native implementations.

Consequence (documented trade-off): a Rust toolchain is needed to
build from source; prebuilt binaries via `optionalDependencies` are
the default install path for consumers.

## 3. The OOP surface (v1)

Handles become native classes; FFI symbols never leak:

| ABI handle | JS class | Notes |
| --- | --- | --- |
| `corvid_db*` | `Db` | `open`/`openMemory` static factories, `close()` idempotent, `Symbol.dispose` when available |
| `corvid_coll*` | `Collection` | mutations, reads, TTL, indexes (all variants), schema, graph, geo, `query()` |
| `corvid_query*` | `Query` | fluent chaining (`filter().vector().text().fuseRrf().rerankMmr().limit().run()`); terminal ops (`run` + every aggregation) consume it; `close()` is the abandoned-builder path |
| `corvid_rows*`/`_strs*`/`_geohits*`/`_groupiter*`/`_schemaiter*` | native arrays/objects | cursors materialize as `Row[]`, `string[]`, `GeoHit[]`, `Record<string, number>`, `SchemaField[]` — JS-native iteration |
| `corvid_value*` | the value mapping | see §4 |
| `corvid_pred*` | predicate descriptors | `field('a.b').gt(2)`, `and`/`or`/`not` — plain JS objects converted at the single crossing point (`filter`/`deleteWhere`) |
| status + `last_error_*` | `CorvidError` | `code` carries the C-ABI error number (frozen 0–19 table), `message` the engine text |

- **Errors**: napi-rs cannot attach properties to thrown errors, so
  the native layer throws with the code+message in the error message
  as JSON and `index.js` rethrows a real `CorvidError` (an `Error`
  subclass). `ErrorCode` exports the frozen table.
- **Dispose**: `close()` everywhere (idempotent — the JS analog of the
  ABI's free-NULL no-ops), plus `Symbol.dispose` for `using` when the
  runtime provides it.
- **Compact gate**: `Db.compact()` mirrors the ABI's §4.13 exclusivity
  rule — a derived-handle counter (1 for the db, +1 per live
  Collection/Query, released by close/consume/GC) must be at exactly 1
  AND the engine `Arc` must be solely owned, else `Busy` (19). The
  golden admin.txt lines pin both the busy and the quiescent path.
- **Sync-first**: every method is synchronous. Async variants are
  additive later per the controller plan's §8.

## 4. The value mapping (the binding's value contract)

| JS (in) | engine `Value` | engine (out) | JS (out) |
| --- | --- | --- | --- |
| `null` / `undefined` | `Null` | `Null` | `null` |
| `boolean` | `Bool` | `Bool` | `boolean` |
| `number` (integer-valued, not `-0`, ≤2^53) | `Int` | `Int` (safe) | `number` |
| `number` (everything else: `0.5`, `inf`, `NaN`, `-0.0`) | `Float` | `Int` (beyond ±2^53) | `bigint` |
| `bigint` | `Int` (full i64) | `Float` | `number` |
| `string` | `Text` | `Text` | `string` |
| `Buffer` / `Uint8Array` | `Bytes` | `Bytes` | `Buffer` |
| `Float32Array` | `Vector` | `Vector` | `Float32Array` |
| `Array` | `Array` | `Array` | `Array` |
| plain object | `Map` | `Map` | plain object (engine key order) |
| `CorvidFloat(n)` | `Float(n)` — the typed-float escape hatch | | |

Documented corners:

- **NaN fidelity**: the engine preserves f64 NaN payloads, and plain
  JS `HeapNumber`s do too — but V8 **canonicalizes NaN payloads at the
  N-API number boundary** (verified: `bits:0x7ff8000000000001` crosses
  napi as `0x7ff8000000000000`). A JS consumer can observe NaN-as-NaN
  (semantic equality, ordering, and `-0.0`/`±inf` bits are exact), but
  not f64 payload bits. Vector elements are unaffected (typed-array
  memory is never boxed). The golden port compares NaN expectations as
  NaN-class equality and documents the deviation in the spec header.
- **The Int/Float collapse**: JS numbers are unmarked, so `2` → `Int`.
  The engine's numeric interop (filters, ordering, predicates) treats
  `2` and `2.0` the same; the remaining observable distinction —
  compare-and-set/unique equality against typed floats, and group-key
  tags (`i:2` vs `f:0.5`) — is why `CorvidFloat` exists.
- **Keys** are strings (UTF-8) or Buffers (raw bytes); keys that are
  not valid UTF-8 come back as Buffers.

## 5. Packaging & prebuilt binaries

- `@napi-rs/cli` v3 builds `index.<platform>.node` per platform
  (`npm run build`), naming per the CLI's conventions
  (`darwin-arm64`, `linux-x64-gnu`, `win32-x64-msvc`, …).
- Published install path: the root package carries
  `optionalDependencies` on `corvid-node-<platform>` packages produced
  by the CI matrix via `napi artifacts`/`napi publish` — the standard
  napi-rs prebuilt flow. `index.js` resolves: env override → local
  build → the platform optionalDependency.
- Linux: gnu only for v1 (musl can be added to the matrix later).
- Not yet published (`npm publish --dry-run` green locally; publishing
  waits on the platform packages existing first).

## 6. Follow-up tasks (post-bootstrap)

1. **Publish wiring**: `napi publish` from the release workflow; tag
   `v0.1.0`; verify `npm i corvid-node` installs prebuilt on each
   platform (the optionalDependencies versions must match the root).
2. **Ergonomic sugar** (only now, per the golden-before-sugar rule):
   `using` examples in README once TS `using` is widespread; iterate
   over `scan()`/`run()` with async generators only if the FFI bench
   justifies async; a `SchemaBuilder` fluent form.
3. **API doc pass**: doc comments → typedoc (or similar) publishing
   `index.d.ts` narratives; NaN-fidelity and Int/Float notes
   prominent.
4. **Bench parity**: port the FFI bench shapes (put/get/scan/hybrid
   through JS vs the engine's native numbers) to quantify the
   napi crossing cost — feeds the async-variants decision.
5. **musl targets** if demanded; **win32-arm64** when runners exist.
6. Bump automation: a scripted PR flow that moves the engine git-dep
   tag + optionalDependencies versions together (the program's
   version rule).

## 7. Decision log

| Decision | Rationale |
| --- | --- |
| Rust napi crate, engine compiled in (not JS-side FFI) | §2 above |
| JS idiom layer in `index.js` wrapping napi classes | fluent chaining + real `CorvidError` subclass; keeps native surface minimal; FFI/engine types never leak |
| Predicates as plain descriptor objects | one crossing per engine op, full TS typing, no native predicate handle to manage |
| Vendored golden fixtures (from the v0.2.1 release, identical to the engine repo's tag) | stable text; the suite must run offline and per-PR |
| NaN-class comparison in the golden port | V8 canonicalizes NaN payloads at the N-API boundary; deviation documented (§4) |
| `CorvidFloat` marker class | typed-float escape hatch for the Int/Float collapse (CAS/unique/group-keys) |
| Counter + Arc exclusivity for `compact` | mirrors the ABI §4.13 gate exactly; pinned by admin.txt |
| napi-build pinned at 2.x, napi/napi-derive at 3.x | current crates.io stable lines |

## Release-layout fix (2026-09-02)

`napi.binaryName` is `index-native` (was `index`): napi's generated root
loader collides with the hand-written OOP API at `index.js` — `napi
artifacts`/`pre-publish` overwrite it at publish time, which would have
shipped the raw bindings as the package entry. Under the new name napi
owns `index-native.js` (gitignored, internal) and the platform binaries
`index-native.<abi>.node`; the API file and the published tarball are
untouched by the toolchain. The five platform packages publish 0.3.3
manually once (npm has no pending-publisher mechanism), then trusted
publishers own every future release.
