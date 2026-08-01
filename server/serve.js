"use strict";

/**
 * @module server/serve
 * @description
 * `npm start` entry point. Wires the app together and listens on port 8080.
 *
 * Endpoints live in `server/endpoints/` and register themselves via
 * {@link createEndpoint} when required (see {@link module:endpoints}); the {@link App}
 * mounts them on construction. This file only supplies middleware — JSON body parsing
 * and static serving of the drag-and-drop demo (`client/public`) — and starts the
 * server.
 *
 * Surface:
 *   /                     drag-and-drop demo (static)
 *   /tickets              pre-built review queue
 *   POST /api/analyze     demo all-in-one (ingest → connect → verify → triage → tickets)
 *   POST /connect/discover, /connect/load, /analyze, /publish   the composable microservices
 *   GET  /api/sources, /api/ingest, /api/manifest, /api/canonical, /api/tickets
 */

const express = require("express");
const { App } = require("./core");
require("./endpoints"); // requiring registers every endpoint via createEndpoint
const { PUBLIC_DIR } = require("./endpoints/lib");

const PORT = Number(process.env.PORT) || 8080;

const app = new App({
  middlewares: [
    express.json({ limit: "10mb" }),
    express.static(PUBLIC_DIR), // serves the drag-and-drop demo at "/" plus css/js/assets
  ],
});

app.listen(PORT, () => console.log(`✅ Syntaxin listening on http://localhost:${PORT}`));
