// geo.js — points, radius, bbox, nearest-k with real coordinates.
//
// Four German cities stored with their real lat/lon (the [lat, lon]
// array encoding; a { lat, lon } object encodes the same point).
// Distances are haversine kilometres:
//
//   radius 600 km from central Berlin (52.52, 13.40):
//     berlin 0.000000, potsdam 26.621424, hamburg 255.120591,
//     munchen 503.833264 — nearest first, inclusive boundary.
//   bbox (47..55, 5..15): all four, key order, the 0.0 sentinel
//     (a box has no center to measure from).
//   nearest 2: berlin, potsdam — exact haversine order.
//
// These are the same points and tolerances the engine's golden geo
// fixture asserts (~1e-6 km).
//
// Run: node examples/geo.js   (after `npm run build`)

'use strict';

const { Db } = require('..');

const db = Db.openMemory();
const places = db.collection('places');

places.insert('berlin', { name: 'berlin', loc: [52.52, 13.4] });
places.insert('potsdam', { name: 'potsdam', loc: [52.4, 13.06] });
places.insert('hamburg', { name: 'hamburg', loc: [53.55, 9.99] });
places.insert('munchen', { name: 'munchen', loc: [48.14, 11.58] });

places.createGeoIndex('loc');

const fmt = (hits) =>
  `[${hits.map(({ key, distanceKm }) => `${key} ${distanceKm.toFixed(6)}km`).join(' ')}]`;

console.log(
  'within 600km of Berlin:'.padEnd(34),
  fmt(places.geoWithinRadius('loc', 52.52, 13.4, 600.0)),
);
console.log(
  'bbox 47..55N, 5..15E:'.padEnd(34),
  fmt(places.geoWithinBBox('loc', 47, 5, 55, 15)),
);
console.log(
  'nearest 2 to Berlin:'.padEnd(34),
  fmt(places.geoNearest('loc', 52.52, 13.4, 2)),
);

places.close();
db.close();
