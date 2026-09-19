/**
 * CAN-5062 — Ops Sentinel sweep read-integrity guard tests.
 *
 * Two headline regressions, both reproduced verbatim from the incident:
 *
 *   - **CAN-5058** (2026-09-19T00:08:25Z, `critical`): "board fully parked —
 *     no dispatchable work" raised against a board holding ~139 dispatchable
 *     issues, on the evidence `Status counts: {}`. The dispositive tell is
 *     that the same body reported "blocked issues with empty blockedBy: none"
 *     — a predicate that cannot return zero on a successful read, because
 *     `blockedByIssueIds` is write-only and absent from the list route.
 *
 *   - **CAN-5059** (2026-09-19T00:11:06Z, `high`): "pipeline fully idle with
 *     open work" raised from `GET /api/companies/{id}/runs` → 404 and
 *     `GET /api/runs` → 404, both coerced to `[]`. CEO re-verified at
 *     00:20:08Z: 50 live runs, 57 runs finished inside the 45m window.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_ISSUE_STATUSES,
  assertListResponseOk,
  assertPaginationComplete,
  assertStatusFilterHonoured,
  CANONICAL_ENDPOINTS,
  DEFAULT_UNIVERSE_FLOOR,
  ENDPOINTS_IGNORING_STATUS_FILTER,
  evaluateStarvationAlarm,
  formatStatusCountsBlock,
  INSTRUMENTATION_FAULT_PREFIX,
  ISSUE_LIST_LIMIT_CLAMP,
  KNOWN_NONEXISTENT_RUN_ENDPOINTS,
  planIssuePagination,
  starvationAlarmSubject,
  starvationAlarmTitle,
  summarizeIssueUniverse,
  SweepReadFaultError,
  type SweepListRead,
} from "../services/recovery/ops-sentinel-sweep-guard.ts";

const COMPANY_ID = "6cbe52e6-961b-415b-aa8b-2d649dc43497";
const NOW = new Date("2026-09-19T00:08:25.000Z");

const ISSUES_URL = CANONICAL_ENDPOINTS.issues(COMPANY_ID);
const LIVE_RUNS_URL = CANONICAL_ENDPOINTS.liveRuns(COMPANY_ID);
const HEARTBEAT_RUNS_URL = CANONICAL_ENDPOINTS.heartbeatRuns(COMPANY_ID);

/** The board as it actually stood at CAN-5058 time: ~479 issues, 139 dispatchable. */
function realBoard(): Array<{ status: string }> {
  return [
    ...repeat("in_progress", 86),
    ...repeat("todo", 53),
    ...repeat("in_review", 8),
    ...repeat("blocked", 74),
    ...repeat("backlog", 58),
    ...repeat("done", 190),
    ...repeat("cancelled", 10),
  ];
}

function repeat(status: string, n: number): Array<{ status: string }> {
  return Array.from({ length: n }, () => ({ status }));
}

function okRead(
  url: string,
  count: number,
  transportId = "sentinel-list-helper",
): SweepListRead {
  return { url, ok: true, httpStatus: 200, count, transportId };
}

function failedRead(
  url: string,
  httpStatus: number | null,
  transportId = "sentinel-list-helper",
): SweepListRead {
  return {
    url,
    ok: false,
    httpStatus,
    count: 0,
    transportId,
    faultKind: "non_2xx",
    faultMessage: `HTTP ${httpStatus}`,
  };
}

