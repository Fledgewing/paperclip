/**
 * CAN-5062 — Ops Sentinel sweep read-integrity guard (fixes CAN-5058 / CAN-5059).
 *
 * Ops Sentinel's dispatch-liveness checklist raises three counts-style
 * escalations from list reads it performs itself:
 *
 *   step 1 `task_supply`  — `ESCALATION: Paperclip task supply empty` (high)
 *   step 2 `total_stall`  — `ESCALATION: pipeline fully idle with open work` (high)
 *   step 3 `dead_chain`   — `ESCALATION: board fully parked — no dispatchable work` (critical)
 *
 * All three share one defect: **a failed read is indistinguishable from an
 * empty board.** On 2026-09-19 the sweep raised CAN-5058 (`critical`, "board
 * fully parked") against a board holding ~139 dispatchable issues, on the
 * strength of `Status counts: {}`; three minutes later it raised CAN-5059
 * (`high`, "pipeline fully idle") having called `GET /api/companies/{id}/runs`
 * and `GET /api/runs` — both **404** — and coerced each 404 body to `[]`
 * without inspecting the HTTP status.
 *
 * CAN-5058's dispositive tell: the body also reported "blocked issues whose
 * `blockedBy` is empty: none". `blockedByIssueIds` is write-only and absent
 * from the list route, so that predicate *cannot* return zero on a real read.
 * It returned zero because the read failed.
 *
 * CAN-5059's dispositive tell: step 2's condition is an AND of two reads
 * ("no live runs" AND "nothing finished in 45m"), which looks like a
 * redundancy check but is not — both reads travel the same URL-construction
 * and response-parsing helper, so a single transport fault breaks both and
 * the conjunction resolves true. Redundancy only buys safety when the
 * redundant paths fail *independently*.
 *
 * This module is the canonical gate. Every function here is pure: nothing
 * fetches, comments, or writes. The Ops Sentinel agent (per its AGENTS.md
 * checklist items 1–3) supplies the read results and honours the decision.
 * The layering mirrors the CAN-4075 gate in `issue-nudge-dedupe.ts`.
 *
 * Guard order, highest value first:
 *
 *   1. `assertListResponseOk` — a non-2xx is a hard fault, never `[]`.
 *      (Kills both CAN-5058's and CAN-5059's failure mode at the source.)
 *   2. `CANONICAL_ENDPOINTS` — pinned paths, no fallback-chain guessing.
 *   3. `evaluateStarvationAlarm` — refuses to raise when the universe read
 *      failed or came back below the configured floor, collapses a
 *      shared-transport conjunction to a single unit of confidence, and
 *      always emits enumerated per-status counts.
 */

/** The three counts-style checklist steps this guard covers. */
export const OPS_SENTINEL_STARVATION_STEPS = [
  "task_supply",
  "total_stall",
  "dead_chain",
] as const;
export type OpsSentinelStarvationStep =
  (typeof OPS_SENTINEL_STARVATION_STEPS)[number];

/**
 * Every issue status the board can hold. An alarm body MUST enumerate all of
 * these with an explicit count — including the zeroes — so that a reader can
 * tell "I read the board and this status held 0" apart from "this status was
 * missing from my result set". `Status counts: {}` is precisely the evidence
 * shape this constant exists to make impossible (CAN-5062 item 2; mirrors the
 * CAN-888 enumerated-counts precedent of 2026-09-02).
 */
export const ALL_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;
export type IssueStatus = (typeof ALL_ISSUE_STATUSES)[number];

/** Statuses that count as dispatchable for the step-3 dead-chain predicate. */
export const DISPATCHABLE_ISSUE_STATUSES = ["todo", "in_progress"] as const;

/** Statuses that count as actionable for the step-1 task-supply predicate. */
export const ACTIONABLE_ISSUE_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
] as const;

