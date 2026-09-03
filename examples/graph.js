// graph.js — directed edges over a small corpus, and delete cascade.
//
// Three documents (ga, gb, gc) linked by a `parent_of` relation, plus
// one edge pointing at `gd` which never exists as a document (dangling
// edges are allowed), and a weighted `route` relation. Demonstrates
// neighbors (key order), inNeighbors, weighted neighbors, BFS traverse
// at 1 and 2 hops (cycle-safe), and the delete cascade: deleting a key
// removes its edges in the same transaction — deleting the never-a-
// document `gd` still drops the `gb -> gd` edge (spec §4.8/§4.11).
//
// Run: node examples/graph.js   (after `npm run build`)

'use strict';

// docs:begin:graph
const { Db } = require('..');

const db = Db.openMemory();
const nodes = db.collection('nodes');

for (const key of ['ga', 'gb', 'gc']) nodes.insert(key, { n: key });

nodes.link('ga', 'parent_of', 'gb');
nodes.link('ga', 'parent_of', 'gc');
nodes.link('gb', 'parent_of', 'gd'); // gd never exists as a document
nodes.linkWeighted('ga', 'route', 'gb', 2.5);
nodes.linkWeighted('ga', 'route', 'gd', 0.75);

const fmt = (keys) => `[${keys.join(' ')}]`;
console.log('neighbors(ga)'.padEnd(36), fmt(nodes.neighbors('ga', 'parent_of')));
console.log('in_neighbors(gb)'.padEnd(36), fmt(nodes.inNeighbors('gb', 'parent_of')));
const routes = nodes
  .neighborsWeighted('ga', 'route')
  .map(({ key, weight }) => `${key}=${weight.toFixed(2)}`)
  .join(' ');
console.log('routes from ga (weighted):'.padEnd(36), `[${routes}]`);
console.log('traverse(ga, 1 hop)'.padEnd(36), fmt(nodes.traverse('ga', 'parent_of', 1)));
console.log('traverse(ga, 2 hops)'.padEnd(36), fmt(nodes.traverse('ga', 'parent_of', 2)));

// Delete cascade: remove gc (a document) and gd (never a document).
console.log('delete gc: existed=', nodes.delete('gc'));
console.log('delete gd: existed=', nodes.delete('gd'), '(never a document; its edges still cascade)');

console.log('neighbors(ga) after deletes'.padEnd(36), fmt(nodes.neighbors('ga', 'parent_of')));
console.log('neighbors(gb) after deletes'.padEnd(36), fmt(nodes.neighbors('gb', 'parent_of')));
console.log('traverse(ga, 2 hops) after'.padEnd(36), fmt(nodes.traverse('ga', 'parent_of', 2)));

nodes.close();
db.close();
// docs:end:graph
