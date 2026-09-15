import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, issueRelations } from "@paperclipai/db";

export const ISSUE_LIVENESS_REPAIR_WAKE_REASON = "issue_liveness_repair";

export type IssueLivenessRepairOutcome =
  | "repaired_and_woke"
  | "repaired_wake_skipped_active_path"
  | "repaired_wake_skipped_no_assignee"
  | "repaired_wake_deferred"
  | "not_blocked"
  | "has_live_blocker"
  | "active_path_present"
  | "interaction_pending"
  | "missing"
  | "updated";

export type IssueLivenessRepairWakeEnqueue = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<{ id: string } | null>;

export type IssueLivenessRepairLogActivity = (input: {
  companyId: string;
  actorType: "system" | "user" | "agent";
  actorId: string;
  agentId: string | null;
  runId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}) => Promise<void>;

export type IssueLivenessRepairUpdateIssueStatus = (
  issueId: string,
  nextStatus: "todo",
) => Promise<typeof issues.$inferSelect | null>;

export interface IssueLivenessRepairInput {
  db: Db;
  companyId: string;
  issueId: string;
  enqueueWakeup: IssueLivenessRepairWakeEnqueue;
  hasActiveExecutionPath: (
    companyId: string,
    issueId: string,
    agentId?: string | null,
  ) => Promise<boolean>;
  hasPendingWakeInteraction: (
    companyId: string,
    issueId: string,
  ) => Promise<boolean>;
  updateIssueStatus: IssueLivenessRepairUpdateIssueStatus;
  logActivity: IssueLivenessRepairLogActivity;
  /**
   * Optional source label for the activity log entry. Defaults to
   * `"recovery.liveness_repair"` when omitted.
   */
  source?: string;
}

export interface IssueLivenessRepairResult {
  outcome: IssueLivenessRepairOutcome;
  issueId: string;
  assigneeAgentId: string | null;
  previousStatus: string | null;
  nextStatus: string | null;
  wakeEnqueued: boolean;
  wakeIdempotencyKey: string | null;
  wakeId: string | null;
  reason: string;
}

export function buildIssueLivenessRepairWakeIdempotencyKey(input: {
  companyId: string;
  issueId: string;
  assigneeAgentId: string;
  blockedTransitionAt?: Date | string | null;
}): string {
  const cycle = formatBlockedCycle(input.blockedTransitionAt);
  return [
    ISSUE_LIVENESS_REPAIR_WAKE_REASON,
    input.companyId,
    input.issueId,
    input.assigneeAgentId,
    cycle,
  ].join(":");
}

function formatBlockedCycle(value: Date | string | null | undefined): string {
  if (value == null) return "none";
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "none" : parsed.toISOString();
}

/**
 * Supported, auditable repair action for blocked-without-live-path issues.
 *
 * Use this when a sweep (e.g. the CEO liveness sweep) has classified an issue
 * as `blocked` but no first-class blocker is on file — an invalid state that
 * strands the assignee forever. The repair transitions the issue to `todo` and
 * wakes the existing agent assignee so the work continues, even when the
 * assignee did not change.
 *
 * The repair deliberately does NOT fire when:
 *  - the issue is not currently `blocked`,
 *  - the issue has an unresolved first-class blocker on file,
 *  - the issue already has an active heartbeat run or pending interaction, or
 *  - the issue has no agent assignee.
 *
 * It returns a structured `IssueLivenessRepairResult` describing the outcome so
 * the caller can log, surface, and skip follow-up work without re-querying.
 */