/**
 * The `limit` clamp on `GET /api/companies/{companyId}/issues`. The route
 * silently clamps any larger value and returns **no** `hasMore` flag
 * (CAN-4530), so a caller that asks for 5000 and receives 1000 cannot tell a
 * complete answer from a truncated one. The only correct read is to walk
 * `offset` until a short page arrives — see `planIssuePagination`.
 */
export const ISSUE_LIST_LIMIT_CLAMP = 1000;

/**
 * Per-company floor on the total issue universe. A sweep that reads fewer
 * issues than this across *all* statuses has almost certainly suffered a read
 * fault rather than observed a genuinely tiny board. CanopyPowered holds ~479
 * issues as of 2026-09-19; 50 leaves three orders of headroom against real
 * shrinkage while still catching the `{}` signature.
 *
 * Callers may override per company via `EvaluateStarvationAlarmInput.universeFloor`.
 */
export const DEFAULT_UNIVERSE_FLOOR = 50;

/** Step 2's lookback window: "no run finished in the last 45 minutes". */
export const DEFAULT_STALL_WINDOW_MS = 45 * 60 * 1000;

/**
 * Canonical endpoints. Pinned because CAN-5059 was manufactured by endpoint
 * guessing: the sweep tried `/api/companies/{id}/runs` and `/api/runs`, both
 * of which 404, and a fallback chain that swallows 404s converted a typo into
 * a `high` escalation. There is no fallback. If a pinned path 404s, that is a
 * platform change and a fault — not a second guess.
 */
export const CANONICAL_ENDPOINTS = {
  /** Paginated; see `ISSUE_LIST_LIMIT_CLAMP`. Honours `?status=`. */
  issues: (companyId: string) => `/api/companies/${companyId}/issues`,
  /** Bare JSON array of live runs. */
  liveRuns: (companyId: string) => `/api/companies/${companyId}/live-runs`,
  /** Newest-first. Ignores `?status=` — see CAN-3270 and `ENDPOINTS_IGNORING_STATUS_FILTER`. */
  heartbeatRuns: (companyId: string) =>
    `/api/companies/${companyId}/heartbeat-runs`,
} as const;

/**
 * Paths the sweep has historically guessed at and which do not exist. Listed
 * so a caller can assert against them in a test rather than rediscovering the
 * 404 in production. Both produced CAN-5059.
 */
export const KNOWN_NONEXISTENT_RUN_ENDPOINTS = [
  "/api/runs",
  "/api/companies/{companyId}/runs",
] as const;

/**
 * Routes known to accept `?status=` in the query string and ignore it. A
 * helper that filters by status against one of these is reading an unfiltered
 * list and believing it is filtered (CAN-5062 item 4). Filter client-side
 * instead, or do not claim the filter.
 */
export const ENDPOINTS_IGNORING_STATUS_FILTER = ["heartbeat-runs"] as const;

/**
 * Raised whenever a list read cannot be trusted. The whole point of this
 * class is that it is *thrown*, never folded into an empty array: an alarm
 * that treats "I could not read" as "there was nothing there" is the CAN-5058
 * / CAN-5059 defect.
 */
export class SweepReadFaultError extends Error {
  readonly url: string;
  readonly httpStatus: number | null;
  readonly faultKind: SweepReadFaultKind;

  constructor(params: {
    message: string;
    url: string;
    httpStatus: number | null;
    faultKind: SweepReadFaultKind;
  }) {
    super(params.message);
    this.name = "SweepReadFaultError";
    this.url = params.url;
    this.httpStatus = params.httpStatus;
    this.faultKind = params.faultKind;
  }
}

export type SweepReadFaultKind =
  | "non_2xx"
  | "unparseable_body"
  | "unexpected_shape"
  | "status_filter_ignored"
  | "pagination_truncated";

/**
 * **Guard 1 — the highest-value item in CAN-5062.**
 *
 * Validate a list response and return its items, or throw. A non-2xx status
 * is a hard fault. So is a body that is not an array: several of these routes
 * return a bare JSON array, and an error envelope (`{error: "..."}`) coerced
 * through `Array.isArray(x) ? x : []` is the same bug wearing a 200.
 *
 * Note the deliberate absence of a `defaultValue` parameter. There is no
 * caller-supplied fallback, because every historical instance of this defect
 * came from one.
 */
