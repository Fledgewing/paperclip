import { describe, expect, it } from "vitest";
import { RUN_OUTPUT_FINALIZE_GRACE_MS, isFinalizeGraceActive } from "./service.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const run = (lastOutputAt: Date | string | null) =>
  ({ lastOutputAt } as unknown as Parameters<typeof isFinalizeGraceActive>[0]);
const agoMs = (ms: number) => new Date(now.getTime() - ms);

describe("orphan-terminalization finalize grace", () => {
  it("defers while output is fresh, so the harness's own finalize write wins the race", () => {
    // The exact regression: the agent process exits, flushOutputProgress writes
    // lastOutputAt, and the sweep fires before setRunStatusIfRunning lands.
    expect(isFinalizeGraceActive(run(agoMs(1_000)), now)).toBe(true);
    expect(isFinalizeGraceActive(run(agoMs(RUN_OUTPUT_FINALIZE_GRACE_MS - 1)), now)).toBe(true);
  });

  it("does not defer once the grace window lapses, so genuinely abandoned runs still terminalize", () => {
    expect(isFinalizeGraceActive(run(agoMs(RUN_OUTPUT_FINALIZE_GRACE_MS)), now)).toBe(false);
    expect(isFinalizeGraceActive(run(agoMs(5 * 60 * 1000)), now)).toBe(false);
  });

  it("does not defer when the run never recorded output", () => {
    expect(isFinalizeGraceActive(run(null), now)).toBe(false);
  });

  it("does not defer on an unparseable or future lastOutputAt", () => {
    // A clock skew into the future must not grant an unbounded reprieve.
    expect(isFinalizeGraceActive(run("not-a-date"), now)).toBe(false);
    expect(isFinalizeGraceActive(run(new Date(now.getTime() + 1_000)), now)).toBe(false);
  });

  it("accepts a serialized timestamp, matching what the row carries over the wire", () => {
    expect(isFinalizeGraceActive(run(agoMs(2_000).toISOString()), now)).toBe(true);
  });

  it("floors the env override so it cannot be configured to zero", () => {
    expect(RUN_OUTPUT_FINALIZE_GRACE_MS).toBeGreaterThanOrEqual(1_000);
  });
});
