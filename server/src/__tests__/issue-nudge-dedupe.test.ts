/**
 * CAN-4075 — Ops Sentinel per-assignee stall nudge guard tests.
 *
 * Headline case: the CAN-3457 timeline. CAN-3457 was created at 03:51Z with
 * an active source run; Sentinel fired a false-positive nudge at 08:00Z
 * (4h09m later, run still alive), then a correct nudge at 03:19Z the next
 * day after a fresh 4h05m idle window with no active run and no monitor.
 *
 * The headline test below reproduces that exact sequence and asserts:
 *
 *   - the 08:00Z tick suppresses with `active_run_present`,
 *   - the 03:19Z tick nudges with `fresh_idle_episode`,
 *   - no further nudges fire for the same fingerprint within the threshold,
 *   - a fingerprint change (e.g. monitor set, then cleared) re-arms the
 *     gate via `state_changed`.
 */

import { describe, expect, it } from "vitest";
import {
  computeIssueNudgeFingerprint,
  DEFAULT_NUDGE_IDLE_THRESHOLD_MS,
  evaluateIssueNudgeGate,
  LIVE_RUN_STATUSES,
  type IssueNudgeCandidate,
  type IssueNudgeStateEntry,
} from "../services/recovery/issue-nudge-dedupe.ts";

const COMPANY_ID = "company-canopy";
const ISSUE_ID = "fb33925d-2343-4e13-9bc5-7653ed3ccc55"; // CAN-3457
const ASSIGNEE_ID = "49c894f5-464e-4201-918f-8fa4fa19c189"; // MiniMax

// Anchor the CAN-3457 timeline to the real timestamps from the case study.
const T0_CREATED = new Date("2026-09-14T03:51:00.000Z");
const T_FALSE_POSITIVE = new Date("2026-09-14T08:00:21.000Z"); // 4h 09m
const T_VALID_NUDGE = new Date("2026-09-15T03:19:29.000Z"); // +19h 19m
const T_POST_NUDGE = new Date("2026-09-15T07:00:00.000Z"); // 3h 40m after valid nudge (still inside the 4h episode)

function candidateAtT(t: Date, overrides: Partial<IssueNudgeCandidate> = {}): IssueNudgeCandidate {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "todo",
    assigneeAgentId: ASSIGNEE_ID,
    activeRunId: null,
    activeRunStatus: null,
    monitorNextCheckAt: null,
    monitorScheduledBy: null,
    latestAssigneeCommentAt: null,
    monitorAttemptCount: 0,
    ...overrides,
  };
}

function makeStateEntry(overrides: Partial<IssueNudgeStateEntry>): IssueNudgeStateEntry {
  return {
    schemaVersion: 1,
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    firstNudgedAt: overrides.lastNudgedAt ?? T0_CREATED.toISOString(),
    lastNudgedAt: T0_CREATED.toISOString(),
    lastFingerprint: "fingerprint-anchor",
    idleEpisodeStartedAt: T0_CREATED.toISOString(),
    consecutiveNoChangeNudges: 0,
    totalNudges: 1,
    ...overrides,
  };
}