describe("assertListResponseOk (guard 1 — non-2xx is a fault, never [])", () => {
  it("returns the array on a 200", () => {
    expect(assertListResponseOk({ url: LIVE_RUNS_URL, httpStatus: 200, body: [1, 2] }))
      .toEqual([1, 2]);
  });

  it.each(KNOWN_NONEXISTENT_RUN_ENDPOINTS)(
    "throws rather than returning [] for a 404 from the guessed path %s",
    (path) => {
      expect(() =>
        assertListResponseOk({ url: path, httpStatus: 404, body: { error: "Not found" } }),
      ).toThrow(SweepReadFaultError);
    },
  );

  it("classifies a non-2xx as faultKind non_2xx and keeps the status", () => {
    try {
      assertListResponseOk({ url: "/api/runs", httpStatus: 404, body: null });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SweepReadFaultError);
      const fault = error as SweepReadFaultError;
      expect(fault.faultKind).toBe("non_2xx");
      expect(fault.httpStatus).toBe(404);
      expect(fault.url).toBe("/api/runs");
    }
  });

  it.each([401, 403, 500, 502, 504])("treats HTTP %i as a fault", (status) => {
    expect(() =>
      assertListResponseOk({ url: ISSUES_URL, httpStatus: status, body: [] }),
    ).toThrow(SweepReadFaultError);
  });

  it("rejects a 200 whose body is an error envelope, not an array", () => {
    // The same bug wearing a 200: `Array.isArray(x) ? x : []`.
    try {
      assertListResponseOk({
        url: ISSUES_URL,
        httpStatus: 200,
        body: { error: "company not found" },
      });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as SweepReadFaultError).faultKind).toBe("unexpected_shape");
    }
  });

  it("rejects a 200 with a null body", () => {
    expect(() =>
      assertListResponseOk({ url: ISSUES_URL, httpStatus: 200, body: null }),
    ).toThrow(/not a JSON array/);
  });

  it("accepts a legitimately empty 200 array (emptiness is the gate's job, not the reader's)", () => {
    expect(assertListResponseOk({ url: ISSUES_URL, httpStatus: 200, body: [] })).toEqual([]);
  });
});

describe("assertStatusFilterHonoured (guard 2 — ?status= is proven, not assumed)", () => {
  it("passes when every row carries the requested status", () => {
    const items = repeat("todo", 3);
    expect(
      assertStatusFilterHonoured(items, {
        url: `${ISSUES_URL}?status=todo`,
        requestedStatus: "todo",
      }),
    ).toBe(items);
  });

  it("faults when the route ignored the filter and returned mixed statuses", () => {
    const items = [...repeat("todo", 2), ...repeat("done", 5), ...repeat("blocked", 1)];
    try {
      assertStatusFilterHonoured(items, {
        url: `${HEARTBEAT_RUNS_URL}?status=todo`,
        requestedStatus: "todo",
      });
      throw new Error("expected a throw");
    } catch (error) {
      const fault = error as SweepReadFaultError;
      expect(fault.faultKind).toBe("status_filter_ignored");
      expect(fault.message).toContain("6 item(s) in other statuses");
      expect(fault.message).toContain("blocked, done");
    }
  });

  it("names heartbeat-runs as a known filter-ignoring route (CAN-3270)", () => {
    expect(ENDPOINTS_IGNORING_STATUS_FILTER).toContain("heartbeat-runs");
    expect(HEARTBEAT_RUNS_URL).toContain("heartbeat-runs");
  });
});

