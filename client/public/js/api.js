"use strict";

/**
 * api.js — thin client for the analyze endpoint.
 *
 *   analyzeFile(file) → POST /api/analyze  { filename, content }
 *
 * The file is read as text in the browser and sent as JSON (CSV/TSV/JSON/TXT are
 * all text). The API base is read once from <meta name="syntaxin:api-base">; empty
 * means same-origin.
 */

const API_BASE = (() => {
  const meta = document.querySelector('meta[name="syntaxin:api-base"]');
  return ((meta && meta.getAttribute("content")) || "").trim().replace(/\/+$/, "");
})();

const apiUrl = (p) => API_BASE + p;

/** Read a File to text (UTF-8). */
export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error || new Error("could not read file"));
    fr.readAsText(file);
  });
}

/**
 * Upload a file's text and run the pipeline.
 * @param {File} file
 * @returns {Promise<object>} analysis response
 */
export async function analyzeFile(file) {
  const content = await readFileText(file);
  const res = await fetch(apiUrl("/api/analyze"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, content }),
  });
  if (!res.ok) {
    let msg = `Analysis failed (${res.status})`;
    try { const j = await res.json(); msg = j.error || j.detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}
