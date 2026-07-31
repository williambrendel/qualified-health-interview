"use strict";

const runWithRetry = require("../../src/utilities/runWithRetry");
const { alwaysValid } = runWithRetry;

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a mock runLLM that returns a scripted sequence of responses
 * across successive calls. Responses can be plain values or Error
 * instances (which the mock will throw).
 */
const mockRunLLM = (...responses) => {
  let call = 0;
  const fn = jest.fn(async (config, prompt) => {
    const idx = Math.min(call, responses.length - 1);
    const r = responses[idx];
    call++;
    if (r instanceof Error) throw r;
    return r;
  });
  fn.callCount = () => call;
  return fn;
};

const okValidator   = (raw) => ({ valid: true });
const failValidator = (raw) => ({ valid: false, errors: ["bad output"] });

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("runWithRetry — happy path", () => {
  test("returns raw output on successful first attempt", async () => {
    const runLLM = mockRunLLM("first attempt success");
    const result = await runWithRetry({
      runLLM,
      config: {}, prompt: "p",
      validate: okValidator,
    });
    expect(result).toBe("first attempt success");
    expect(runLLM.callCount()).toBe(1);
  });

  test("passes config / prompt positionally to runLLM", async () => {
    const runLLM = mockRunLLM("ok");
    await runWithRetry({
      runLLM,
      config: { model: "test-model" },
      prompt: "user message",
      validate: okValidator,
    });
    expect(runLLM).toHaveBeenCalledWith(
      { model: "test-model" },
      "user message",
    );
  });

  test("default validator (always valid) returns first response", async () => {
    const runLLM = mockRunLLM("first response");
    const result = await runWithRetry({
      runLLM,
      config: {}, prompt: "p",
      // no validate
    });
    expect(result).toBe("first response");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry on validator failure
// ─────────────────────────────────────────────────────────────────────────────

describe("runWithRetry — retry on validator failure", () => {
  test("retries when first response is invalid, succeeds on second", async () => {
    const runLLM = mockRunLLM("bad", "good");
    // Validator passes when raw === "good"
    const validate = (raw) => raw === "good" ? { valid: true } : { valid: false };
    const result = await runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate, maxRetries: 2,
    });
    expect(result).toBe("good");
    expect(runLLM.callCount()).toBe(2);
  });

  test("retries up to maxRetries times", async () => {
    const runLLM = mockRunLLM("bad", "bad", "good");
    const validate = (raw) => raw === "good" ? { valid: true } : { valid: false };
    const result = await runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate, maxRetries: 2,
    });
    expect(result).toBe("good");
    expect(runLLM.callCount()).toBe(3);
  });

  test("throws when retries are exhausted", async () => {
    const runLLM = mockRunLLM("bad", "bad", "bad");
    await expect(runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate: failValidator, maxRetries: 2,
    })).rejects.toThrow(/failed after 3 attempts/);
    expect(runLLM.callCount()).toBe(3);
  });

  test("maxRetries=0 means single attempt then throw", async () => {
    const runLLM = mockRunLLM("bad");
    await expect(runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate: failValidator, maxRetries: 0,
    })).rejects.toThrow(/failed after 1 attempts/);
    expect(runLLM.callCount()).toBe(1);
  });

  test("default maxRetries is 2 (3 total attempts)", async () => {
    const runLLM = mockRunLLM("bad", "bad", "bad", "bad");
    await expect(runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate: failValidator,
    })).rejects.toThrow(/failed after 3 attempts/);
    expect(runLLM.callCount()).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry on throws
// ─────────────────────────────────────────────────────────────────────────────

