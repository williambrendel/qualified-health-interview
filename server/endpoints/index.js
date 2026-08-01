"use strict";

/**
 * @module endpoints
 * @description Endpoint registry. Requiring each module runs its `createEndpoint(...)`
 * calls, which register the endpoints into the global registry; the {@link App}
 * mounts them via `attachRegisteredEndpoints` on construction.
 */

const authenticate = require("./authenticate"); // example endpoint from the scaffold
const connect = require("./connect");            // /connect/discover, /connect/load
const analyze = require("./analyze");            // /analyze
const publish = require("./publish");            // /publish
const upload = require("./upload");              // /api/analyze (demo all-in-one)
const inspect = require("./inspect");            // /api/sources, /api/ingest, /api/manifest, /api/canonical
const tickets = require("./tickets");            // /api/tickets, /tickets

module.exports = {
  authenticate,
  ...connect,
  ...analyze,
  ...publish,
  ...upload,
  ...inspect,
  ...tickets,
};