describe("planIssuePagination (guard 3 — offset walk, clamp at 1000, no hasMore)", () => {
  it("clamps an over-large requested limit to 1000", () => {
    expect(planIssuePagination([], 5000).limit).toBe(ISSUE_LIST_LIMIT_CLAMP);
    expect(ISSUE_LIST_LIMIT_CLAMP).toBe(1000);
  });

  it("starts at offset 0 when no page has been fetched", () => {
    const plan = planIssuePagination([]);
    expect(plan).toMatchObject({ complete: false, nextOffset: 0, totalReceived: 0 });
  });

  it("treats a full page as incomplete and advances the offset", () => {
    const plan = planIssuePagination([{ offset: 0, limit: 1000, received: 1000 }]);
    expect(plan.complete).toBe(false);
    expect(plan.nextOffset).toBe(1000);
  });

  it("completes only on a short page, summing every page", () => {
    const plan = planIssuePagination([
      { offset: 0, limit: 1000, received: 1000 },
      { offset: 1000, limit: 1000, received: 1000 },
      { offset: 2000, limit: 1000, received: 479 },
    ]);
    expect(plan.complete).toBe(true);
    expect(plan.nextOffset).toBeNull();
    expect(plan.totalReceived).toBe(2479);
  });

  it("treats an empty first page as a complete walk of zero", () => {
    const plan = planIssuePagination([{ offset: 0, limit: 1000, received: 0 }]);
    expect(plan).toMatchObject({ complete: true, nextOffset: null, totalReceived: 0 });
  });

  it("assertPaginationComplete throws on a truncated walk and names the next offset", () => {
    const plan = planIssuePagination([{ offset: 0, limit: 1000, received: 1000 }]);
    try {
      assertPaginationComplete(plan, ISSUES_URL);
      throw new Error("expected a throw");
    } catch (error) {
      const fault = error as SweepReadFaultError;
      expect(fault.faultKind).toBe("pagination_truncated");
      expect(fault.message).toContain("offset 1000");
      expect(fault.message).toContain("CAN-4530");
    }
  });

  it("assertPaginationComplete passes a completed walk through", () => {
    const plan = planIssuePagination([{ offset: 0, limit: 1000, received: 479 }]);
    expect(assertPaginationComplete(plan, ISSUES_URL)).toBe(plan);
  });
});

describe("summarizeIssueUniverse (enumerated counts can never render as {})", () => {
  it("enumerates every known status, including the zeroes", () => {
    const universe = summarizeIssueUniverse([]);
    expect(Object.keys(universe.statusCounts).sort()).toEqual([...ALL_ISSUE_STATUSES].sort());
    for (const status of ALL_ISSUE_STATUSES) {
      expect(universe.statusCounts[status]).toBe(0);
    }
    expect(JSON.stringify(universe.statusCounts)).not.toBe("{}");
  });

  it("counts the real CAN-5058-time board", () => {
    const universe = summarizeIssueUniverse(realBoard());
    expect(universe.total).toBe(479);
    expect(universe.statusCounts.in_progress).toBe(86);
    expect(universe.dispatchable).toBe(139);
    expect(universe.actionable).toBe(147);
  });

  it("segregates unrecognised statuses instead of dropping them", () => {
    const universe = summarizeIssueUniverse([...repeat("todo", 2), ...repeat("frobnicated", 3)]);
    expect(universe.statusCounts.todo).toBe(2);
    expect(universe.unknownStatuses).toEqual({ frobnicated: 3 });
    expect(universe.total).toBe(5);
  });

  it("formatStatusCountsBlock always emits an explicit integer per status", () => {
    const block = formatStatusCountsBlock(summarizeIssueUniverse([]));
    for (const status of ALL_ISSUE_STATUSES) {
      expect(block).toContain(`${status}: 0`);
    }
    expect(block).not.toContain("{}");
  });
});

