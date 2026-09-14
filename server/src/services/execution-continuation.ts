import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { sanitizeQuarantinedCommentForHigherTrust } from "./source-trust.js";

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const string = (v: unknown) =>
  typeof v === "string" && v.length > 0 ? v : null;

// A bounded executionContinuation envelope keeps the wake prompt's
// JSON-encoded snapshot from ballooning on long-lived issues. Without these
// caps a standing/recurring timer wake on an issue with a few hundred comments
// and dozens of prior runs re-serializes the entire thread on every heartbeat
// even though nothing changed. The resume-delta path already handles per-run
// edits; these caps bound the *snapshot* the delta is computed against and
// the snapshot that lands in fresh-session prompts.
//
// Origin comments (the comments that authorized this wake) MUST stay in the
// published snapshot: a downstream resume delta computes its diff against the
// prior envelope and must be able to reference the origin row by id, and a
// fresh-session prompt must surface the originating user request.
const EXECUTION_CONTINUATION_MAX_MESSAGES = 50;
const EXECUTION_CONTINUATION_MAX_MESSAGE_BODY_CHARS = 4_000;
const EXECUTION_CONTINUATION_MAX_TOTAL_MESSAGE_BODY_CHARS = 24_000;
const EXECUTION_CONTINUATION_MAX_COMPLETED_ACTIONS = 30;
const EXECUTION_CONTINUATION_MAX_RECOVERY_OUTCOMES = 10;
const MESSAGE_BODY_TRUNCATION_SUFFIX = "\n[... body truncated for prompt budget ...]";

interface EnvelopeMessage {
  id: string;
  authorType: string;
  authorId: string | null;
  createdByRunId: string | null;
  body: string;
  /** True when the prompt-budget cap truncated the original comment body. */
  bodyTruncated?: boolean;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  sourceTrust: unknown;
}

function truncateMessageBody(body: string): {
  body: string;
  bodyTruncated: boolean;
} {
  if (body.length <= EXECUTION_CONTINUATION_MAX_MESSAGE_BODY_CHARS) {
    return { body, bodyTruncated: false };
  }
  const keep = Math.max(
    0,
    EXECUTION_CONTINUATION_MAX_MESSAGE_BODY_CHARS - MESSAGE_BODY_TRUNCATION_SUFFIX.length,
  );
  return {
    body: `${body.slice(0, keep)}${MESSAGE_BODY_TRUNCATION_SUFFIX}`,
    bodyTruncated: true,
  };
}

