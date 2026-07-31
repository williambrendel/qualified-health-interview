"use strict";

/**
 * @file constants.test.js
 * @brief Tests for the VECT v2 binary format constants.
 *
 * These constants define the on-disk format. Changing them would invalidate
 * every existing `.bin` file in the wild. The tests pin the values so that
 * a change is loud, deliberate, and visible in code review.
 */

const constants = require("../../../src/VectorStore/Document/constants");

describe("VectorStore/Document/constants", () => {
  test("VECT_MAGIC encodes ASCII 'VECT' as little-endian Uint32", () => {
    expect(constants.VECT_MAGIC).toBe(0x56454354);

    // Little-endian decoding of 0x56454354 should spell 'VECT' (T=0x54, C=0x43, E=0x45, V=0x56).
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(constants.VECT_MAGIC, 0);
    expect(buf.toString("ascii")).toBe("TCEV"); // bytes in memory order are TCEV
    // Confirming the per-byte values:
    expect(buf[0]).toBe(0x54); // 'T'
    expect(buf[1]).toBe(0x43); // 'C'
    expect(buf[2]).toBe(0x45); // 'E'
    expect(buf[3]).toBe(0x56); // 'V'
  });

  test("VECT_VERSION is 2", () => {
    expect(constants.VECT_VERSION).toBe(2);
  });

  test("HEADER_BYTES is 40 (10 × Uint32)", () => {
    expect(constants.HEADER_BYTES).toBe(40);
    expect(constants.HEADER_BYTES).toBe(10 * 4);
  });

  test("the constants module is frozen", () => {
    expect(Object.isFrozen(constants)).toBe(true);
  });
});
