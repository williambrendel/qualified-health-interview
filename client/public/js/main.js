"use strict";

/**
 * main.js — entry point (glue).
 *   - Wires the dropzone (click + drag/drop) to POST /api/analyze
 *   - Hands the response to render.renderReport
 *   - Wires the theme toggle (persisted) and the reset button
 */

import { analyzeFile } from "./api.js";
import { renderReport } from "./render.js";

const THEME_KEY = "syntaxin.theme";

const els = {
  upload: document.getElementById("upload"),
  dropzone: document.getElementById("dropzone"),
  input: document.getElementById("file-input"),
  hint: document.getElementById("hint"),
  report: document.getElementById("report"),
  meta: document.getElementById("report-meta"),
  connector: document.getElementById("connector"),
  chips: document.getElementById("chips"),
  list: document.getElementById("list"),
  status: document.getElementById("status"),
  reset: document.getElementById("reset"),
  themeToggle: document.getElementById("theme-toggle"),
};

// ── theme ──
function syncThemeColor() {
  const meta = document.getElementById("meta-theme-color");
  if (meta) meta.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0e1116");
}
els.themeToggle.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
  syncThemeColor();
});
syncThemeColor();

// ── upload flow ──
function setHint(text, isError) {
  els.hint.hidden = !text;
  els.hint.textContent = text || "";
  els.hint.classList.toggle("is-error", !!isError);
}

async function handleFile(file) {
  if (!file) return;
  setHint(`Analyzing ${file.name}… (first-time mapping of an unseen schema may call the LLM)`, false);
  els.dropzone.classList.add("is-busy");
  try {
    const data = await analyzeFile(file);
    els.upload.hidden = true;
    els.report.hidden = false;
    renderReport(els, data);
  } catch (err) {
    setHint(err.message || String(err), true);
  } finally {
    els.dropzone.classList.remove("is-busy");
  }
}

els.dropzone.addEventListener("click", () => els.input.click());
els.input.addEventListener("change", () => handleFile(els.input.files[0]));

["dragenter", "dragover"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add("is-drag"); }));
["dragleave", "dragend", "drop"].forEach((ev) =>
  els.dropzone.addEventListener(ev, () => els.dropzone.classList.remove("is-drag")));
els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

els.reset.addEventListener("click", () => {
  els.report.hidden = true;
  els.upload.hidden = false;
  els.input.value = "";
  setHint("", false);
});
