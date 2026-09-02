// text-search.js — BM25 ranking, English and CJK.
//
// Six notes (three English, three CJK) searched through a text index
// with the query builder's BM25 source. Row scores are RRF ranks
// (1/(60 + rank)); the *order* is the BM25 ranking.
//
// The CJK strings exercise the engine's dictionary-free CJK
// segmentation: maximal runs of CJK characters are tokenized as
// sliding BIGRAMS (「东京」… → "东京", …), so an unsegmented CJK query
// matches by its bigrams — "城市" (city) matches both city notes,
// "数据库" (database) matches the ML note.
//
// Phrase matching: engine v0.3.0 added the DIRECT positional search
// to the ABI (consecutive in-order analyzed tokens, stop words
// collapsing out of adjacency), surfaced here as phraseSearch() —
// score is the BM25 phrase sum, not the builder's fused RRF scale.
//
// Run: node examples/text-search.js   (after `npm run build`)

'use strict';

const { Db } = require('..');

const db = Db.openMemory();
const notes = db.collection('notes');

notes.insert('n1', { body: 'the quick brown fox jumps over the lazy dog' });
notes.insert('n2', { body: 'a quick red fox leaps over a sleeping dog' });
notes.insert('n3', { body: 'slow green turtle crosses the road' });
notes.insert('n4', { body: '东京是一座巨大的城市' });   // Tokyo is a huge city
notes.insert('n5', { body: '大阪是关西最大的城市' });   // Osaka is Kansai's biggest city
notes.insert('n6', { body: '机器学习正在改变数据库' }); // ML is changing databases

notes.createTextIndex('body');

function search(query, label) {
  const rows = notes.query().text('body', query, 3).run();
  const parts = rows.map(({ key, score }) => `${key}(${score.toFixed(6)})`);
  console.log(label.padEnd(28), '->', parts.join(' '));
}

function phrase(query, label) {
  const rows = notes.phraseSearch('body', query, 3);
  const parts = rows.map(({ key, score }) => `${key}(${score.toFixed(6)})`);
  console.log(label.padEnd(28), '->', parts.join(' '));
}

search('quick fox', 'bm25 "quick fox":');
search('quick dog', 'bm25 "quick dog":');
search('城市', 'bm25 CJK 城市 (city):');
search('数据库', 'bm25 CJK 数据库 (database):');

phrase('fox jumps over', 'phrase "fox jumps over":');
phrase('over jumps fox', 'phrase reversed (no match):');
phrase('leaps over a sleeping', 'phrase stop words collapsed:');

notes.close();
db.close();