describe("runWithRetry — retry on throws", () => {
  test("retries when runLLM throws on first attempt", async () => {
    const runLLM = mockRunLLM(new Error("network blip"), "recovered");
    const result = await runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate: okValidator, maxRetries: 2,
    });
    expect(result).toBe("recovered");
    expect(runLLM.callCount()).toBe(2);
  });

  test("retries when runLLM throws on multiple attempts", async () => {
    const runLLM = mockRunLLM(
      new Error("blip 1"),
      new Error("blip 2"),
      "recovered",
    );
    const result = await runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate: okValidator, maxRetries: 2,
    });
    expect(result).toBe("recovered");
    expect(runLLM.callCount()).toBe(3);
  });

  test("throws (with diagnostic) when all attempts throw", async () => {
    const runLLM = mockRunLLM(
      new Error("blip 1"),
      new Error("blip 2"),
      new Error("blip 3"),
    );
    await expect(runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate: okValidator, maxRetries: 2,
    })).rejects.toThrow(/runLLM threw — blip 1.*runLLM threw — blip 2.*runLLM threw — blip 3/s);
  });

  test("mixed: throw then invalid then valid", async () => {
    const runLLM = mockRunLLM(
      new Error("transport"),
      "bad-content",
      "good",
    );
    const validate = (raw) => raw === "good" ? { valid: true } : { valid: false, errors: ["wrong"] };
    const result = await runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate, maxRetries: 2,
    });
    expect(result).toBe("good");
    expect(runLLM.callCount()).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fallback on exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe("runWithRetry — fallback on exhaustion", () => {
  test("returns fallback when retries are exhausted (validator failure)", async () => {
    const runLLM = mockRunLLM("bad", "bad", "bad");
    const result = await runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate: failValidator, maxRetries: 2,
      fallback: "fallback-value",
    });
    expect(result).toBe("fallback-value");
    expect(runLLM.callCount()).toBe(3);
  });

  test("returns fallback when retries are exhausted (throws)", async () => {
    const runLLM = mockRunLLM(
      new Error("blip 1"),
      new Error("blip 2"),
      new Error("blip 3"),
    );
    const result = await runWithRetry({
      runLLM, config: {}, prompt: "p",
      maxRetries: 2,
      fallback: "fallback-value",
    });
    expect(result).toBe("fallback-value");
  });

  test("fallback can be any value (object, null, string)", async () => {
    const runLLM = mockRunLLM("bad");
    const fallback = { error: "all attempts failed" };
    const result = await runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate: failValidator, maxRetries: 0,
      fallback,
    });
    expect(result).toEqual(fallback);
  });

  test("fallback: null is treated as a valid fallback value", async () => {
    const runLLM = mockRunLLM("bad");
    const result = await runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate: failValidator, maxRetries: 0,
      fallback: null,
    });
    expect(result).toBeNull();
  });

  test("fallback: undefined does NOT trigger fallback path", async () => {
    // Explicit undefined fallback should still throw — it's the
    // same as not providing fallback at all.
    const runLLM = mockRunLLM("bad");
    await expect(runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate: failValidator, maxRetries: 0,
      fallback: undefined,
    })).rejects.toThrow(/failed after 1 attempts/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("runWithRetry — input validation", () => {
  test("throws when runLLM is missing", async () => {
    await expect(runWithRetry({
      config: {}, prompt: "p",
      validate: okValidator,
    })).rejects.toThrow(/runLLM must be a function/);
  });

  test("throws when runLLM is not a function", async () => {
    await expect(runWithRetry({
      runLLM: "not a function",
      config: {}, prompt: "p",
    })).rejects.toThrow(/runLLM must be a function/);
  });

  test("throws when no options object provided", async () => {
    await expect(runWithRetry()).rejects.toThrow(/runLLM must be a function/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error metadata on exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe("runWithRetry — error metadata", () => {
  test("error includes attempts count", async () => {
    const runLLM = mockRunLLM("bad", "bad", "bad");
    try {
      await runWithRetry({
        runLLM, config: {}, prompt: "p",
        validate: failValidator, maxRetries: 2,
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err.attempts).toBe(3);
    }
  });

  test("error includes errors array", async () => {
    const runLLM = mockRunLLM("bad", "bad");
    try {
      await runWithRetry({
        runLLM, config: {}, prompt: "p",
        validate: failValidator, maxRetries: 1,
      });
    } catch (err) {
      expect(Array.isArray(err.errors)).toBe(true);
      expect(err.errors.length).toBe(2);
      expect(err.errors[0]).toContain("attempt 1");
      expect(err.errors[1]).toContain("attempt 2");
    }
  });

  test("error includes lastOutput from final attempt", async () => {
    const runLLM = mockRunLLM("first-bad", "second-bad", "third-bad");
    try {
      await runWithRetry({
        runLLM, config: {}, prompt: "p",
        validate: failValidator, maxRetries: 2,
      });
    } catch (err) {
      expect(err.lastOutput).toBe("third-bad");
    }
  });

  test("error.lastOutput is undefined when all attempts threw", async () => {
    const runLLM = mockRunLLM(
      new Error("blip 1"),
      new Error("blip 2"),
    );
    try {
      await runWithRetry({
        runLLM, config: {}, prompt: "p",
        maxRetries: 1,
      });
    } catch (err) {
      expect(err.lastOutput).toBeUndefined();
    }
  });

  test("validator errors are propagated into the thrown message", async () => {
    const runLLM = mockRunLLM("bad");
    const validate = () => ({ valid: false, errors: ["missing H1", "wrong shape"] });
    try {
      await runWithRetry({
        runLLM, config: {}, prompt: "p",
        validate, maxRetries: 0,
      });
    } catch (err) {
      expect(err.message).toMatch(/missing H1/);
      expect(err.message).toMatch(/wrong shape/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validator robustness
// ─────────────────────────────────────────────────────────────────────────────

describe("runWithRetry — validator robustness", () => {
  test("validator without errors array still works", async () => {
    const runLLM = mockRunLLM("bad", "bad");
    const validate = () => ({ valid: false });  // no errors field
    try {
      await runWithRetry({
        runLLM, config: {}, prompt: "p",
        validate, maxRetries: 1,
      });
    } catch (err) {
      expect(err.errors.length).toBe(2);
      expect(err.errors[0]).toContain("validation failed");
    }
  });

  test("validator returning null treated as invalid", async () => {
    // Defensive — if a validator misbehaves and returns null, we
    // shouldn't crash; we should treat it as invalid and retry.
    const runLLM = mockRunLLM("bad", "bad");
    const validate = () => null;
    await expect(runWithRetry({
      runLLM, config: {}, prompt: "p",
      validate, maxRetries: 1,
    })).rejects.toThrow();
  });

  test("alwaysValid helper exported", () => {
    expect(typeof alwaysValid).toBe("function");
    expect(alwaysValid()).toEqual({ valid: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

describe("runWithRetry — module export", () => {
  test("module is the function", () => {
    expect(typeof runWithRetry).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(runWithRetry)).toBe(true);
  });

  test("self-referential .runWithRetry property", () => {
    expect(runWithRetry.runWithRetry).toBe(runWithRetry);
  });

  test("exposes alwaysValid helper", () => {
    expect(typeof runWithRetry.alwaysValid).toBe("function");
  });
});