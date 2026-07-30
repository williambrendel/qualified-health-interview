"use strict";

const { createEndpoint, statuses: { OK, BAD_REQUEST } } = require("../core");

/**
 * @type {Endpoint}
 * @description
 * POST endpoint that handles two-phase authentication: token verification
 * and verification-code dispatch.
 *
 * The request body is accepted as either a pre-parsed object or a raw JSON
 * string; malformed JSON is rejected immediately with `400 Bad Request`.
 *
 * **Phase 1 — Send verification code** (`verify` is falsy):
 * Responds `200 OK` with `{ message: "Verification code sent" }`.
 *
 * **Phase 2 — Verify token** (`verify` is truthy):
 * Validates the supplied token (TODO) and responds `200 OK` with
 * `{ message: "Data received successfully", verified: true }`.
 *
 * @param {Object}        req                - Express request object.
 * @param {Object|string} req.body           - POST payload. Parsed automatically
 *                                             if received as a raw JSON string.
 * @param {*}             [req.body.verify]  - When truthy, triggers token
 *                                             verification instead of code dispatch.
 * @param {Object}        res                - Express response object.
 *
 * @returns {void} Responds with one of:
 * | Status            | Body                                                 | Condition                    |
 * |-------------------|------------------------------------------------------|------------------------------|
 * | `400 Bad Request` | `{ error, data }`                                    | Body is an unparseable string |
 * | `200 OK`          | `{ message: "Verification code sent" }`              | `verify` is falsy            |
 * | `200 OK`          | `{ message: "Data received successfully", verified: true }` | `verify` is truthy    |
 *
 * @todo Implement actual token verification logic in the `data.verify` branch.
 *
 * @example
 * // Phase 1 — request a verification code
 * POST /authenticate
 * { }
 * // → 200 { message: "Verification code sent" }
 *
 * @example
 * // Phase 2 — verify a token
 * POST /authenticate
 * { "verify": "<token>" }
 * // → 200 { message: "Data received successfully", verified: true }
 *
 * @example
 * // Malformed body
 * POST /authenticate   (body: "not json{")
 * // → 400 { error: SyntaxError, data: "not json{" }
 */
const authenticate = createEndpoint("post", "/authenticate", (req, res) => {
  // Access the POST data from req.body
  let data = req.body;
  try {
    typeof data === "string" && (data = JSON.parse(data));
  } catch (error) {
    res.status(BAD_REQUEST).json({ error, data });
    return;
  }

  // Do something with the data (e.g., save to a database)
  console.log("Received data:", data);

  if (data.verify) {
    // TODO: Verify token.

    // Token verified.
    res.status(OK).json({
      message: "Data received successfully",
      verified: true
    });
  } else {
    // Send verification code.
    res.status(OK).json({ message: `Verification code sent` });
  }
});

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(authenticate, "authenticate", {
  value: authenticate
}));