describe("evaluateStarvationAlarm — CAN-5058 regression (step 3, dead chain)", () => {
  it("raises no critical when the universe read failed", () => {
    const decision = evaluateStarvationAlarm({
      step: "dead_chain",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: failedRead(ISSUES_URL, 500),
    });
    expect(decision.action).toBe("fault");
    expect(decision.reason).toBe("universe_read_failed");
    expect(decision.severity).toBe("none");
    expect(decision.body).toContain(INSTRUMENTATION_FAULT_PREFIX);
  });

  it("raises no critical on an empty universe — the `Status counts: {}` signature", () => {
    const decision = evaluateStarvationAlarm({
      step: "dead_chain",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 0),
      universe: summarizeIssueUniverse([]),
    });
    expect(decision.action).toBe("fault");
    expect(decision.reason).toBe("universe_below_floor");
    expect(decision.severity).toBe("none");
    expect(decision.body).not.toContain("ESCALATION:");
  });

  it("stays quiet on the board that actually existed at CAN-5058 time", () => {
    const decision = evaluateStarvationAlarm({
      step: "dead_chain",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 479),
      universe: summarizeIssueUniverse(realBoard()),
    });
    expect(decision.action).toBe("quiet");
    expect(decision.reason).toBe("condition_not_met");
  });

  it("still raises a critical on a genuine park — a large board with zero dispatchable", () => {
    const parked = [...repeat("blocked", 200), ...repeat("done", 250), ...repeat("in_review", 29)];
    const decision = evaluateStarvationAlarm({
      step: "dead_chain",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, parked.length),
      universe: summarizeIssueUniverse(parked),
    });
    expect(decision.action).toBe("raise");
    expect(decision.reason).toBe("board_fully_parked");
    expect(decision.severity).toBe("critical");
    expect(starvationAlarmTitle("dead_chain")).toBe(
      "ESCALATION: board fully parked — no dispatchable work",
    );
  });

  it("enumerates per-status counts in the raised body (never `Status counts: {}`)", () => {
    const parked = [...repeat("blocked", 200), ...repeat("done", 250), ...repeat("in_review", 29)];
    const decision = evaluateStarvationAlarm({
      step: "dead_chain",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, parked.length),
      universe: summarizeIssueUniverse(parked),
    });
    expect(decision.body).toContain("todo: 0");
    expect(decision.body).toContain("in_progress: 0");
    expect(decision.body).toContain("blocked: 200");
    expect(decision.body).toContain("in_review: 29");
    expect(decision.body).not.toContain("Status counts: {}");
  });

  it("a fault body reads as a read failure, not as an empty board", () => {
    const decision = evaluateStarvationAlarm({
      step: "dead_chain",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: failedRead(ISSUES_URL, 500),
    });
    expect(decision.body).toContain("could not read the board");
    expect(decision.body).toContain("not** evidence that the board is");
    expect(decision.body).not.toMatch(/^ESCALATION/m);
  });
});