export function assertListResponseOk<T = unknown>(response: {
  url: string;
  httpStatus: number;
  body: unknown;
}): T[] {
  const { url, httpStatus, body } = response;

  if (httpStatus < 200 || httpStatus >= 300) {
    throw new SweepReadFaultError({
      message:
        `Sweep read failed: ${url} returned HTTP ${httpStatus}. ` +
        `A non-2xx response is a fault, not an empty result — no alarm may be ` +
        `raised from this read.`,
      url,
      httpStatus,
      faultKind: "non_2xx",
    });
  }

  if (!Array.isArray(body)) {
    throw new SweepReadFaultError({
      message:
        `Sweep read failed: ${url} returned HTTP ${httpStatus} but the body was ` +
        `${describeShape(body)}, not a JSON array. Refusing to coerce to [].`,
      url,
      httpStatus,
      faultKind: "unexpected_shape",
    });
  }

  return body as T[];
}

/**
 * **Guard 2 — `?status=` is honoured, or it is a fault.**
 *
 * `GET /api/companies/{companyId}/issues?status=todo` does filter correctly.
 * `heartbeat-runs` does not (CAN-3270). Any helper that ingests an issue list
 * and believes it is status-filtered must prove it, because an unfiltered
 * list silently inflates every count the alarm reasons about.
 */
export function assertStatusFilterHonoured<T extends { status?: string }>(
  items: T[],
  params: { url: string; requestedStatus: string },
): T[] {
  const offenders = items.filter(
    (item) => typeof item.status === "string" && item.status !== params.requestedStatus,
  );
  if (offenders.length > 0) {
    throw new SweepReadFaultError({
      message:
        `Sweep read failed: ${params.url} was requested with ?status=` +
        `${params.requestedStatus} but returned ${offenders.length} item(s) in ` +
        `other statuses (${uniqueStatuses(offenders).join(", ")}). The route ` +
        `ignores the filter — read unfiltered and filter client-side.`,
      url: params.url,
      httpStatus: 200,
      faultKind: "status_filter_ignored",
    });
  }
  return items;
}

export interface IssuePaginationPage {
  offset: number;
  limit: number;
  received: number;
}

export interface IssuePaginationPlan {
  /** Clamped page size actually sent to the route. */
  limit: number;
  /** `true` once a short page proves the walk reached the end. */
  complete: boolean;
  /** Next offset to request, or `null` when `complete`. */
  nextOffset: number | null;
  totalReceived: number;
}

/**
 * **Guard 3 — pagination is complete, or it is a fault.**
 *
 * Fold the pages fetched so far into a plan. The walk is complete only when
 * a page comes back **short** (`received < limit`). A full page is never
 * evidence of completeness — with the clamp at 1000 and no `hasMore` flag
 * (CAN-4530), a full final page and a truncated read look identical.
 *
 * An empty first page is complete and legitimately means zero — but `zero`
 * is exactly what the universe floor in `evaluateStarvationAlarm` then
 * refuses to alarm on.
 */
export function planIssuePagination(
  pages: IssuePaginationPage[],
  requestedLimit: number = ISSUE_LIST_LIMIT_CLAMP,
): IssuePaginationPlan {
  const limit = Math.min(Math.max(1, requestedLimit), ISSUE_LIST_LIMIT_CLAMP);
  const totalReceived = pages.reduce((sum, page) => sum + page.received, 0);

  if (pages.length === 0) {
    return { limit, complete: false, nextOffset: 0, totalReceived: 0 };
  }

  const last = pages[pages.length - 1]!;
  const complete = last.received < limit;
  return {
    limit,
    complete,
    nextOffset: complete ? null : last.offset + last.received,
    totalReceived,
  };
}

