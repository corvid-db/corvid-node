// hybrid.js — the flagship: filter + vector + BM25, RRF fusion, MMR
// rerank, limit.
//
// Hybrid retrieval over a 4-document corpus: a pre-ranking `kind`
// filter, a vector (ANN) source and a BM25 text source, both
// contributing top-2 candidate lists, fused with Reciprocal Rank
// Fusion (k = 60) and reranked for diversity with MMR (lambda = 1.0),
// capped at 2 rows. The printed scores are RRF rank sums: s1 is rank 1
// of both sources (1/61 + 1/61 = 2/61), s3 rank 2 of both (2/62).
//
// Run: node examples/hybrid.js   (after `npm run build`)

'use strict';

// docs:begin:hybrid
const { Db, field } = require('..');

const db = Db.openMemory();
const docs = db.collection('docs');

docs.insert('s1', { kind: 'doc', body: 'rust embedded database', v: new Float32Array([1.0, 0.0]) });
docs.insert('s2', { kind: 'doc', body: 'python web frameworks', v: new Float32Array([0.0, 1.0]) });
docs.insert('s3', { kind: 'doc', body: 'rust again database', v: new Float32Array([0.9, 0.1]) });
docs.insert('m1', { kind: 'meta' }); // filtered out below

// The flagship query: filter + vector + text, RRF + MMR + limit.
const rows = docs
  .query()
  .filter(field('kind').eq('doc'))
  .vector('v', new Float32Array([1.0, 0.0]), 2, 'cosine')
  .text('body', 'rust database', 2)
  .fuseRrf(60)
  .rerankMmr(1.0)
  .limit(2)
  .run(); // [{ key, doc, score }]

let rank = 0;
for (const { key, doc, score } of rows) {
  console.log(`${++rank}. ${key} score=${score.toFixed(6)} ${doc.body}`);
}

docs.close();
db.close();
// docs:end:hybrid
