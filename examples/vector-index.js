// vector-index.js — three vector-index families, ANN vs exact.
//
// A file-backed database (the on-disk index is a disk-resident HNSW
// graph persisted inside the db file) with eight 4-d documents. The
// same embedding is stored under three fields so each index family can
// be demonstrated side by side:
//
//   vMem  — in-memory HNSW              (createVectorIndex)
//   vDisk — on-disk HNSW                (createVectorIndexOndisk)
//   vQ    — in-memory binary-quantized   (createVectorIndexQuantized)
//
// The exact (streaming-scan) ranking is printed first, then the ANN
// (approx) ranking served by each index. The unquantized indexes
// answer identically to the scan on this corpus; the binary-quantized
// one genuinely diverges — the recall/footprint trade-off quantization
// makes (binary packs each float32 to one sign bit, ~32x smaller).
// Finally the db is closed and reopened: the on-disk graph reloads and
// serves the same ANN answer without a rebuild.
//
// Scores are RRF ranks (1/(60 + rank)) — the lone vector source's row
// score — so they reflect each lane's own ranking.
//
// Run: node examples/vector-index.js   (after `npm run build`)

'use strict';

const { rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const { Db } = require('..');

const PATH = join(tmpdir(), 'corvid-node-example-vector-index.redb');
const PROBE = new Float32Array([1.0, 0.0, 0.0, 0.0]);

const CORPUS = [
  ['k0', [1.0, 0.0, 0.0, 0.0]], // nearest
  ['k1', [0.95, 0.05, 0.0, 0.0]],
  ['k2', [0.0, 1.0, 0.0, 0.0]],
  ['k3', [0.0, 0.9, 0.1, 0.0]],
  ['k4', [0.0, 0.0, 1.0, 0.0]],
  ['k5', [0.7, 0.7, 0.0, 0.0]],
  ['k6', [0.0, 0.0, 0.0, 1.0]],
  ['k7', [0.98, 0.02, 0.0, 0.0]],
];

function runQuery(docs, field, approx, label) {
  let q = docs.query().vector(field, PROBE, 4, 'cosine');
  if (approx) q = q.approx();
  const rows = q.run();
  const parts = rows.map(({ key, score }) => `${key}(${score.toFixed(6)})`);
  console.log(label.padEnd(38), parts.join(' '));
}

rmSync(PATH, { force: true }); // reruns start clean (single-file db)

let db = Db.open(PATH);
let docs = db.collection('items');
for (const [key, v] of CORPUS) {
  const vec = new Float32Array(v);
  docs.insert(key, { v_mem: vec, v_disk: vec, v_q: vec });
}
docs.createVectorIndex('v_mem', 'cosine');
docs.createVectorIndexOndisk('v_disk', 'cosine');
docs.createVectorIndexQuantized('v_q', 'cosine', 'binary');

console.log('top-4 nearest to (1,0,0,0) under cosine:');
runQuery(docs, 'v_mem', false, 'exact (scan):');
runQuery(docs, 'v_mem', true, 'ann in-memory HNSW:');
runQuery(docs, 'v_disk', true, 'ann on-disk HNSW:');
runQuery(docs, 'v_q', true, 'ann binary-quantized:');
console.log('(the quantized lane trades recall for a ~32x smaller index)');

docs.close();
db.close();

// Reopen: the on-disk graph reloads (no rebuild) and answers again.
db = Db.open(PATH);
docs = db.collection('items');
runQuery(docs, 'v_disk', true, 'ann on-disk after reopen:');
docs.close();
db.close();

rmSync(PATH, { force: true });
