/**
 * CAN-4075 — Ops Sentinel per-assignee stall nudge guard.
 *
 * Sentinel previously nudged any `todo`/`in_progress`/`in_review` issue whose
 * last assignee activity was >4h ago, regardless of whether the candidate had
 * a live run, a scheduled monitor, or had already been nudged in the same idle
 * episode. CAN-3457 demonstrated the failure shape: the 08:00Z nudge was a
 * false positive against a continuously-active source run, and the same issue
 * would later be validly nudged in a fresh idle episode.
 *
 * `evaluateIssueNudgeGate` is a pure function that takes a freshly re-read
 * candidate (re-fetched immediately before commenting, never from a sweep-time
 * snapshot), the previously persisted per-issue nudge state (or `null`), and
 * a `now`, and returns a decision plus the next state. The decision taxonomy
 * is explicit so the calling agent can write the reason into the standing
 * `tick-state` document and surface it on the rare dispatchable comment.
 *
 * The function does NOT post comments, mutate the database, or schedule
 * wakes. It is the canonical gate; the calling path (the Ops Sentinel agent
 * or a future server-side helper) is responsible for the comment write and
 * for persisting `updatedState`.
 */

import { createHash } from "node:crypto";

/**
 * Statuses that count as "an active run is attached to this candidate right
 * now". Mirrors `EXECUTION_PATH_HEARTBEAT_RUN_STATUSES` in
 * `services/heartbeat.ts` and `LIVE_HEARTBEAT_RUN_STATUSES` in
 * `services/routines.ts`. Kept as a const array so the export is the single
 * source of truth; callers compare via `LIVE_RUN_STATUSES.includes(status)`.
 */
export const LIVE_RUN_STATUSES = [
  "queued",
  "running",
  "scheduled_retry",
] as const;
export type LiveRunStatus = (typeof LIVE_RUN_STATUSES)[number];

/**
 * The status set that the per-assignee stall nudge rule covers. Issues in
 * other states are not candidates and the gate suppresses without recording
 * state.
 */
export const NUDGE_ELIGIBLE_ISSUE_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
] as const;
export type NudgeEligibleIssueStatus =
  (typeof NUDGE_ELIGIBLE_ISSUE_STATUSES)[number];

/**
 * Default idle-episode threshold. Per the AGENTS.md step 4 rule and the
 * CAN-4073 case study, a candidate that has been continuously idle for at
 * least this duration (with no active run, no future monitor, no assignee
 * response, and no state change) is treated as a fresh idle episode and
 * eligible for another nudge. 4 hours.
 */
export const DEFAULT_NUDGE_IDLE_THRESHOLD_MS = 4 * 60 * 60 * 1000;

/**
 * A trimmed view of the candidate issue as the gate needs to see it.
 * Constructing this from the live `GET /api/issues/{id}` response (or the
 * equivalent server-side read) is the caller's responsibility; the gate
 * never re-fetches.
 */
export interface IssueNudgeCandidate {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  /**
   * The current run attached to the issue, or `null` if there is none.
   * MUST be re-read at decision time, not cached from the sweep.
   */
  activeRunId: string | null;
  activeRunStatus: string | null;
  /**
   * The issue's `executionPolicy.monitor.nextCheckAt`. A future timestamp
   * here means the issue already has an eligible scheduled wake and the
   * gate must suppress.
   */
  monitorNextCheckAt: Date | string | null;
  monitorScheduledBy: string | null;
  /**
   * Timestamp of the most recent comment authored by the current assignee
   * (`assigneeAgentId`) on this issue. Used to detect "assignee responded"
   * without needing the full comment thread. `null` if there are no assignee
   * comments or no assignee.
   */
  latestAssigneeCommentAt: Date | string | null;
  monitorAttemptCount: number | null;
}

/**
 * Per-issue nudge state. Persisted by the caller (Ops Sentinel writes this
 * to `state/nudge-state.json`; a future server-side port would store it in
 * the recovery database). The schema is forward-compatible: new fields can
 * be added without breaking older readers, which only read the fields they
 * know.
 */