/**
 * Assert a completed pagination walk. Throws when the last page was full,
 * because the caller is about to reason about a total it cannot justify.
 */
export function assertPaginationComplete(
  plan: IssuePaginationPlan,
  url: string,
): IssuePaginationPlan {
  if (!plan.complete) {
    throw new SweepReadFaultError({
      message:
        `Sweep read failed: pagination of ${url} is incomplete — the last page ` +
        `returned a full ${plan.limit} rows and the route exposes no hasMore ` +
        `flag (CAN-4530). Continue from offset ${plan.nextOffset} until a ` +
        `short page arrives.`,
      url,
      httpStatus: 200,
      faultKind: "pagination_truncated",
    });
  }
  return plan;
}

export type StatusCounts = Record<IssueStatus, number>;

/**
 * Enumerate per-status counts over a fully-paginated issue list. Every status
 * in `ALL_ISSUE_STATUSES` is present with an explicit integer, so the
 * resulting object can never serialise to `{}`.
 */
export function summarizeIssueUniverse(issues: Array<{ status: string }>): {
  total: number;
  statusCounts: StatusCounts;
  dispatchable: number;
  actionable: number;
  unknownStatuses: Record<string, number>;
} {
  const statusCounts = Object.fromEntries(
    ALL_ISSUE_STATUSES.map((status) => [status, 0]),
  ) as StatusCounts;
  const unknownStatuses: Record<string, number> = {};

  for (const issue of issues) {
    if ((ALL_ISSUE_STATUSES as readonly string[]).includes(issue.status)) {
      statusCounts[issue.status as IssueStatus] += 1;
    } else {
      unknownStatuses[issue.status] = (unknownStatuses[issue.status] ?? 0) + 1;
    }
  }

  const sumOf = (statuses: readonly string[]) =>
    statuses.reduce(
      (sum, status) => sum + (statusCounts[status as IssueStatus] ?? 0),
      0,
    );

  return {
    total: issues.length,
    statusCounts,
    dispatchable: sumOf(DISPATCHABLE_ISSUE_STATUSES),
    actionable: sumOf(ACTIONABLE_ISSUE_STATUSES),
    unknownStatuses,
  };
}

/**
 * The outcome of one list read, as handed to the alarm gate. `ok: false`
 * means the read threw (or was never attempted); `count` is then meaningless
 * and the gate must not reason about it.
 *
 * `transportId` identifies the URL-construction / response-parsing helper the
 * read travelled through. Two reads sharing a `transportId` do **not** fail
 * independently, so their conjunction is worth one unit of confidence, not
 * two (CAN-5062 item 10 — the mechanism behind CAN-5059).
 */
export interface SweepListRead {
  url: string;
  ok: boolean;
  httpStatus: number | null;
  count: number;
  transportId: string;
  faultKind?: SweepReadFaultKind;
  faultMessage?: string;
}

export interface EvaluateStarvationAlarmInput {
  step: OpsSentinelStarvationStep;
  companyId: string;
  now: Date;
  /**
   * The fully-paginated read of the whole issue universe. Required for every
   * step, including step 2 — it is the *independent* preflight that keeps a
   * shared-transport run conjunction from standing alone.
   */
  universeRead: SweepListRead;
  /** Present only when `universeRead.ok`. */
  universe?: ReturnType<typeof summarizeIssueUniverse>;
  /** Step 2 only. */
  liveRunsRead?: SweepListRead;
  /** Step 2 only: runs that finished inside the stall window. */
  finishedRunsRead?: SweepListRead;
  universeFloor?: number;
  stallWindowMs?: number;
}

export type StarvationAlarmAction = "raise" | "fault" | "quiet";

export type StarvationAlarmReason =
  // fault
  | "universe_read_failed"
  | "universe_below_floor"
  | "run_read_failed"
  | "shared_transport_conjunction_unconfirmed"
  | "missing_required_read"
  // raise
  | "task_supply_empty"
  | "pipeline_idle_with_open_work"
  | "board_fully_parked"
  // quiet
  | "condition_not_met";