describe("evaluateStarvationAlarm — CAN-5059 regression (step 2, total stall)", () => {
  const universe = summarizeIssueUniverse(realBoard());

  it("does not escalate when a run endpoint 404s — the headline regression", () => {
    const decision = evaluateStarvationAlarm({
      step: "total_stall",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 479, "issues-transport"),
      universe,
      liveRunsRead: failedRead("/api/companies/{id}/runs", 404, "runs-transport"),
      finishedRunsRead: okRead(HEARTBEAT_RUNS_URL, 57, "runs-transport"),
    });
    expect(decision.action).toBe("fault");
    expect(decision.reason).toBe("run_read_failed");
    expect(decision.severity).toBe("none");
    expect(decision.body).toContain(INSTRUMENTATION_FAULT_PREFIX);
  });

  it("does not escalate when BOTH run reads 404 (the exact CAN-5059 input)", () => {
    const decision = evaluateStarvationAlarm({
      step: "total_stall",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 479, "issues-transport"),
      universe,
      liveRunsRead: failedRead("/api/companies/{id}/runs", 404, "runs-transport"),
      finishedRunsRead: failedRead("/api/runs", 404, "runs-transport"),
    });
    expect(decision.action).toBe("fault");
    expect(decision.reason).toBe("run_read_failed");
  });

  it("does not escalate when the shared-transport AND is the only evidence", () => {
    // Both run reads say zero, and the universe preflight travelled the same
    // helper — one fault can produce all three answers, so nothing is confirmed.
    const decision = evaluateStarvationAlarm({
      step: "total_stall",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 479, "shared-helper"),
      universe,
      liveRunsRead: okRead(LIVE_RUNS_URL, 0, "shared-helper"),
      finishedRunsRead: okRead(HEARTBEAT_RUNS_URL, 0, "shared-helper"),
    });
    expect(decision.action).toBe("fault");
    expect(decision.reason).toBe("shared_transport_conjunction_unconfirmed");
  });

  it("stays quiet against the truth CEO measured at 00:20:08Z (50 live, 57 finished)", () => {
    const decision = evaluateStarvationAlarm({
      step: "total_stall",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 479, "issues-transport"),
      universe,
      liveRunsRead: okRead(LIVE_RUNS_URL, 50, "runs-transport"),
      finishedRunsRead: okRead(HEARTBEAT_RUNS_URL, 57, "runs-transport"),
    });
    expect(decision.action).toBe("quiet");
  });

  it("still raises on a genuine stall, once the run reads are independently sound", () => {
    const decision = evaluateStarvationAlarm({
      step: "total_stall",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 479, "issues-transport"),
      universe,
      liveRunsRead: okRead(LIVE_RUNS_URL, 0, "runs-transport"),
      finishedRunsRead: okRead(HEARTBEAT_RUNS_URL, 0, "runs-transport"),
    });
    expect(decision.action).toBe("raise");
    expect(decision.reason).toBe("pipeline_idle_with_open_work");
    expect(decision.severity).toBe("high");
  });

  it("names live-run and finished-run counts with the window bounds in the body (item 11)", () => {
    const decision = evaluateStarvationAlarm({
      step: "total_stall",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 479, "issues-transport"),
      universe,
      liveRunsRead: okRead(LIVE_RUNS_URL, 0, "runs-transport"),
      finishedRunsRead: okRead(HEARTBEAT_RUNS_URL, 0, "runs-transport"),
    });
    expect(decision.body).toContain("live runs: 0");
    expect(decision.body).toContain("last 45m");
    expect(decision.body).toContain("2026-09-18T23:23:25.000Z → 2026-09-19T00:08:25.000Z");
    expect(decision.body).toContain("todo: 53");
  });

  it("faults when a required run read was never supplied", () => {
    const decision = evaluateStarvationAlarm({
      step: "total_stall",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 479, "issues-transport"),
      universe,
      liveRunsRead: okRead(LIVE_RUNS_URL, 0, "runs-transport"),
    });
    expect(decision.action).toBe("fault");
    expect(decision.reason).toBe("missing_required_read");
  });

  it("applies the universe preflight to step 2 as well (the 45m AND protects nothing)", () => {
    const decision = evaluateStarvationAlarm({
      step: "total_stall",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 0, "issues-transport"),
      universe: summarizeIssueUniverse([]),
      liveRunsRead: okRead(LIVE_RUNS_URL, 0, "runs-transport"),
      finishedRunsRead: okRead(HEARTBEAT_RUNS_URL, 0, "runs-transport"),
    });
    expect(decision.action).toBe("fault");
    expect(decision.reason).toBe("universe_below_floor");
  });
});

describe("evaluateStarvationAlarm — step 1 (task supply)", () => {
  it("faults rather than escalating on an empty universe", () => {
    const decision = evaluateStarvationAlarm({
      step: "task_supply",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 0),
      universe: summarizeIssueUniverse([]),
    });
    expect(decision.action).toBe("fault");
    expect(decision.reason).toBe("universe_below_floor");
    expect(decision.severity).toBe("none");
  });

  it("raises high when a well-read board genuinely holds no actionable work", () => {
    const board = [...repeat("backlog", 120), ...repeat("done", 300), ...repeat("blocked", 59)];
    const decision = evaluateStarvationAlarm({
      step: "task_supply",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, board.length),
      universe: summarizeIssueUniverse(board),
    });
    expect(decision.action).toBe("raise");
    expect(decision.reason).toBe("task_supply_empty");
    expect(decision.severity).toBe("high");
    expect(decision.body).toContain("backlog: 120");
  });

  it("stays quiet when in_review alone supplies the actionable count", () => {
    const board = [...repeat("in_review", 4), ...repeat("done", 300), ...repeat("blocked", 59)];
    const decision = evaluateStarvationAlarm({
      step: "task_supply",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, board.length),
      universe: summarizeIssueUniverse(board),
    });
    expect(decision.action).toBe("quiet");
  });
});