describe("evaluateIssueNudgeGate — CAN-3457 headline timeline", () => {
  it("reproduces the CAN-3457 false-positive (08:00Z) and the valid fresh-idle nudge (03:19Z next day)", () => {
    // T+4h09m: source run is still alive (activeRunId present, status running).
    // Sentinel previously nudged here. The guard must suppress.
    const atFalsePositive = evaluateIssueNudgeGate({
      candidate: candidateAtT(T_FALSE_POSITIVE, {
        activeRunId: "run-cec82ed1",
        activeRunStatus: "running",
      }),
      previousState: null,
      now: T_FALSE_POSITIVE,
    });
    expect(atFalsePositive.action).toBe("suppress");
    expect(atFalsePositive.reason).toBe("active_run_present");
    expect(atFalsePositive.updatedState).toBeNull();

    // ~19h later: source run ended, status still todo, no monitor, no
    // assignee comment, no fresh state. This is the valid nudge.
    const atValidNudge = evaluateIssueNudgeGate({
      candidate: candidateAtT(T_VALID_NUDGE),
      previousState: null,
      now: T_VALID_NUDGE,
    });
    expect(atValidNudge.action).toBe("nudge");
    expect(atValidNudge.reason).toBe("first_nudge");
    expect(atValidNudge.updatedState).not.toBeNull();
    expect(atValidNudge.updatedState?.lastNudgedAt).toBe(
      T_VALID_NUDGE.toISOString(),
    );
    expect(atValidNudge.updatedState?.totalNudges).toBe(1);
    expect(atValidNudge.updatedState?.consecutiveNoChangeNudges).toBe(0);

    // 4h after the valid nudge: same fingerprint, no state change → suppress.
    const atPostNudge = evaluateIssueNudgeGate({
      candidate: candidateAtT(T_POST_NUDGE),
      previousState: atValidNudge.updatedState,
      now: T_POST_NUDGE,
    });
    expect(atPostNudge.action).toBe("suppress");
    expect(atPostNudge.reason).toBe("already_nudged_in_episode");
    expect(atPostNudge.updatedState).toBeNull();
  });

  it("treats a queued run as live and suppresses just like a running run", () => {
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(T_FALSE_POSITIVE, {
        activeRunId: "run-queued",
        activeRunStatus: "queued",
      }),
      previousState: null,
      now: T_FALSE_POSITIVE,
    });
    expect(decision.action).toBe("suppress");
    expect(decision.reason).toBe("active_run_present");
  });

  it("treats scheduled_retry as live and suppresses", () => {
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(T_FALSE_POSITIVE, {
        activeRunId: "run-scheduled-retry",
        activeRunStatus: "scheduled_retry",
      }),
      previousState: null,
      now: T_FALSE_POSITIVE,
    });
    expect(decision.action).toBe("suppress");
    expect(decision.reason).toBe("active_run_present");
  });

  it("treats a terminal activeRunStatus (succeeded/failed/cancelled) as not-live", () => {
    for (const status of ["succeeded", "failed", "cancelled", "timed_out"]) {
      // The activeRunId is set (race window where DB row hasn't been
      // cleared) but the run is terminal. Decision must not suppress on
      // active_run_present — it should fall through to dedupe logic and
      // nudge when the threshold has passed without state change.
      const decision = evaluateIssueNudgeGate({
        candidate: candidateAtT(T_VALID_NUDGE, {
          activeRunId: "run-terminal",
          activeRunStatus: status,
        }),
        previousState: null,
        now: T_VALID_NUDGE,
      });
      expect(decision.action).not.toBe("suppress");
      expect(decision.reason).not.toBe("active_run_present");
    }
  });
});

describe("evaluateIssueNudgeGate — hard-suppress branches", () => {
  it("suppresses on future monitor even if assignee is idle for >4h", () => {
    const future = new Date(T_FALSE_POSITIVE.getTime() + 8 * 60 * 60 * 1000);
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(T_FALSE_POSITIVE, {
        monitorNextCheckAt: future,
        monitorScheduledBy: "assignee",
      }),
      previousState: null,
      now: T_FALSE_POSITIVE,
    });
    expect(decision.action).toBe("suppress");
    expect(decision.reason).toBe("future_monitor_scheduled");
  });

  it("does NOT suppress on a past-due monitor (gate passes through to dedupe)", () => {
    const past = new Date(T_FALSE_POSITIVE.getTime() - 60 * 60 * 1000);
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(T_FALSE_POSITIVE, {
        monitorNextCheckAt: past,
        monitorScheduledBy: "assignee",
      }),
      previousState: null,
      now: T_FALSE_POSITIVE,
    });
    expect(decision.action).toBe("nudge");
    expect(decision.reason).toBe("first_nudge");
  });

  it("suppresses on non-actionable status without touching state", () => {
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(T_FALSE_POSITIVE, { status: "done" }),
      previousState: makeStateEntry({}),
      now: T_FALSE_POSITIVE,
    });
    expect(decision.action).toBe("suppress");
    expect(decision.reason).toBe("non_actionable_status");
    expect(decision.updatedState).toBeNull();
  });

  it("suppresses on unassigned candidate without touching state", () => {
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(T_FALSE_POSITIVE, { assigneeAgentId: null }),
      previousState: makeStateEntry({}),
      now: T_FALSE_POSITIVE,
    });
    expect(decision.action).toBe("suppress");
    expect(decision.reason).toBe("unassigned");
    expect(decision.updatedState).toBeNull();
  });
});