export interface StarvationAlarmDecision {
  action: StarvationAlarmAction;
  reason: StarvationAlarmReason;
  step: OpsSentinelStarvationStep;
  /** `critical` / `high` only on `raise`; a fault is never either. */
  severity: "critical" | "high" | "none";
  /** Ready-to-post body. Always enumerates counts. */
  body: string;
  evaluatedAt: string;
  universeFloor: number;
  stallWindowMs: number;
}

/**
 * **The gate.** See the file header for the contract.
 *
 * Evaluation order is load-bearing:
 *
 *   1. The universe preflight runs first, for every step. A failed or
 *      below-floor universe read short-circuits to `fault` — no step may
 *      raise a `critical`/`high` escalation on a read it could not make.
 *   2. Step-specific required reads are then checked for `ok`.
 *   3. A shared-transport conjunction (step 2) is collapsed to one unit of
 *      confidence; it may only stand on top of a *passed* universe preflight.
 *   4. Only then is the alarm predicate evaluated.
 */
export function evaluateStarvationAlarm(
  input: EvaluateStarvationAlarmInput,
): StarvationAlarmDecision {
  const universeFloor = input.universeFloor ?? DEFAULT_UNIVERSE_FLOOR;
  const stallWindowMs = input.stallWindowMs ?? DEFAULT_STALL_WINDOW_MS;
  const evaluatedAt = input.now.toISOString();
  const base = { step: input.step, evaluatedAt, universeFloor, stallWindowMs };

  const fault = (
    reason: StarvationAlarmReason,
    detail: string,
  ): StarvationAlarmDecision => ({
    ...base,
    action: "fault",
    reason,
    severity: "none",
    body: formatFaultBody({ ...input, reason, detail, universeFloor }),
  });

  // 1. Universe preflight — applies to all three steps (CAN-5062 item 1).
  if (!input.universeRead.ok) {
    return fault(
      "universe_read_failed",
      `${input.universeRead.url} → ` +
        `${input.universeRead.httpStatus ?? "no response"}` +
        (input.universeRead.faultMessage
          ? ` (${input.universeRead.faultMessage})`
          : ""),
    );
  }
  if (!input.universe) {
    return fault(
      "missing_required_read",
      `universeRead reported ok but no enumerated summary was supplied; ` +
        `refusing to alarm on an unsummarised universe.`,
    );
  }
  if (input.universe.total < universeFloor) {
    return fault(
      "universe_below_floor",
      `total issue universe read back ${input.universe.total}, below the ` +
        `configured floor of ${universeFloor}. A universe this small is a ` +
        `failed read, not a parked board.`,
    );
  }

  // 2 & 3. Step-specific reads.
  if (input.step === "total_stall") {
    const live = input.liveRunsRead;
    const finished = input.finishedRunsRead;
    if (!live || !finished) {
      return fault(
        "missing_required_read",
        `step 2 requires both ${CANONICAL_ENDPOINTS.liveRuns(input.companyId)} ` +
          `and ${CANONICAL_ENDPOINTS.heartbeatRuns(input.companyId)}; ` +
          `${!live ? "live-runs" : "heartbeat-runs"} was not supplied.`,
      );
    }
    for (const read of [live, finished]) {
      if (!read.ok) {
        return fault(
          "run_read_failed",
          `${read.url} → ${read.httpStatus ?? "no response"}` +
            (read.faultMessage ? ` (${read.faultMessage})` : "") +
            `. This is the CAN-5059 signature: a 404 coerced to [] reads as ` +
            `"zero runs".`,
        );
      }
    }

    // CAN-5062 item 10. `live === 0 AND finished === 0` looks like two
    // independent confirmations but is one read when both travel the same
    // helper. It is admissible only because the universe preflight above —
    // a genuinely independent read — has already passed.
    const sharedTransport = live.transportId === finished.transportId;
    const bothZero = live.count === 0 && finished.count === 0;

    if (bothZero && sharedTransport && input.universeRead.transportId === live.transportId) {
      return fault(
        "shared_transport_conjunction_unconfirmed",
        `both run reads returned 0 via transport "${live.transportId}", and ` +
          `the universe preflight travelled that same transport. All three ` +
          `reads can fail together, so the conjunction confirms nothing.`,
      );
    }

    const openWork = input.universe.dispatchable > 0;
    if (bothZero && openWork) {
      return {
        ...base,
        action: "raise",
        reason: "pipeline_idle_with_open_work",
        severity: "high",
        body: formatAlarmBody(input, universeFloor, stallWindowMs),
      };
    }
    return {
      ...base,
      action: "quiet",
      reason: "condition_not_met",
      severity: "none",
      body: formatAlarmBody(input, universeFloor, stallWindowMs),
    };
  }

  if (input.step === "dead_chain") {
    if (input.universe.dispatchable === 0) {
      return {
        ...base,
        action: "raise",
        reason: "board_fully_parked",
        severity: "critical",
        body: formatAlarmBody(input, universeFloor, stallWindowMs),
      };
    }
    return {
      ...base,
      action: "quiet",
      reason: "condition_not_met",
      severity: "none",
      body: formatAlarmBody(input, universeFloor, stallWindowMs),
    };
  }

  // step === "task_supply"
  if (input.universe.actionable === 0) {
    return {
      ...base,
      action: "raise",
      reason: "task_supply_empty",
      severity: "high",
      body: formatAlarmBody(input, universeFloor, stallWindowMs),
    };
  }
  return {
    ...base,
    action: "quiet",
    reason: "condition_not_met",
    severity: "none",
    body: formatAlarmBody(input, universeFloor, stallWindowMs),
  };
}