describe("read-integrity invariants shared by all three steps", () => {
  const steps = ["task_supply", "total_stall", "dead_chain"] as const;

  it.each(steps)("step %s never raises when the universe read failed", (step) => {
    const decision = evaluateStarvationAlarm({
      step,
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: failedRead(ISSUES_URL, 403),
      liveRunsRead: okRead(LIVE_RUNS_URL, 0, "runs-transport"),
      finishedRunsRead: okRead(HEARTBEAT_RUNS_URL, 0, "runs-transport"),
    });
    expect(decision.action).toBe("fault");
    expect(decision.severity).toBe("none");
  });

  it.each(steps)("step %s never raises below the universe floor", (step) => {
    const board = repeat("blocked", DEFAULT_UNIVERSE_FLOOR - 1);
    const decision = evaluateStarvationAlarm({
      step,
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, board.length, "issues-transport"),
      universe: summarizeIssueUniverse(board),
      liveRunsRead: okRead(LIVE_RUNS_URL, 0, "runs-transport"),
      finishedRunsRead: okRead(HEARTBEAT_RUNS_URL, 0, "runs-transport"),
    });
    expect(decision.action).toBe("fault");
    expect(decision.reason).toBe("universe_below_floor");
  });

  it.each(steps)("step %s faults when ok is reported without an enumerated summary", (step) => {
    const decision = evaluateStarvationAlarm({
      step,
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, 479, "issues-transport"),
      liveRunsRead: okRead(LIVE_RUNS_URL, 0, "runs-transport"),
      finishedRunsRead: okRead(HEARTBEAT_RUNS_URL, 0, "runs-transport"),
    });
    expect(decision.action).toBe("fault");
    expect(decision.reason).toBe("missing_required_read");
  });

  it("a below-floor override lets a genuinely small company still alarm", () => {
    const board = [...repeat("blocked", 5), ...repeat("done", 3)];
    const decision = evaluateStarvationAlarm({
      step: "dead_chain",
      companyId: COMPANY_ID,
      now: NOW,
      universeRead: okRead(ISSUES_URL, board.length),
      universe: summarizeIssueUniverse(board),
      universeFloor: 5,
    });
    expect(decision.action).toBe("raise");
    expect(decision.reason).toBe("board_fully_parked");
  });

  it.each(steps)(
    "step %s emits a fault body that never contains the literal token ESCALATION:",
    (step) => {
      // Alarms dedupe by title, and a reader skims for this token. A fault
      // body that quotes the title verbatim reads as "an alarm fired".
      const decision = evaluateStarvationAlarm({
        step,
        companyId: COMPANY_ID,
        now: NOW,
        universeRead: okRead(ISSUES_URL, 0, "issues-transport"),
        universe: summarizeIssueUniverse([]),
        liveRunsRead: okRead(LIVE_RUNS_URL, 0, "runs-transport"),
        finishedRunsRead: okRead(HEARTBEAT_RUNS_URL, 0, "runs-transport"),
      });
      expect(decision.action).toBe("fault");
      expect(decision.body).not.toContain("ESCALATION:");
      expect(decision.body).toContain(starvationAlarmSubject(step));
      expect(starvationAlarmTitle(step)).toContain(starvationAlarmSubject(step));
    },
  );

  it("pins the canonical run endpoints and excludes the guessed ones", () => {
    expect(LIVE_RUNS_URL).toBe(`/api/companies/${COMPANY_ID}/live-runs`);
    expect(HEARTBEAT_RUNS_URL).toBe(`/api/companies/${COMPANY_ID}/heartbeat-runs`);
    for (const bad of KNOWN_NONEXISTENT_RUN_ENDPOINTS) {
      expect([LIVE_RUNS_URL, HEARTBEAT_RUNS_URL]).not.toContain(bad);
    }
  });
});