export interface IssueNudgeStateEntry {
  schemaVersion: 1;
  companyId: string;
  issueId: string;
  /**
   * ISO8601 timestamp of the first nudge Sentinel ever sent for this issue
   * under the CAN-4075 gate. Used for diagnostics only; the gate keys on
   * `lastNudgedAt` and `lastFingerprint`.
   */
  firstNudgedAt: string;
  /**
   * ISO8601 timestamp of the most recent nudge. The gate compares
   * `now - lastNudgedAt` against `idleEpisodeThresholdMs` to decide whether
   * the current idle episode is fresh.
   */
  lastNudgedAt: string;
  /**
   * Stable hash of the candidate's meaningful state at the moment of the
   * last nudge. The gate computes the same hash from the live candidate;
   * mismatch means status/assignment/monitor/run state changed since the
   * last nudge and the gate allows another nudge.
   */
  lastFingerprint: string;
  /**
   * ISO8601 timestamp marking the start of the current idle episode.
   * Diagnostics-only — used in the standing `tick-state` document so the
   * caller can show "idle for 4h 12m since 03:51Z".
   */
  idleEpisodeStartedAt: string;
  /**
   * Count of nudges that have fired with the *same* fingerprint since
   * `idleEpisodeStartedAt`. Each fresh-idle-episode nudge resets this to 0.
   */
  consecutiveNoChangeNudges: number;
  /**
   * Lifetime nudge count for this issue. Diagnostics-only.
   */
  totalNudges: number;
}

export type IssueNudgeDecisionAction = "nudge" | "suppress";

/**
 * Explicit, machine-stable reason taxonomy. The calling agent writes the
 * reason into the rolling `tick-state` document on every decision so the
 * reviewer can audit false positives without re-reading the issue.
 *
 * `first_nudge` is the only reason that creates a new state entry from `null`.
 * All other `nudge` reasons preserve the existing state but update
 * `lastNudgedAt`, `lastFingerprint`, `idleEpisodeStartedAt`,
 * `consecutiveNoChangeNudges`, and `totalNudges`.
 */
export type IssueNudgeDecisionReason =
  | "active_run_present"
  | "future_monitor_scheduled"
  | "non_actionable_status"
  | "unassigned"
  | "first_nudge"
  | "state_changed"
  | "assignee_responded"
  | "fresh_idle_episode"
  | "already_nudged_in_episode";

export interface IssueNudgeDecision {
  action: IssueNudgeDecisionAction;
  reason: IssueNudgeDecisionReason;
  candidate: IssueNudgeCandidate;
  previousState: IssueNudgeStateEntry | null;
  /**
   * The new state to persist. `null` when the action is `suppress` and the
   * reason is one of the hard-suppress / structural-suppress branches that
   * do not touch state.
   *
   * For `state_changed` and `fresh_idle_episode` the state is updated in
   * place (fingerprint roll, `consecutiveNoChangeNudges` reset to 0 on
   * fingerprint change, +1 on fresh episode). For `first_nudge` and
   * `assignee_responded` a fresh episode entry is created.
   */
  updatedState: IssueNudgeStateEntry | null;
  idleEpisodeThresholdMs: number;
  evaluatedAt: string;
}

export interface EvaluateIssueNudgeGateInput {
  candidate: IssueNudgeCandidate;
  previousState: IssueNudgeStateEntry | null;
  now: Date;
  idleEpisodeThresholdMs?: number;
}

/**
 * Build the deterministic fingerprint that the gate uses to detect state
 * changes between nudges. Includes every field whose change should reset
 * the dedupe window.
 *
 * The fingerprint is `sha256(canonical_json(sorted_keys_no_whitespace))`
 * over the candidate's status, assignee, active run, monitor, and the
 * assignee's latest comment timestamp. Anything not in this list
 * (e.g. `title`, `description`, `priority`) is ignored — those can change
 * without breaking the idle-episode semantic.
 */
export function computeIssueNudgeFingerprint(
  candidate: IssueNudgeCandidate,
): string {
  const payload = {
    activeRunId: candidate.activeRunId,
    activeRunStatus: candidate.activeRunStatus,
    assigneeAgentId: candidate.assigneeAgentId,
    latestAssigneeCommentAt: normalizeTimestamp(
      candidate.latestAssigneeCommentAt,
    ),
    monitorAttemptCount: candidate.monitorAttemptCount ?? 0,
    monitorNextCheckAt: normalizeTimestamp(candidate.monitorNextCheckAt),
    monitorScheduledBy: candidate.monitorScheduledBy,
    status: candidate.status,
  };
  const json = canonicalJson(payload);
  return createHash("sha256").update(json).digest("hex");
}

