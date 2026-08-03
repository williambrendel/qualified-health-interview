"use strict";

/**
 * @module pipeline/analyzers/correlation
 * @description
 * The math behind k-uplet discovery: Pearson correlation, dominant sets (Pavan–Pelillo
 * replicator dynamics), and a cohesion gate. Pure functions — no data or IO — so the
 * clique discovery is unit-testable. Used by `scripts/cliques.js` to turn a patient ×
 * analyte matrix into coherent, co-varying groups (candidate k-uplets) without ever
 * enumerating combinations.
 */

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/** Pearson correlation of paired arrays; null if undefined (n<3 or zero variance). */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) { const dx = xs[k] - mx, dy = ys[k] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * One dominant set of an affinity matrix, restricted to the `active` nodes, via
 * replicator dynamics from a uniform start. Returns the node indices in its support.
 * @param {number[][]} A - symmetric, non-negative, zero-diagonal affinity matrix
 * @param {boolean[]} active - which nodes participate
 */
function dominantSet(A, active) {
  const idx = active.map((_, k) => k).filter((k) => active[k]);
  const n = idx.length;
  if (n === 0) return [];
  let x = new Array(n).fill(1 / n);
  for (let it = 0; it < 2000; it++) {
    const Ax = idx.map((_, i) => idx.reduce((s, _j, j) => s + A[idx[i]][idx[j]] * x[j], 0));
    const denom = x.reduce((s, xi, i) => s + xi * Ax[i], 0);
    if (denom <= 0) break;
    const xn = x.map((xi, i) => xi * Ax[i] / denom);
    const sum = xn.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < n; i++) xn[i] /= sum;
    let diff = 0; for (let i = 0; i < n; i++) diff += Math.abs(xn[i] - x[i]);
    x = xn;
    if (diff < 1e-10) break;
  }
  const thr = 1 / (n * 3);
  return idx.filter((_, i) => x[i] > thr);
}

/** Internal cohesion of a group = mean pairwise affinity among its members. */
function cohesion(A, members) {
  if (members.length < 2) return 0;
  let s = 0, c = 0;
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) { s += A[members[i]][members[j]]; c++; }
  return c ? s / c : 0;
}

/**
 * Peel successive dominant sets, keeping only cohesive ones. Isolated nodes never form
 * a clique; a leftover blob whose members aren't inter-connected is rejected.
 * @returns {Array<{members:number[], cohesion:number}>}
 */
function cliques(A, { minSize = 2, minCohesion = 0.3, maxCliques = 10 } = {}) {
  const degree = A.map((row) => row.filter((w) => w > 0).length);
  const active = A.map((_, i) => degree[i] > 0);
  const out = [];
  for (let c = 0; c < maxCliques; c++) {
    if (active.filter(Boolean).length < minSize) break;
    const members = dominantSet(A, active);
    if (members.length < minSize) break;
    for (const m of members) active[m] = false;
    const coh = cohesion(A, members);
    if (coh >= minCohesion) out.push({ members, cohesion: coh });
  }
  return out;
}

module.exports = { pearson, dominantSet, cohesion, cliques, mean };