const STEP_TITLES: Record<OpsSentinelStarvationStep, string> = {
  task_supply: "ESCALATION: Paperclip task supply empty",
  total_stall: "ESCALATION: pipeline fully idle with open work",
  dead_chain: "ESCALATION: board fully parked — no dispatchable work",
};

/** The escalation title for a step, for dedupe-by-title. */
export function starvationAlarmTitle(
  step: OpsSentinelStarvationStep,
): string {
  return STEP_TITLES[step];
}

/**
 * The step's subject *without* the `ESCALATION: ` prefix, for use in fault
 * bodies. A fault must never contain the literal token `ESCALATION:` — the
 * checklist dedupes alarms by title, and a human skimming the thread reads
 * that token as "an alarm fired". Quoting the title verbatim inside a fault
 * body would reintroduce exactly the confusion item 3 exists to remove.
 */
export function starvationAlarmSubject(
  step: OpsSentinelStarvationStep,
): string {
  return STEP_TITLES[step].replace(/^ESCALATION:\s*/, "");
}

/**
 * CAN-5062 item 3: "I could not read the board" must not read like "the
 * board is empty". A fault body leads with a distinct prefix, carries no
 * severity, and names the step and the failing read.
 */
export const INSTRUMENTATION_FAULT_PREFIX = "INSTRUMENTATION FAULT";

function formatFaultBody(params: {
  step: OpsSentinelStarvationStep;
  companyId: string;
  now: Date;
  universeRead: SweepListRead;
  universe?: ReturnType<typeof summarizeIssueUniverse>;
  reason: StarvationAlarmReason;
  detail: string;
  universeFloor: number;
}): string {
  const lines = [
    `${INSTRUMENTATION_FAULT_PREFIX}: Ops Sentinel sweep read failed at step ` +
      `\`${params.step}\` (would have alarmed on: ` +
      `${starvationAlarmSubject(params.step)}).`,
    "",
    `This is **not** an escalation and **not** evidence that the board is ` +
      `parked. The sweep could not read the board, so it cannot say what the ` +
      `board holds.`,
    "",
    `- reason: \`${params.reason}\``,
    `- detail: ${params.detail}`,
    `- company: ${params.companyId}`,
    `- evaluated at: ${params.now.toISOString()}`,
    `- universe floor: ${params.universeFloor}`,
  ];
  if (params.universe) {
    lines.push("", formatStatusCountsBlock(params.universe));
  } else {
    lines.push(
      "",
      `Status counts: unavailable — the universe read did not complete. ` +
        `(An empty \`{}\` here would be the CAN-5058 signature.)`,
    );
  }
  lines.push(
    "",
    `Next action: re-run the sweep read against the canonical endpoints ` +
      `(see \`process/dispatch-liveness.md\`). Do not raise or retract an ` +
      `escalation on the strength of this tick.`,
  );
  return lines.join("\n");
}

