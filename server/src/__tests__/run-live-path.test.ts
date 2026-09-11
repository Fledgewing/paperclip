import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_QUEUED_RUN_MS,
  isRunLivePath,
  resolveStaleQueuedRunMs,
  STALE_QUEUED_RUN_MS,
} from "../services/run-live-path.ts";

const now = new Date("2026-09-10T12:00:00.000Z");

describe("isRunLivePath", () => {
  it("treats a fresh queued run as live", () => {
    expect(
      isRunLivePath(
        {
          status: "queued",
          startedAt: null,
          createdAt: new Date(now.getTime() - 15 * 60 * 1000),
        },
        now,
      ),
    ).toBe(true);
  });

  it("treats a queued run past the stale bound as not live", () => {
    expect(
      isRunLivePath(
        {
          status: "queued",
          startedAt: null,
          createdAt: new Date(now.getTime() - DEFAULT_STALE_QUEUED_RUN_MS - 1),
        },
        now,
      ),
    ).toBe(false);
  });

  it("treats a queued run exactly at the bound as live", () => {
    expect(
      isRunLivePath(
        {
          status: "queued",
          startedAt: null,
          createdAt: new Date(now.getTime() - DEFAULT_STALE_QUEUED_RUN_MS),
        },
        now,
      ),
    ).toBe(true);
  });

  it("treats a running run as live regardless of age", () => {
    expect(
      isRunLivePath(
        {
          status: "running",
          startedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
          createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
        },
        now,
      ),
    ).toBe(true);
  });

  it("treats finished and cancelled runs as not live", () => {
    expect(isRunLivePath({ status: "succeeded", createdAt: now }, now)).toBe(false);
    expect(isRunLivePath({ status: "failed", createdAt: now }, now)).toBe(false);
    expect(isRunLivePath({ status: "cancelled", createdAt: now }, now)).toBe(false);
    expect(isRunLivePath({ status: "interrupted", createdAt: now }, now)).toBe(false);
    expect(isRunLivePath({ status: "timed_out", createdAt: now }, now)).toBe(false);
  });

  it("treats a queued run with startedAt set as live", () => {
    expect(
      isRunLivePath(
        {
          status: "queued",
          startedAt: new Date(now.getTime() - DEFAULT_STALE_QUEUED_RUN_MS - 60_000),
          createdAt: new Date(now.getTime() - DEFAULT_STALE_QUEUED_RUN_MS - 120_000),
        },
        now,
      ),
    ).toBe(true);
  });

  it("keeps a queued run live when createdAt is missing", () => {
    expect(isRunLivePath({ status: "queued", startedAt: null }, now)).toBe(true);
  });
});

describe("STALE_QUEUED_RUN_MS", () => {
  it("defaults to two hours", () => {
    expect(DEFAULT_STALE_QUEUED_RUN_MS).toBe(2 * 60 * 60 * 1000);
    expect(STALE_QUEUED_RUN_MS).toBe(DEFAULT_STALE_QUEUED_RUN_MS);
  });

  it("resolves a positive env override and ignores invalid values", () => {
    expect(resolveStaleQueuedRunMs("60000")).toBe(60_000);
    expect(resolveStaleQueuedRunMs("0")).toBe(DEFAULT_STALE_QUEUED_RUN_MS);
    expect(resolveStaleQueuedRunMs("nope")).toBe(DEFAULT_STALE_QUEUED_RUN_MS);
    expect(resolveStaleQueuedRunMs(undefined)).toBe(DEFAULT_STALE_QUEUED_RUN_MS);
  });
});
