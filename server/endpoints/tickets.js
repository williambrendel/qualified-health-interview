"use strict";

/**
 * @module endpoints/tickets
 * @description The pre-built review queue:
 *   GET /api/tickets — the cached tickets.json (filterable by queue/severity)
 *   GET /tickets     — the review-queue UI
 */

const fs = require("fs");
const path = require("path");
const { createEndpoint } = require("../core");
const { buildTickets } = require("./lib");

const apiTickets = createEndpoint("get", "/api/tickets", async (req, res) => {
  try {
    const { tickets, summary } = await buildTickets();
    let list = tickets;
    if (req.query.queue) list = list.filter((t) => t.queue === req.query.queue);
    if (req.query.severity) list = list.filter((t) => t.severity === req.query.severity);
    const limit = Math.max(0, Math.min(Number(req.query.limit) || 200, 2000));
    res.json({ summary, count: list.length, shown: Math.min(limit, list.length), tickets: list.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ error: "ticket build failed", detail: String((e && e.message) || e) });
  }
});

const ticketsUi = createEndpoint("get", "/tickets", (_req, res) => {
  try {
    res.type("html").send(fs.readFileSync(path.join(__dirname, "../../client/tickets.html"), "utf8"));
  } catch (e) {
    res.status(500).send("tickets UI not found");
  }
});

module.exports = { apiTickets, ticketsUi };