function formatAlarmBody(
  input: EvaluateStarvationAlarmInput,
  universeFloor: number,
  stallWindowMs: number,
): string {
  const universe = input.universe;
  const lines = [
    `Step \`${input.step}\` evaluated at ${input.now.toISOString()} for ` +
      `company ${input.companyId}.`,
    "",
    universe
      ? formatStatusCountsBlock(universe)
      : "Status counts: unavailable.",
  ];

  if (input.step === "total_stall") {
    const windowMinutes = Math.round(stallWindowMs / 60000);
    const windowStart = new Date(input.now.getTime() - stallWindowMs);
    lines.push(
      "",
      "Run evidence (CAN-5062 item 11):",
      `- live runs: ${describeRead(input.liveRunsRead)} via ` +
        `\`${CANONICAL_ENDPOINTS.liveRuns(input.companyId)}\``,
      `- runs finished in the last ${windowMinutes}m ` +
        `(${windowStart.toISOString()} → ${input.now.toISOString()}): ` +
        `${describeRead(input.finishedRunsRead)} via ` +
        `\`${CANONICAL_ENDPOINTS.heartbeatRuns(input.companyId)}\``,
      `- transports: live=\`${input.liveRunsRead?.transportId ?? "n/a"}\`, ` +
        `finished=\`${input.finishedRunsRead?.transportId ?? "n/a"}\`, ` +
        `universe=\`${input.universeRead.transportId}\``,
    );
  }

  lines.push(
    "",
    `Read integrity: universe read OK via ` +
      `\`${input.universeRead.url}\` (HTTP ${input.universeRead.httpStatus}), ` +
      `${universe?.total ?? 0} issues, floor ${universeFloor}.`,
  );
  return lines.join("\n");
}

/**
 * The enumerated-counts block. Every status appears with an explicit integer,
 * so this can never render as `Status counts: {}`.
 */
export function formatStatusCountsBlock(
  universe: ReturnType<typeof summarizeIssueUniverse>,
): string {
  const enumerated = ALL_ISSUE_STATUSES.map(
    (status) => `${status}: ${universe.statusCounts[status]}`,
  ).join(", ");
  const unknown = Object.entries(universe.unknownStatuses);
  const lines = [
    `Status counts (${universe.total} total): ${enumerated}`,
    `Dispatchable (todo+in_progress): ${universe.dispatchable}; ` +
      `actionable (+in_review): ${universe.actionable}`,
  ];
  if (unknown.length > 0) {
    lines.push(
      `Unrecognised statuses: ` +
        unknown.map(([status, n]) => `${status}: ${n}`).join(", "),
    );
  }
  return lines.join("\n");
}

function describeRead(read: SweepListRead | undefined): string {
  if (!read) return "not read";
  if (!read.ok) return `READ FAILED (HTTP ${read.httpStatus ?? "none"})`;
  return String(read.count);
}

function describeShape(body: unknown): string {
  if (body === null) return "null";
  if (Array.isArray(body)) return "an array";
  return typeof body === "object" ? "a JSON object" : typeof body;
}

function uniqueStatuses(items: Array<{ status?: string }>): string[] {
  return [...new Set(items.map((item) => item.status ?? "<none>"))].sort();
}
