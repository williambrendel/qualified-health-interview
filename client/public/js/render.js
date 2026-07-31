"use strict";

/**
 * render.js — draws the analysis: the connector status (sniff → map → verify →
 * check), the queue chips, and the ticket cards. Pure view code.
 */

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

let CURRENT = null;
let FILTER = "all";
let ELS = null;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "clinical-urgent", label: "Urgent" },
  { key: "clinical-routine", label: "Routine" },
  { key: "data-quality", label: "Data quality" },
];

function stage(kind, label, detail) {
  return `<span class="stage ${kind}"><span class="dot"></span><b>${esc(label)}</b> ${esc(detail)}</span>`;
}

function renderConnector(d) {
  const stages = [];
  const ing = d.ingest || {};
  stages.push(stage("ok", "Sniffed", `${JSON.stringify(ing.delimiter)} · ${ing.columns} cols · ${ing.rows} rows${ing.structuralAnomalies ? ` · ${ing.structuralAnomalies} repaired` : ""}`));

  if (d.validation && d.validation.valid) {
    stages.push(stage("ok", `Mapped → ${d.entity}`, `${d.validation.mapped.length} fields · ${d.cached ? "cached manifest" : "induced (LLM)"}`));
  } else {
    stages.push(stage("fail", "Mapping rejected", (d.validation && d.validation.errors && d.validation.errors[0]) || ""));
  }

  const v = d.verification;
  if (v) {
    const s = v.summary;
    const kind = v.pass ? "ok" : "fail";
    stages.push(stage(kind, v.pass ? "Verified" : "Verification failed",
      `coverage ${v.coverage.accounted}/${v.coverage.sourceColumns} · round-trip ${s.roundTripClean ? "lossless" : "LOSS"} · types ${s.typesPlausible ? "ok" : "!"} · sampled ${v.sampledRows}/${v.totalRows}`));
  }

  if (d.entity === "lab_result") {
    const t = d.ticketSummary || { total: 0 };
    stages.push(stage("ok", "Checked", `abnormal-result triage → ${t.total} tickets`));
  } else {
    stages.push(stage("warn", "No clinical check", `for entity "${d.entity}" (single-file drop) — connector proof only`));
  }

  return `<div class="connector__title">AI input connector · status</div>
    <div class="stages">${stages.join("")}</div>
    <div class="connector__detail">source: ${esc(d.source)} → canonical model "${esc(d.entity)}" · a fixed engine applied the reviewed manifest; nothing was written to a chart.</div>`;
}

function fmtVal(f) {
  const dir = f.direction === "high" ? "hi" : f.direction === "low" ? "lo" : "";
  const arrow = f.direction === "high" ? "▲" : f.direction === "low" ? "▼" : "";
  const ref = f.reference && (f.reference.low != null || f.reference.high != null)
    ? ` <span class="sla">(ref ${f.reference.low}–${f.reference.high} ${f.unit || ""})</span>` : "";
  return `<span class="val ${dir}">${esc(f.value)}${f.unit ? " " + esc(f.unit) : ""} ${arrow}</span>${ref}`;
}

function card(t) {
  const sev = t.severity || "data-quality";
  const isDQ = t.queue === "data-quality";
  const oor = t.facts.outOfRangeBy != null ? `out of range by ${t.facts.outOfRangeBy}` : "";
  const crit = t.facts.beyondCritical ? ' · <b style="color:var(--critical)">beyond critical</b>' : "";
  return `<div class="card ${isDQ ? "dataq" : sev}">
    <div class="row1">
      <div><span class="badge b-${sev}">${sev}</span> <span class="lab">${esc(t.facts.component || "—")}</span> ${fmtVal(t.facts)}</div>
      <div class="sla">${isDQ ? "data-quality" : (t.queue || "").replace("clinical-", "")}${t.slaHours ? " · SLA " + t.slaHours + "h" : ""}</div>
    </div>
    <div class="meta"><span>patient ${esc(t.patient && t.patient.id || "—")}</span><span>${esc(t.facts.resultDate || "")}</span><span>${esc(oor)}</span>${crit ? `<span>${crit}</span>` : ""}</div>
    ${isDQ ? `<div class="dq-explain">⚠ Physiologically implausible (${t.facts.plausibilityBasis === "governed" ? "governed bound" : "far outside its reference range"}). Diverted from the clinical queue.</div>` : ""}
    <div class="prov">source: ${esc(t.provenance.source)} · result_id ${esc(t.provenance.result_id || "—")} · LOINC ${esc(t.provenance.loinc || "—")} · ${esc(t.id)}</div>
  </div>`;
}

function renderChips() {
  const s = (CURRENT.ticketSummary && CURRENT.ticketSummary.byQueue) || {};
  const total = (CURRENT.ticketSummary && CURRENT.ticketSummary.total) || 0;
  ELS.chips.innerHTML = FILTERS
    .filter((f) => f.key === "all" || s[f.key])
    .map((f) => {
      const n = f.key === "all" ? total : (s[f.key] || 0);
      return `<div class="chip ${FILTER === f.key ? "active" : ""}" data-key="${f.key}"><span class="n">${n}</span> ${f.label}</div>`;
    }).join("");
  ELS.chips.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { FILTER = c.dataset.key; renderChips(); renderList(); }));
}

function renderList() {
  const all = CURRENT.tickets || [];
  const list = FILTER === "all" ? all : all.filter((t) => t.queue === FILTER);
  if (!(CURRENT.ticketSummary && CURRENT.ticketSummary.total)) {
    ELS.list.innerHTML = `<div class="empty">This file maps to the canonical <b>${esc(CURRENT.entity)}</b> model. Clinical checks in this demo run on lab results — drop <code>order_results.csv</code> to see the ticket queue.</div>`;
    ELS.status.textContent = "";
    return;
  }
  ELS.list.innerHTML = list.length ? list.map(card).join("") : `<div class="empty">No tickets in this queue.</div>`;
  ELS.status.textContent = `Showing ${list.length} of ${all.length} tickets`;
}

/** Draw the whole report. */
export function renderReport(els, data) {
  ELS = els; CURRENT = data; FILTER = "all";
  els.meta.textContent = `${data.source} · ${data.ingest.rows} rows · ${data.cached ? "manifest cached (zero-network)" : "manifest induced live"}`;
  els.connector.innerHTML = renderConnector(data);
  renderChips();
  renderList();
}