export async function repairBlockedNoLivePathToTodo(
  input: IssueLivenessRepairInput,
): Promise<IssueLivenessRepairResult> {
  const source = input.source ?? "recovery.liveness_repair";

  const existing = await input.db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.id, input.issueId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!existing) {
    return {
      outcome: "missing",
      issueId: input.issueId,
      assigneeAgentId: null,
      previousStatus: null,
      nextStatus: null,
      wakeEnqueued: false,
      wakeIdempotencyKey: null,
      wakeId: null,
      reason: "Issue row not found at repair time.",
    };
  }

  const baseResult: Omit<IssueLivenessRepairResult, "outcome" | "reason"> = {
    issueId: existing.id,
    assigneeAgentId: existing.assigneeAgentId ?? null,
    previousStatus: existing.status,
    nextStatus: existing.status,
    wakeEnqueued: false,
    wakeIdempotencyKey: null,
    wakeId: null,
  };

  if (existing.status !== "blocked") {
    return {
      ...baseResult,
      outcome: "not_blocked",
      reason: `Issue is currently "${existing.status}", not blocked; no repair needed.`,
    };
  }

  const liveBlockers = await input.db
    .select({ blockerIssueId: issueRelations.issueId })
    .from(issueRelations)
    .innerJoin(
      issues,
      and(
        eq(issues.id, issueRelations.issueId),
        eq(issues.companyId, issueRelations.companyId),
      ),
    )
    .where(
      and(
        eq(issueRelations.companyId, existing.companyId),
        eq(issueRelations.relatedIssueId, existing.id),
        eq(issueRelations.type, "blocks"),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .limit(1);

  if (liveBlockers.length > 0) {
    return {
      ...baseResult,
      outcome: "has_live_blocker",
      reason:
        "Issue still has an unresolved first-class blocker on file; the repair must not bypass it.",
    };
  }

  if (
    await input.hasActiveExecutionPath(
      existing.companyId,
      existing.id,
      existing.assigneeAgentId ?? null,
    )
  ) {
    return {
      ...baseResult,
      outcome: "active_path_present",
      reason:
        "Issue already has an active execution path; the repair must not stack a second run.",
    };
  }

  if (await input.hasPendingWakeInteraction(existing.companyId, existing.id)) {
    return {
      ...baseResult,
      outcome: "interaction_pending",
      reason:
        "A pending wake-targeting interaction already covers this issue; the repair must not stack another wake.",
    };
  }

  const assigneeAgentId = existing.assigneeAgentId ?? null;

  const updated = await input.updateIssueStatus(existing.id, "todo");

  if (!assigneeAgentId) {
    await input.logActivity({
      companyId: existing.companyId,
      actorType: "system",
      actorId: source,
      agentId: null,
      runId: null,
      action: "issue.liveness_repair",
      entityType: "issue",
      entityId: existing.id,
      details: {
        identifier: existing.identifier ?? null,
        previousStatus: "blocked",
        nextStatus: "todo",
        wakeEnqueued: false,
        outcome: "repaired_wake_skipped_no_assignee",
        source,
      },
    });
    return {
      ...baseResult,
      outcome: "repaired_wake_skipped_no_assignee",
      nextStatus: updated?.status ?? "todo",
      reason:
        "Issue had no agent assignee after the status flip; no wake fired. Board must assign before the work can resume.",
    };
  }

  const wakeIdempotencyKey = buildIssueLivenessRepairWakeIdempotencyKey({
    companyId: existing.companyId,
    issueId: existing.id,
    assigneeAgentId,
    blockedTransitionAt: existing.blockedTransitionAt ?? null,
  });

  let wake: { id: string } | null = null;
  let wakeError: unknown = null;
  try {
    wake = await input.enqueueWakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: ISSUE_LIVENESS_REPAIR_WAKE_REASON,
      payload: {
        issueId: existing.id,
        previousStatus: "blocked",
        nextStatus: "todo",
        mutation: "liveness_repair",
        assigneeAgentId,
      },
      idempotencyKey: wakeIdempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: source,
      contextSnapshot: {
        issueId: existing.id,
        taskId: existing.id,
        source,
        wakeReason: ISSUE_LIVENESS_REPAIR_WAKE_REASON,
        mutation: "liveness_repair",
        previousStatus: "blocked",
        nextStatus: "todo",
      },
    });
  } catch (err) {
    wakeError = err;
  }

  if (wakeError) {
    await input.logActivity({
      companyId: existing.companyId,
      actorType: "system",
      actorId: source,
      agentId: assigneeAgentId,
      runId: null,
      action: "issue.liveness_repair",
      entityType: "issue",
      entityId: existing.id,
      details: {
        identifier: existing.identifier ?? null,
        previousStatus: "blocked",
        nextStatus: "todo",
        wakeEnqueued: false,
        outcome: "repaired_wake_deferred",
        idempotencyKey: wakeIdempotencyKey,
        source,
        error: (wakeError as Error)?.message ?? String(wakeError),
      },
    });
    return {
      ...baseResult,
      outcome: "repaired_wake_deferred",
      nextStatus: updated?.status ?? "todo",
      wakeIdempotencyKey,
      reason:
        "Issue was repaired but the wake enqueue raised; sweep will retry next pass without re-flipping status.",
    };
  }

  if (!wake) {
    await input.logActivity({
      companyId: existing.companyId,
      actorType: "system",
      actorId: source,
      agentId: assigneeAgentId,
      runId: null,
      action: "issue.liveness_repair",
      entityType: "issue",
      entityId: existing.id,
      details: {
        identifier: existing.identifier ?? null,
        previousStatus: "blocked",
        nextStatus: "todo",
        wakeEnqueued: false,
        outcome: "repaired_wake_deferred",
        idempotencyKey: wakeIdempotencyKey,
        source,
      },
    });
    return {
      ...baseResult,
      outcome: "repaired_wake_deferred",
      nextStatus: updated?.status ?? "todo",
      wakeIdempotencyKey,
      reason:
        "Issue was repaired but the wake was deferred by the heartbeat scheduler (no eligible run row); sweep will retry.",
    };
  }

  await input.logActivity({
    companyId: existing.companyId,
    actorType: "system",
    actorId: source,
    agentId: assigneeAgentId,
    runId: null,
    action: "issue.liveness_repair",
    entityType: "issue",
    entityId: existing.id,
    details: {
      identifier: existing.identifier ?? null,
      previousStatus: "blocked",
      nextStatus: "todo",
      wakeEnqueued: true,
      outcome: "repaired_and_woke",
      wakeupRunId: wake.id,
      idempotencyKey: wakeIdempotencyKey,
      source,
    },
  });

  return {
    ...baseResult,
    outcome: "repaired_and_woke",
    nextStatus: updated?.status ?? "todo",
    wakeEnqueued: true,
    wakeIdempotencyKey,
    wakeId: wake.id,
    reason:
      "Issue was repaired from `blocked` (no live blocker) to `todo`; the unchanged assignee was woken.",
  };
}