function capMessagesForEnvelope(input: {
  messages: EnvelopeMessage[];
  mustIncludeIds: ReadonlySet<string>;
}): {
  messages: EnvelopeMessage[];
  omittedCount: number;
  bodyCharsPublished: number;
  bodyCharBudgetHit: boolean;
} {
  const all = input.messages;
  if (all.length === 0) {
    return {
      messages: [],
      omittedCount: 0,
      bodyCharsPublished: 0,
      bodyCharBudgetHit: false,
    };
  }
  // Pass 1: bound every individual message body. Must-include messages (origin
  // comments) get their own body budget so they cannot dominate the total.
  const maxMustIncludeBodyChars = Math.min(
    EXECUTION_CONTINUATION_MAX_TOTAL_MESSAGE_BODY_CHARS,
    Math.max(
      EXECUTION_CONTINUATION_MAX_MESSAGE_BODY_CHARS * 2,
      Math.floor(EXECUTION_CONTINUATION_MAX_TOTAL_MESSAGE_BODY_CHARS / 2),
    ),
  );
  const cappedById = new Map<string, EnvelopeMessage>();
  let mustIncludeChars = 0;
  for (const message of all) {
    if (input.mustIncludeIds.has(message.id)) {
      if (mustIncludeChars >= maxMustIncludeBodyChars) {
        cappedById.set(message.id, { ...message, body: "" });
        continue;
      }
      const { body, bodyTruncated } = truncateMessageBody(message.body);
      if (mustIncludeChars + body.length > maxMustIncludeBodyChars) {
        const remaining = Math.max(0, maxMustIncludeBodyChars - mustIncludeChars);
        cappedById.set(message.id, {
          ...message,
          body: body.slice(0, remaining) + MESSAGE_BODY_TRUNCATION_SUFFIX,
          bodyTruncated: true,
        });
        mustIncludeChars += remaining + MESSAGE_BODY_TRUNCATION_SUFFIX.length;
        continue;
      }
      mustIncludeChars += body.length;
      cappedById.set(message.id, bodyTruncated ? { ...message, body, bodyTruncated } : message);
    } else {
      const { body, bodyTruncated } = truncateMessageBody(message.body);
      cappedById.set(message.id, bodyTruncated ? { ...message, body, bodyTruncated } : message);
    }
  }

  // Pass 2: select which messages to publish. The published set must include
  // every must-include id and the most recent tail messages up to the count
  // and body-char caps. Messages are emitted in their original chronological
  // order so the envelope remains a faithful history (not a reordered digest).
  const totalSlots = EXECUTION_CONTINUATION_MAX_MESSAGES;
  const totalBodyBudget = EXECUTION_CONTINUATION_MAX_TOTAL_MESSAGE_BODY_CHARS;
  const includedIndexes: number[] = [];
  let includedChars = 0;
  let bodyCharBudgetHit = false;
  let remainingSlots = totalSlots;
  // Walk backwards from the newest message, prefer must-include first, then
  // fill remaining slots with non-must-include.
  for (let i = all.length - 1; i >= 0 && remainingSlots > 0; i--) {
    const message = all[i]!;
    const capped = cappedById.get(message.id)!;
    if (input.mustIncludeIds.has(message.id)) {
      includedIndexes.push(i);
      includedChars += capped.body.length;
      remainingSlots -= 1;
    }
  }
  for (let i = all.length - 1; i >= 0 && remainingSlots > 0; i--) {
    const message = all[i]!;
    if (input.mustIncludeIds.has(message.id)) continue;
    const capped = cappedById.get(message.id)!;
    if (includedChars + capped.body.length > totalBodyBudget) {
      const remaining = Math.max(0, totalBodyBudget - includedChars);
      if (remaining > 0) {
        includedIndexes.push(i);
        includedChars += remaining + MESSAGE_BODY_TRUNCATION_SUFFIX.length;
      }
      bodyCharBudgetHit = true;
      break;
    }
    includedIndexes.push(i);
    includedChars += capped.body.length;
    remainingSlots -= 1;
  }
  includedIndexes.sort((a, b) => a - b);
  const published = includedIndexes.map((index) => cappedById.get(all[index]!.id)!);
  const omittedCount = Math.max(0, all.length - published.length);
  return {
    messages: published,
    omittedCount,
    bodyCharsPublished: includedChars,
    bodyCharBudgetHit,
  };
}
export function continuationOriginCommentIds(context: unknown): string[] {
  const c = object(context);
  const prior = object(c.executionContinuation);
  return [
    ...new Set(
      [
        c.commentId,
        c.latestCommentId,
        ...(Array.isArray(c.commentIds) ? c.commentIds : []),
        ...(Array.isArray(c.wakeCommentIds) ? c.wakeCommentIds : []),
        ...(Array.isArray(prior.originCommentIds)
          ? prior.originCommentIds
          : []),
      ].filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
}

/** Also retain user direction delivered after the source run's initial wake. */
export async function currentContinuationOrigins(
  db: Db,
  companyId: string,
  issueId: string,
  context: unknown,
): Promise<string[]> {
  const [latest] = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNotNull(issueComments.authorUserId),
        isNull(issueComments.createdByRunId),
        isNull(issueComments.authorAgentId),
        isNull(issueComments.deletedAt),
      ),
    )
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(1);
  return [
    ...new Set([
      ...continuationOriginCommentIds(context),
      ...(latest ? [latest.id] : []),
    ]),
  ];
}