/**
 * The gate. See the file header for the contract.
 *
 * Order of evaluation matters: hard-suppress branches (active run, future
 * monitor) are checked first and never touch state. Structural-suppress
 * branches (non-actionable status, unassigned) are next. Only after the
 * candidate is structurally eligible do we read the previous state.
 */
export function evaluateIssueNudgeGate(
  input: EvaluateIssueNudgeGateInput,
): IssueNudgeDecision {
  const threshold =
    input.idleEpisodeThresholdMs ?? DEFAULT_NUDGE_IDLE_THRESHOLD_MS;
  const nowMs = input.now.getTime();
  const evaluatedAt = input.now.toISOString();

  // 1. Active run — the headline guard from CAN-3457 / CAN-4073.
  //    An issue whose status counts as "live" (queued/running/scheduled_retry)
  //    has an agent already doing the work; nudging wakes nobody.
  if (
    candidateHasActiveRun(input.candidate) &&
    !isLiveRunStatus(input.candidate.activeRunStatus)
  ) {
    // activeRunId set but status is terminal — treat as no live run. Fall
    // through to dedupe logic so we still nudge when state has been quiet
    // for the threshold. This branch is intentionally unreachable in
    // practice (callers should normalise), but keeps the function total.
  }
  if (
    input.candidate.activeRunId !== null &&
    isLiveRunStatus(input.candidate.activeRunStatus)
  ) {
    return buildDecision({
      action: "suppress",
      reason: "active_run_present",
      input,
      evaluatedAt,
      threshold,
      updatedState: null,
    });
  }

  // 2. Future scheduled monitor. The Ops Sentinel AGENTS.md already exempts
  //    these; the gate repeats the check so a future caller cannot skip the
  //    AGENTS.md layer and accidentally nudge.
  const monitorMs = normalizeTimestampMs(input.candidate.monitorNextCheckAt);
  if (monitorMs !== null && monitorMs > nowMs) {
    return buildDecision({
      action: "suppress",
      reason: "future_monitor_scheduled",
      input,
      evaluatedAt,
      threshold,
      updatedState: null,
    });
  }

  // 3. Structural eligibility.
  if (
    !NUDGE_ELIGIBLE_ISSUE_STATUSES.includes(
      input.candidate.status as NudgeEligibleIssueStatus,
    )
  ) {
    return buildDecision({
      action: "suppress",
      reason: "non_actionable_status",
      input,
      evaluatedAt,
      threshold,
      updatedState: null,
    });
  }
  if (input.candidate.assigneeAgentId === null) {
    return buildDecision({
      action: "suppress",
      reason: "unassigned",
      input,
      evaluatedAt,
      threshold,
      updatedState: null,
    });
  }

  // 4. Dedupe against persisted state.
  const fingerprint = computeIssueNudgeFingerprint(input.candidate);
  const prev = input.previousState;

  if (prev === null) {
    return buildDecision({
      action: "nudge",
      reason: "first_nudge",
      input,
      evaluatedAt,
      threshold,
      updatedState: createFreshStateEntry({
        candidate: input.candidate,
        now: input.now,
        fingerprint,
        reason: "first_nudge",
      }),
    });
  }

  // 4a. Assignee responded since the last nudge. Reset the idle episode.
  const lastNudgeMs = parseIso(prev.lastNudgedAt);
  const assigneeCommentMs = normalizeTimestampMs(
    input.candidate.latestAssigneeCommentAt,
  );
  if (
    assigneeCommentMs !== null &&
    lastNudgeMs !== null &&
    assigneeCommentMs > lastNudgeMs
  ) {
    return buildDecision({
      action: "nudge",
      reason: "assignee_responded",
      input,
      evaluatedAt,
      threshold,
      updatedState: createFreshStateEntry({
        candidate: input.candidate,
        now: input.now,
        fingerprint,
        reason: "assignee_responded",
        prevTotalNudges: prev.totalNudges,
      }),
    });
  }

  // 4b. Status / assignment / monitor / run state changed.
  if (prev.lastFingerprint !== fingerprint) {
    return buildDecision({
      action: "nudge",
      reason: "state_changed",
      input,
      evaluatedAt,
      threshold,
      updatedState: updateStateForStateChange({
        prev,
        now: input.now,
        fingerprint,
      }),
    });
  }

  // 4c. Same state for a fresh idle episode (>= threshold since last nudge).
  if (
    lastNudgeMs !== null &&
    nowMs - lastNudgeMs >= threshold
  ) {
    return buildDecision({
      action: "nudge",
      reason: "fresh_idle_episode",
      input,
      evaluatedAt,
      threshold,
      updatedState: updateStateForFreshEpisode({
        prev,
        now: input.now,
        fingerprint,
      }),
    });
  }

  // 4d. Same state, recent nudge — suppress.
  return buildDecision({
    action: "suppress",
    reason: "already_nudged_in_episode",
    input,
    evaluatedAt,
    threshold,
    updatedState: null,
  });
}

