import { describe, expect, it } from "vitest";

import { resolveHeartbeatRunAgeLimits } from "./heartbeat.js";

// Documented defaults for CAN-3606. The test pins the defaults so any
// accidental change to the baseline ceilings is caught at unit-test time.
const EXPECTED_DEFAULT_ACTIVE_RUN_MAX_AGE_MS = 60 * 60 * 1000;
const EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS = 60 * 60 * 1000;

describe("resolveHeartbeatRunAgeLimits", () => {
  it("returns the documented defaults when no env overrides are set", () => {
    const limits = resolveHeartbeatRunAgeLimits({});
    expect(limits.activeRunMaxAgeMs).toBe(EXPECTED_DEFAULT_ACTIVE_RUN_MAX_AGE_MS);
    expect(limits.queuedRunMaxAgeMs).toBe(EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS);
  });

  it("applies independent overrides for the active and queued ceilings", () => {
    const limits = resolveHeartbeatRunAgeLimits({
      PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "14400000",
      PAPERCLIP_HEARTBEAT_QUEUED_RUN_MAX_AGE_MS: "1800000",
    });
    expect(limits.activeRunMaxAgeMs).toBe(14_400_000);
    expect(limits.queuedRunMaxAgeMs).toBe(1_800_000);
  });

  it("falls back to defaults for malformed, blank, or negative values", () => {
    const fallback = {
      activeRunMaxAgeMs: EXPECTED_DEFAULT_ACTIVE_RUN_MAX_AGE_MS,
      queuedRunMaxAgeMs: EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS,
    };
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "",
      }),
    ).toEqual(fallback);
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_QUEUED_RUN_MAX_AGE_MS: "  ",
      }),
    ).toEqual(fallback);
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "not-a-number",
      }),
    ).toEqual(fallback);
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "-1000",
      }),
    ).toEqual(fallback);
  });

  it("treats each env override as an independent knob (one does not bleed into the other)", () => {
    const limits = resolveHeartbeatRunAgeLimits({
      PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "7200000",
    });
    expect(limits.activeRunMaxAgeMs).toBe(7_200_000);
    expect(limits.queuedRunMaxAgeMs).toBe(EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS);
  });

  // Greptile Issue 4 regression: `Number.parseInt` silently truncates
  // partially-parseable strings (e.g. "1.5" -> 1, "1e6" -> 1, "1000ms" -> 1000).
  // The resolver must validate the *complete* trimmed value as a non-negative
  // integer and fall back to the default for anything else.
  it("rejects partially-parseable and suffix-decorated values (Greptile Issue 4)", () => {
    const fallback = {
      activeRunMaxAgeMs: EXPECTED_DEFAULT_ACTIVE_RUN_MAX_AGE_MS,
      queuedRunMaxAgeMs: EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS,
    };
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "1.5",
      }),
    ).toEqual(fallback);
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_QUEUED_RUN_MAX_AGE_MS: "1e6",
      }),
    ).toEqual(fallback);
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "1000ms",
      }),
    ).toEqual(fallback);
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_QUEUED_RUN_MAX_AGE_MS: " 1 ",
      }),
    ).toEqual({ ...fallback, queuedRunMaxAgeMs: 1 });
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "1ms",
      }),
    ).toEqual(fallback);
  });

  it("accepts boundary values including 0, MAX_SAFE_INTEGER, and rejects above MAX_SAFE_INTEGER (Greptile Issue 4)", () => {
    // 0 disables the ceiling (documented).
    const zeroLimits = resolveHeartbeatRunAgeLimits({
      PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "0",
    });
    expect(zeroLimits.activeRunMaxAgeMs).toBe(0);
    expect(zeroLimits.queuedRunMaxAgeMs).toBe(
      EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS,
    );

    // Number.MAX_SAFE_INTEGER is accepted exactly.
    const maxSafeLimits = resolveHeartbeatRunAgeLimits({
      PAPERCLIP_HEARTBEAT_QUEUED_RUN_MAX_AGE_MS: "9007199254740991",
    });
    expect(maxSafeLimits.queuedRunMaxAgeMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(maxSafeLimits.activeRunMaxAgeMs).toBe(
      EXPECTED_DEFAULT_ACTIVE_RUN_MAX_AGE_MS,
    );

    // Above MAX_SAFE_INTEGER falls back (not a safe integer).
    const fallback = {
      activeRunMaxAgeMs: EXPECTED_DEFAULT_ACTIVE_RUN_MAX_AGE_MS,
      queuedRunMaxAgeMs: EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS,
    };
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "9007199254740992",
      }),
    ).toEqual(fallback);
  });

  it("rejects negative integers even when signed strings look parseable (Greptile Issue 4)", () => {
    const fallback = {
      activeRunMaxAgeMs: EXPECTED_DEFAULT_ACTIVE_RUN_MAX_AGE_MS,
      queuedRunMaxAgeMs: EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS,
    };
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: "-1",
      }),
    ).toEqual(fallback);
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_QUEUED_RUN_MAX_AGE_MS: "-0",
      }),
    ).toEqual(fallback);
  });

  it("treats missing keys as undefined (not the empty string)", () => {
    // `env[name]` is `undefined` when the key is absent; both undefined and
    // empty string must fall back, but they must do so identically.
    const fallback = {
      activeRunMaxAgeMs: EXPECTED_DEFAULT_ACTIVE_RUN_MAX_AGE_MS,
      queuedRunMaxAgeMs: EXPECTED_DEFAULT_QUEUED_RUN_MAX_AGE_MS,
    };
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: undefined,
      }),
    ).toEqual(fallback);
    expect(
      resolveHeartbeatRunAgeLimits({
        PAPERCLIP_HEARTBEAT_ACTIVE_RUN_MAX_AGE_MS: undefined,
        PAPERCLIP_HEARTBEAT_QUEUED_RUN_MAX_AGE_MS: undefined,
      }),
    ).toEqual(fallback);
  });
});