/** Re-read task scope at dispatch, including messages already delivered to an earlier provider session. */
export async function buildExecutionContinuation(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string;
  context: Record<string, unknown>;
  previousContextRunId?: string | null;
  summary: string | null;
  exposeLowTrustRaw: boolean;
}): Promise<ExecutionContinuationEnvelope> {
  const { db, companyId, issueId } = input;
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (
    !issue ||
    issue.assigneeAgentId !== input.agentId ||
    ["done", "cancelled"].includes(issue.status)
  )
    throw new Error("continuation_task_ownership_changed");
  const rows = await db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
      ),
    )
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const interactions = await db
    .select()
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, issueId),
      ),
    )
    .orderBy(
      asc(issueThreadInteractions.createdAt),
      asc(issueThreadInteractions.id),
    );
  const triggerInteraction = interactions.find(
    (row) => row.id === input.context.interactionId,
  );
  const sourceRunId =
    triggerInteraction?.sourceRunId ??
    string(input.context.retryOfRunId) ??
    string(input.context.previousRunId);
  const sourceRun = sourceRunId
    ? (
        await db
          .select({ context: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(heartbeatRuns.id, sourceRunId),
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            ),
          )
      )[0]
    : null;
  if (sourceRunId && !sourceRun)
    throw new Error("continuation_source_context_missing");
  const originCommentIds = [
    ...new Set([
      ...continuationOriginCommentIds(input.context),
      ...continuationOriginCommentIds(sourceRun?.context),
      ...(triggerInteraction?.originCommentIds ?? []),
      ...(triggerInteraction?.sourceCommentId
        ? [triggerInteraction.sourceCommentId]
        : []),
    ]),
  ];
  // Missing source rows cannot silently become a claim of complete context.
  if (originCommentIds.some((id) => !rows.some((row) => row.id === id)))
    throw new Error("continuation_source_context_missing");
  const allMessages: EnvelopeMessage[] = rows.map((row) => {
    const safe = input.exposeLowTrustRaw
      ? row
      : sanitizeQuarantinedCommentForHigherTrust(row);
    return {
      id: row.id,
      authorType:
        row.authorType ??
        (row.authorUserId ? "user" : row.authorAgentId ? "agent" : "system"),
      authorId: row.authorUserId ?? row.authorAgentId,
      createdByRunId: row.createdByRunId,
      body: row.deletedAt ? "" : safe.body,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deleted: row.deletedAt !== null,
      sourceTrust: row.sourceTrust,
    };
  });
  const mustIncludeIds = new Set(originCommentIds);
  const capped = capMessagesForEnvelope({
    messages: allMessages,
    mustIncludeIds,
  });
  const messages = capped.messages;
  const previousRun = input.previousContextRunId
    ? (
        await db
          .select({ context: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(heartbeatRuns.agentId, input.agentId),
              eq(heartbeatRuns.id, input.previousContextRunId),
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            ),
          )
      )[0]
    : null;
  const priorEnvelope = object(previousRun?.context?.executionContinuation);
  const deliveredMessages = Array.isArray(priorEnvelope.messages)
    ? priorEnvelope.messages.map(object)
    : null;
  const resumeDeltaMessages =
    deliveredMessages && input.previousContextRunId
      ? allMessages.filter(
          (message) =>
            originCommentIds.includes(message.id) ||
            !deliveredMessages.some(
              (prior) =>
                prior.id === message.id &&
                prior.updatedAt === message.updatedAt &&
                prior.body === message.body &&
                prior.deleted === message.deleted &&
                prior.authorId === message.authorId &&
                (prior.createdByRunId ?? null) === message.createdByRunId &&
                JSON.stringify(prior.sourceTrust) ===
                  JSON.stringify(message.sourceTrust),
            ),
        )
      : undefined;
  // Apply the same per-message and total-body budget to the resume delta.
  // Origin comments must stay in the delta so a resumed session always sees
  // its authorizing wake, and edits to delivered messages must still surface;
  // other messages that aged out of the prior snapshot re-enter as low-cost
  // references rather than full bodies.
  const cappedResumeDeltaMessages =
    resumeDeltaMessages === undefined
      ? undefined
      : capMessagesForEnvelope({
          messages: resumeDeltaMessages,
          mustIncludeIds: new Set([
            ...originCommentIds,
            ...(deliveredMessages ?? []).flatMap((prior) =>
              originCommentIds.includes(String(prior.id)) ? [String(prior.id)] : [],
            ),
          ]),
        });
  const latestRequest = messages.findLast(
    (row) =>
      row.authorType === "user" && !row.createdByRunId && !row.deleted && row.body.trim().length > 0,
  );
  const priorRuns = await db
    .select({ id: heartbeatRuns.id, result: heartbeatRuns.resultJson })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      ),
    )
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  const completedActions = priorRuns.flatMap((run) =>
    Object.entries(object(object(run.result).apiToolReceipts)).flatMap(
      ([receiptId, receipt]) => {
        const value = object(receipt);
        return value.state === "completed" &&
          typeof value.operationId === "string"
          ? [
              {
                runId: run.id,
                receiptId,
                operationId: value.operationId,
                result: value.result,
              },
            ]
          : [];
      },
    ),
  );
  // Keep the most recent completed actions; older ones have already been
  // summarized by `completedWork` (the continuation summary document).
  const completedActionsOmittedCount = Math.max(
    0,
    completedActions.length - EXECUTION_CONTINUATION_MAX_COMPLETED_ACTIONS,
  );
  const boundedCompletedActions = completedActions.slice(
    -EXECUTION_CONTINUATION_MAX_COMPLETED_ACTIONS,
  );
  const reconciliations = await db
    .select({
      id: issueRecoveryActions.id,
      evidence: issueRecoveryActions.evidence,
    })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.status, "resolved"),
      ),
    );
  const allRecoveryOutcomes = reconciliations
    .filter((row) => row.evidence.executionReconciliation)
    .map((row) => ({
      recoveryActionId: row.id,
      decision: row.evidence.executionReconciliation,
    }));
  const recoveryOutcomesOmittedCount = Math.max(
    0,
    allRecoveryOutcomes.length - EXECUTION_CONTINUATION_MAX_RECOVERY_OUTCOMES,
  );
  const boundedRecoveryOutcomes = allRecoveryOutcomes.slice(
    -EXECUTION_CONTINUATION_MAX_RECOVERY_OUTCOMES,
  );

  return {
    ...(resumeDeltaMessages && cappedResumeDeltaMessages
      ? {
          resumeDelta: {
            baseRunId: input.previousContextRunId!,
            messages: cappedResumeDeltaMessages.messages,
          },
        }
      : {}),
    recoveryOutcomes: boundedRecoveryOutcomes,
    version: 1,
    companyId,
    issueId,
    trigger: {
      reason: string(input.context.wakeReason) ?? "task_execution",
      interactionId: triggerInteraction?.id ?? null,
      sourceRunId,
    },
    originCommentIds,
    objective: latestRequest?.body ?? issue.description ?? issue.title,
    messages,
    interactionOutcomes: interactions
      .filter((row) => row.status !== "pending")
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        result: row.result,
      })),
    completedWork: input.summary,
    completedActions: boundedCompletedActions,
    unresolvedInteractionIds: interactions
      .filter((row) => row.status === "pending")
      .map((row) => row.id),
    coverage: {
      kind: "full_task_history",
      throughCommentId: allMessages.at(-1)?.id ?? null,
      summaryThroughCommentId: null,
      omittedMessageCount: capped.omittedCount,
      bodyCharsPublished: capped.bodyCharsPublished,
      bodyCharBudgetHit: capped.bodyCharBudgetHit,
      completedActionsOmittedCount,
      recoveryOutcomesOmittedCount,
    },
  };
}