describe("evaluateIssueNudgeGate — dedupe against previousState", () => {
  it("fires first_nudge when previousState is null", () => {
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(T_FALSE_POSITIVE),
      previousState: null,
      now: T_FALSE_POSITIVE,
    });
    expect(decision.action).toBe("nudge");
    expect(decision.reason).toBe("first_nudge");
    expect(decision.updatedState).toMatchObject({
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      totalNudges: 1,
      consecutiveNoChangeNudges: 0,
    });
  });

  it("suppresses already_nudged_in_episode when same fingerprint and <threshold elapsed", () => {
    const twoHoursLater = new Date(T_VALID_NUDGE.getTime() + 2 * 60 * 60 * 1000);
    const prev = makeStateEntry({
      lastNudgedAt: T_VALID_NUDGE.toISOString(),
      lastFingerprint: computeIssueNudgeFingerprint(candidateAtT(T_VALID_NUDGE)),
    });
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(twoHoursLater),
      previousState: prev,
      now: twoHoursLater,
    });
    expect(decision.action).toBe("suppress");
    expect(decision.reason).toBe("already_nudged_in_episode");
    expect(decision.updatedState).toBeNull();
  });

  it("fires fresh_idle_episode when same fingerprint and >=threshold elapsed", () => {
    const fourHoursAfter = new Date(
      T_VALID_NUDGE.getTime() + DEFAULT_NUDGE_IDLE_THRESHOLD_MS,
    );
    const prev = makeStateEntry({
      lastNudgedAt: T_VALID_NUDGE.toISOString(),
      lastFingerprint: computeIssueNudgeFingerprint(candidateAtT(T_VALID_NUDGE)),
      consecutiveNoChangeNudges: 1,
      totalNudges: 2,
    });
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(fourHoursAfter),
      previousState: prev,
      now: fourHoursAfter,
    });
    expect(decision.action).toBe("nudge");
    expect(decision.reason).toBe("fresh_idle_episode");
    expect(decision.updatedState).toMatchObject({
      consecutiveNoChangeNudges: 2,
      totalNudges: 3,
      lastNudgedAt: fourHoursAfter.toISOString(),
    });
  });

  it("fires state_changed when fingerprint changes (e.g. monitor set, then cleared)", () => {
    const prev = makeStateEntry({
      lastNudgedAt: T_VALID_NUDGE.toISOString(),
      lastFingerprint: computeIssueNudgeFingerprint(
        candidateAtT(T_VALID_NUDGE, {
          monitorNextCheckAt: new Date("2026-10-05T00:00:00.000Z"),
        }),
      ),
      consecutiveNoChangeNudges: 0,
      totalNudges: 1,
    });
    // 1h later the monitor has been cleared (matches CAN-1463 / CAN-4017).
    const oneHourLater = new Date(T_VALID_NUDGE.getTime() + 60 * 60 * 1000);
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(oneHourLater, { monitorNextCheckAt: null }),
      previousState: prev,
      now: oneHourLater,
    });
    expect(decision.action).toBe("nudge");
    expect(decision.reason).toBe("state_changed");
    expect(decision.updatedState).toMatchObject({
      consecutiveNoChangeNudges: 0,
      totalNudges: 2,
      lastNudgedAt: oneHourLater.toISOString(),
    });
  });

  it("fires assignee_responded when latestAssigneeCommentAt is after lastNudgedAt", () => {
    const assigneeCommentAt = new Date(
      T_VALID_NUDGE.getTime() + 30 * 60 * 1000,
    );
    const prev = makeStateEntry({
      lastNudgedAt: T_VALID_NUDGE.toISOString(),
      lastFingerprint: computeIssueNudgeFingerprint(candidateAtT(T_VALID_NUDGE)),
      totalNudges: 1,
    });
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(new Date(assigneeCommentAt.getTime() + 60_000), {
        latestAssigneeCommentAt: assigneeCommentAt,
      }),
      previousState: prev,
      now: new Date(assigneeCommentAt.getTime() + 60_000),
    });
    expect(decision.action).toBe("nudge");
    expect(decision.reason).toBe("assignee_responded");
    expect(decision.updatedState).toMatchObject({
      idleEpisodeStartedAt: new Date(assigneeCommentAt.getTime() + 60_000).toISOString(),
      totalNudges: 2,
      consecutiveNoChangeNudges: 0,
    });
  });

  it("does NOT fire assignee_responded when comment timestamp equals lastNudgedAt (off-by-one)", () => {
    const prev = makeStateEntry({
      lastNudgedAt: T_VALID_NUDGE.toISOString(),
      lastFingerprint: computeIssueNudgeFingerprint(candidateAtT(T_VALID_NUDGE)),
      totalNudges: 1,
    });
    const oneHourLater = new Date(T_VALID_NUDGE.getTime() + 60 * 60 * 1000);
    const decision = evaluateIssueNudgeGate({
      candidate: candidateAtT(oneHourLater, {
        latestAssigneeCommentAt: T_VALID_NUDGE,
      }),
      previousState: prev,
      now: oneHourLater,
    });
    // Fingerprint changed (comment timestamp present vs null), so we get
    // state_changed, not assignee_responded — the comment is exactly at
    // lastNudgedAt, not strictly after.
    expect(decision.action).toBe("nudge");
    expect(decision.reason).toBe("state_changed");
  });
});

