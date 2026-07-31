"use strict";

/**
 * @module pipeline/buildTicketsCli
 * @description
 * Explicit ticket build. This is where the (billable, networked) LLM hypothesis
 * calls happen — never at request time. It rebuilds tickets.json from the data and,
 * by default, generates + verifies advisory hypotheses for the critical tickets.
 *
 *   npm run build-tickets                  # critical tickets get hypotheses
 *   npm run build-tickets -- --severity=critical,moderate
 *   npm run build-tickets -- --no-hypotheses   # facts only (offline)
 */

const { buildTickets } = require("./buildTickets");

async function main(argv) {
  const args = argv.slice(2);
  const noHyp = args.includes("--no-hypotheses");
  const sevArg = args.find((a) => a.startsWith("--severity="));
  const severities = sevArg ? sevArg.split("=")[1].split(",") : ["critical"];

  const opts = { rebuild: true };
  if (!noHyp) opts.hypotheses = { severities, concurrency: 6 };

  const t0 = Date.now();
  const { tickets, summary } = await buildTickets(opts);
  console.log(`built ${tickets.length} tickets in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("queues   :", JSON.stringify(summary.byQueue));
  console.log("severity :", JSON.stringify(summary.bySeverity));
  if (summary.hypotheses) console.log("hypotheses:", JSON.stringify(summary.hypotheses), `(for: ${severities.join(", ")})`);
  console.log("→ tickets.json written (server serves it with zero network calls)");
}

main(process.argv).catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