/**
 * Compute a "now" value that's safe to pass to `evaluateIssueNudgeGate`. This
 * is mostly a convenience for callers that already have an ISO string from a
 * sweep timestamp.
 */
export function nudgeNow(isoOrDate: Date | string): Date {
  if (isoOrDate instanceof Date) return isoOrDate;
  const parsed = new Date(isoOrDate);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`nudgeNow: invalid timestamp ${isoOrDate}`);
  }
  return parsed;
}

// ---------- internals ----------

function buildDecision(args: {
  action: IssueNudgeDecisionAction;
  reason: IssueNudgeDecisionReason;
  input: EvaluateIssueNudgeGateInput;
  evaluatedAt: string;
  threshold: number;
  updatedState: IssueNudgeStateEntry | null;
}): IssueNudgeDecision {
  return {
    action: args.action,
    reason: args.reason,
    candidate: args.input.candidate,
    previousState: args.input.previousState,
    updatedState: args.updatedState,
    idleEpisodeThresholdMs: args.threshold,
    evaluatedAt: args.evaluatedAt,
  };
}

function createFreshStateEntry(args: {
  candidate: IssueNudgeCandidate;
  now: Date;
  fingerprint: string;
  reason: "first_nudge" | "assignee_responded";
  prevTotalNudges?: number;
}): IssueNudgeStateEntry {
  const isoNow = args.now.toISOString();
  return {
    schemaVersion: 1,
    companyId: args.candidate.companyId,
    issueId: args.candidate.id,
    firstNudgedAt: isoNow,
    lastNudgedAt: isoNow,
    lastFingerprint: args.fingerprint,
    idleEpisodeStartedAt: isoNow,
    consecutiveNoChangeNudges: 0,
    totalNudges: (args.prevTotalNudges ?? 0) + 1,
  };
}

function updateStateForStateChange(args: {
  prev: IssueNudgeStateEntry;
  now: Date;
  fingerprint: string;
}): IssueNudgeStateEntry {
  const isoNow = args.now.toISOString();
  return {
    ...args.prev,
    lastNudgedAt: isoNow,
    lastFingerprint: args.fingerprint,
    idleEpisodeStartedAt: isoNow,
    consecutiveNoChangeNudges: 0,
    totalNudges: args.prev.totalNudges + 1,
  };
}

function updateStateForFreshEpisode(args: {
  prev: IssueNudgeStateEntry;
  now: Date;
  fingerprint: string;
}): IssueNudgeStateEntry {
  const isoNow = args.now.toISOString();
  return {
    ...args.prev,
    lastNudgedAt: isoNow,
    lastFingerprint: args.fingerprint,
    consecutiveNoChangeNudges: args.prev.consecutiveNoChangeNudges + 1,
    totalNudges: args.prev.totalNudges + 1,
  };
}

function candidateHasActiveRun(candidate: IssueNudgeCandidate): boolean {
  return (
    candidate.activeRunId !== null && candidate.activeRunStatus !== null
  );
}

function isLiveRunStatus(status: string | null): boolean {
  if (status === null) return false;
  return (LIVE_RUN_STATUSES as readonly string[]).includes(status);
}

function normalizeTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const ms = normalizeTimestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function normalizeTimestampMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function parseIso(value: string): number | null {
  return normalizeTimestampMs(value);
}

/**
 * Deterministic JSON serialization: sorted keys, no whitespace. Used for the
 * fingerprint hash so semantically identical objects always hash the same
 * regardless of insertion order.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}
