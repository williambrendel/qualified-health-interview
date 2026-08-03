"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { pearson, dominantSet, cohesion, cliques } = require("./correlation");

test("pearson: perfect correlations and null cases", () => {
  assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1); // perfect positive
  assert.equal(pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1); // perfect negative
  assert.equal(pearson([1, 1, 1, 1], [2, 4, 6, 8]), null); // zero variance
  assert.equal(pearson([1, 2], [3, 4]), null); // too few points
});

test("pearson: recovers a strong positive relationship with noise", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const ys = [1.1, 1.9, 3.2, 3.8, 5.1, 6.2, 6.8, 8.1];
  const r = pearson(xs, ys);
  assert.ok(r > 0.98, `expected strong positive, got ${r}`);
});

test("dominantSet: extracts a tight clique from a two-community graph", () => {
  // nodes 0,1,2 fully connected (weight 1); nodes 3,4 a separate weak pair; no cross edges
  const A = [
    [0, 1, 1, 0, 0],
    [1, 0, 1, 0, 0],
    [1, 1, 0, 0, 0],
    [0, 0, 0, 0, 0.4],
    [0, 0, 0, 0.4, 0],
  ];
  const members = dominantSet(A, [true, true, true, true, true]).sort();
  assert.deepEqual(members, [0, 1, 2]); // the dense triangle dominates
});

test("cohesion: mean pairwise affinity among members", () => {
  const A = [[0, 1, 0.5], [1, 0, 0.5], [0.5, 0.5, 0]];
  assert.equal(cohesion(A, [0, 1, 2]), (1 + 0.5 + 0.5) / 3);
  assert.equal(cohesion(A, [0]), 0);
});

test("cliques: peels cohesive groups and rejects the incoherent leftover", () => {
  // two triangles {0,1,2} and {3,4,5}; node 6 isolated (no edges)
  const A = Array.from({ length: 7 }, () => new Array(7).fill(0));
  const link = (i, j, w) => { A[i][j] = w; A[j][i] = w; };
  [[0, 1], [0, 2], [1, 2]].forEach(([i, j]) => link(i, j, 0.9));
  [[3, 4], [3, 5], [4, 5]].forEach(([i, j]) => link(i, j, 0.8));
  const groups = cliques(A, { minSize: 2, minCohesion: 0.3 });
  const sets = groups.map((g) => g.members.slice().sort((a, b) => a - b));
  assert.equal(groups.length, 2, "two cohesive triangles, isolated node excluded");
  assert.ok(sets.some((s) => s.join() === "0,1,2"));
  assert.ok(sets.some((s) => s.join() === "3,4,5"));
  assert.ok(groups.every((g) => g.cohesion >= 0.3));
});