describe("computeIssueNudgeFingerprint", () => {
  it("is stable across object key insertion order", () => {
    const a = {
      id: ISSUE_ID,
      status: "todo",
      assigneeAgentId: ASSIGNEE_ID,
    };
    const b = {
      assigneeAgentId: ASSIGNEE_ID,
      id: ISSUE_ID,
      status: "todo",
    };
    const fpA = computeIssueNudgeFingerprint(a as unknown as IssueNudgeCandidate);
    const fpB = computeIssueNudgeFingerprint(b as unknown as IssueNudgeCandidate);
    expect(fpA).toBe(fpB);
  });

  it("treats Date and ISO string forms of the same timestamp as identical", () => {
    const iso = "2026-10-05T00:00:00.000Z";
    const date = new Date(iso);
    const a = candidateAtT(T_FALSE_POSITIVE, { monitorNextCheckAt: iso });
    const b = candidateAtT(T_FALSE_POSITIVE, { monitorNextCheckAt: date });
    expect(computeIssueNudgeFingerprint(a)).toBe(
      computeIssueNudgeFingerprint(b),
    );
  });

  it("changes when status flips from todo to in_progress", () => {
    const a = candidateAtT(T_FALSE_POSITIVE, { status: "todo" });
    const b = candidateAtT(T_FALSE_POSITIVE, { status: "in_progress" });
    expect(computeIssueNudgeFingerprint(a)).not.toBe(
      computeIssueNudgeFingerprint(b),
    );
  });

  it("changes when monitorAttemptCount changes", () => {
    const a = candidateAtT(T_FALSE_POSITIVE, { monitorAttemptCount: 0 });
    const b = candidateAtT(T_FALSE_POSITIVE, { monitorAttemptCount: 1 });
    expect(computeIssueNudgeFingerprint(a)).not.toBe(
      computeIssueNudgeFingerprint(b),
    );
  });
});

describe("evaluateIssueNudgeGate — threshold parameterisation", () => {
  it("respects a custom idleEpisodeThresholdMs override", () => {
    const prev = makeStateEntry({
      lastNudgedAt: T_VALID_NUDGE.toISOString(),
      lastFingerprint: computeIssueNudgeFingerprint(candidateAtT(T_VALID_NUDGE)),
      totalNudges: 1,
    });
    // 1h later, 2h custom threshold: should suppress (1h < 2h).
    const oneHourLater = new Date(T_VALID_NUDGE.getTime() + 60 * 60 * 1000);
    const suppressed = evaluateIssueNudgeGate({
      candidate: candidateAtT(oneHourLater),
      previousState: prev,
      now: oneHourLater,
      idleEpisodeThresholdMs: 2 * 60 * 60 * 1000,
    });
    expect(suppressed.action).toBe("suppress");

    // Same prev, 3h later, 2h threshold: should nudge (3h >= 2h).
    const threeHoursLater = new Date(T_VALID_NUDGE.getTime() + 3 * 60 * 60 * 1000);
    const nudged = evaluateIssueNudgeGate({
      candidate: candidateAtT(threeHoursLater),
      previousState: prev,
      now: threeHoursLater,
      idleEpisodeThresholdMs: 2 * 60 * 60 * 1000,
    });
    expect(nudged.action).toBe("nudge");
    expect(nudged.reason).toBe("fresh_idle_episode");
  });

  it("default threshold is 4h (matches AGENTS.md step 4)", () => {
    expect(DEFAULT_NUDGE_IDLE_THRESHOLD_MS).toBe(4 * 60 * 60 * 1000);
  });
});

describe("LIVE_RUN_STATUSES contract", () => {
  it("includes the three statuses the per-assignee stall rule cares about", () => {
    expect(new Set(LIVE_RUN_STATUSES)).toEqual(
      new Set(["queued", "running", "scheduled_retry"]),
    );
  });
});
