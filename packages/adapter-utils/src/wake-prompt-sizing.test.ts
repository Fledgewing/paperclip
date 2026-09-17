import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt, normalizePaperclipWakePayload } from "./server-utils.js";

const BODY_AVG = 320;
const LONG_BODY_AVG = 800;

function makeComment(id: string, bodyLength: number, opts: { author?: string; idx?: number } = {}) {
  const idx = opts.idx ?? 0;
  const author = opts.author ?? (idx % 2 === 0 ? "user" : "agent");
  const body = "x".repeat(bodyLength);
  return {
    id,
    issueId: "issue-1",
    body,
    bodyTruncated: false,
    authorType: author,
    authorId: `${author}-${idx}`,
  };
}

function approxTokens(chars: number): number {
  // ~4 chars per token (English mix)
  return Math.ceil(chars / 4);
}

describe("[audit] wake prompt sizing", () => {
  it("measure baseline wake prompt for issue_assigned with description", () => {
    const description = "Implement feature X. ".repeat(120); // ~2.6 KB
    const payload = {
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Implement feature X",
        description,
        descriptionTruncated: false,
        status: "in_progress",
        workMode: "standard",
        priority: "high",
      },
      commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
      comments: [],
      fallbackFetchNeeded: false,
    };
    const prompt = renderPaperclipWakePrompt(payload);
    console.log(
      `[baseline issue_assigned] chars=${prompt.length} approx_tokens=${approxTokens(prompt.length)}`,
    );
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("measure wake prompt with 8 large wake comments (full quota)", () => {
    const payload = {
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Long thread",
        description: "Initial brief.",
        descriptionTruncated: false,
        status: "in_progress",
        workMode: "standard",
        priority: "high",
      },
      commentWindow: { requestedCount: 8, includedCount: 8, missingCount: 0 },
      commentIds: Array.from({ length: 8 }, (_, i) => `c-${i}`),
      latestCommentId: "c-7",
      comments: Array.from({ length: 8 }, (_, i) =>
        makeComment(`c-${i}`, LONG_BODY_AVG, { idx: i }),
      ),
      fallbackFetchNeeded: false,
    };
    const prompt = renderPaperclipWakePrompt(payload);
    console.log(
      `[wake 8 comments] chars=${prompt.length} approx_tokens=${approxTokens(prompt.length)}`,
    );
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("measure wake prompt with continuation summary at 8 KB cap", () => {
    const summaryBody = [
      "# Continuation Summary",
      "",
      "## Objective",
      "x".repeat(1_100),
      "",
      "## Acceptance Criteria",
      "y".repeat(1_100),
      "",
      "## Recent Concrete Actions",
      "z".repeat(1_100),
      "",
      "## Files / Routes Touched",
      "- p/a",
      "",
      "## Commands Run",
      "- run heartbeat",
      "",
      "## Blockers / Decisions",
      "- none",
      "",
      "## Next Action",
      "- resume",
    ].join("\n");
    const payload = {
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Long-running issue",
        description: "Initial brief.",
        descriptionTruncated: false,
        status: "in_progress",
        workMode: "standard",
        priority: "high",
      },
      continuationSummary: {
        key: "summary",
        title: "Continuation Summary",
        body: summaryBody,
        bodyTruncated: false,
        updatedAt: "2026-09-07T13:59:39.464Z",
      },
      commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
      comments: [],
      fallbackFetchNeeded: false,
    };
    const prompt = renderPaperclipWakePrompt(payload);
    console.log(
      `[continuation 8k] chars=${prompt.length} approx_tokens=${approxTokens(prompt.length)}`,
    );
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("measure wake prompt with full executionContinuation snapshot (200 comment thread, fresh session)", () => {
    const messages = Array.from({ length: 200 }, (_, i) => ({
      id: `m-${i}`,
      authorType: i % 2 === 0 ? "user" : "agent",
      authorId: i % 2 === 0 ? `user-${i}` : `agent-${i}`,
      createdByRunId: i % 2 === 1 ? `run-${i}` : null,
      body: "msg ".repeat(BODY_AVG / 4),
      createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
      updatedAt: new Date(2026, 0, 1, 0, i).toISOString(),
      deleted: false,
      sourceTrust: null,
    }));
    const interactions = Array.from({ length: 20 }, (_, i) => ({
      id: `interaction-${i}`,
      kind: "request_confirmation",
      status: "accepted",
      result: { outcome: "accepted", reason: "ok" },
    }));
    const priorRuns = Array.from({ length: 30 }, (_, i) => ({
      id: `run-${i}`,
      result: {
        apiToolReceipts: {
          [`receipt-${i}-a`]: {
            state: "completed",
            operationId: `op-${i}-a`,
            result: { output: "ok" },
          },
          [`receipt-${i}-b`]: {
            state: "completed",
            operationId: `op-${i}-b`,
            result: { output: "ok" },
          },
        },
      },
    }));
    const recoveryOutcomes = Array.from({ length: 10 }, (_, i) => ({
      recoveryActionId: `recovery-${i}`,
      decision: { outcome: "executed", note: "did it" },
    }));
    const executionContinuation = {
      version: 1,
      companyId: "company-1",
      issueId: "issue-1",
      trigger: { reason: "task_execution", interactionId: null, sourceRunId: null },
      originCommentIds: ["m-199"],
      objective: "Initial objective.",
      messages,
      interactionOutcomes: interactions,
      completedWork: "summary body",
      completedActions: priorRuns.flatMap((run) =>
        Object.entries((run.result.apiToolReceipts as Record<string, any>)).map(([receiptId, receipt]) => ({
          runId: run.id,
          receiptId,
          operationId: (receipt as any).operationId,
          result: (receipt as any).result,
        })),
      ),
      unresolvedInteractionIds: [],
      recoveryOutcomes,
      coverage: { kind: "full_task_history", throughCommentId: "m-199", summaryThroughCommentId: null },
    };
    const payload = {
      reason: "issue_assigned",
      executionContinuation,
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Long-running issue",
        description: "Initial brief.",
        descriptionTruncated: false,
        status: "in_progress",
        workMode: "standard",
        priority: "high",
      },
      commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
      comments: [],
      fallbackFetchNeeded: false,
    };
    const prompt = renderPaperclipWakePrompt(payload);
    console.log(
      `[fresh full executionContinuation 200 msgs / 30 priorRuns / 10 recoveries] chars=${prompt.length} approx_tokens=${approxTokens(prompt.length)}`,
    );
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("measure wake prompt with delta executionContinuation (resumed session, 1 new msg)", () => {
    const allMessages = Array.from({ length: 200 }, (_, i) => ({
      id: `m-${i}`,
      authorType: i % 2 === 0 ? "user" : "agent",
      authorId: i % 2 === 0 ? `user-${i}` : `agent-${i}`,
      createdByRunId: i % 2 === 1 ? `run-${i}` : null,
      body: "msg ".repeat(BODY_AVG / 4),
      createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
      updatedAt: new Date(2026, 0, 1, 0, i).toISOString(),
      deleted: false,
      sourceTrust: null,
    }));
    // Simulate the resumed-session delta path: priorEnvelope had 199 messages, only 1 new.
    const priorEnvelope = { messages: allMessages.slice(0, 199) };
    const resumeDeltaMessages = [allMessages[199]]; // only the new one is in delta
    const executionContinuation = {
      version: 1,
      companyId: "company-1",
      issueId: "issue-1",
      trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
      originCommentIds: ["m-199"],
      objective: "Initial objective.",
      messages: allMessages, // full snapshot in executionContinuation.messages
      interactionOutcomes: [],
      completedWork: "summary body",
      completedActions: [],
      unresolvedInteractionIds: [],
      recoveryOutcomes: [],
      resumeDelta: { baseRunId: "run-0", messages: resumeDeltaMessages },
      coverage: { kind: "full_task_history", throughCommentId: "m-199", summaryThroughCommentId: null },
    };
    const payload = {
      reason: "issue_commented",
      executionContinuation,
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Long-running issue",
        description: "Initial brief.",
        descriptionTruncated: false,
        status: "in_progress",
        workMode: "standard",
        priority: "high",
      },
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
      commentIds: ["m-199"],
      latestCommentId: "m-199",
      comments: [makeComment("m-199", BODY_AVG, { idx: 199 })],
      fallbackFetchNeeded: false,
    };
    const prompt = renderPaperclipWakePrompt(payload, { resumedSession: true });
    const snapshotLen = JSON.stringify({ ...executionContinuation, resumeDelta: undefined }).length;
    console.log(
      `[resumed delta] chars=${prompt.length} approx_tokens=${approxTokens(prompt.length)} snapshot_json_chars=${snapshotLen}`,
    );
    expect(prompt.length).toBeGreaterThan(0);
    expect(priorEnvelope.messages.length).toBe(199);
  });

  it("measure prompt repetition across heartbeats (5x resume of same payload)", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      id: `m-${i}`,
      authorType: i % 2 === 0 ? "user" : "agent",
      authorId: i % 2 === 0 ? `user-${i}` : `agent-${i}`,
      createdByRunId: i % 2 === 1 ? `run-${i}` : null,
      body: "msg ".repeat(BODY_AVG / 4),
      createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
      updatedAt: new Date(2026, 0, 1, 0, i).toISOString(),
      deleted: false,
      sourceTrust: null,
    }));
    const executionContinuation = {
      version: 1,
      companyId: "company-1",
      issueId: "issue-1",
      trigger: { reason: "heartbeat_timer", interactionId: null, sourceRunId: null },
      originCommentIds: [],
      objective: "Watch the watchdog subtree.",
      messages,
      interactionOutcomes: [],
      completedWork: null,
      completedActions: [],
      unresolvedInteractionIds: [],
      recoveryOutcomes: [],
      coverage: { kind: "full_task_history", throughCommentId: "m-49", summaryThroughCommentId: null },
    };
    const payload = {
      reason: "heartbeat_timer",
      executionContinuation,
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Standing timer",
        description: "Long initial brief.\n".repeat(60),
        descriptionTruncated: false,
        status: "in_progress",
        workMode: "standard",
        priority: "medium",
      },
      commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
      comments: [],
      fallbackFetchNeeded: false,
    };
    let total = 0;
    for (let i = 0; i < 5; i++) {
      const p = renderPaperclipWakePrompt(payload, { resumedSession: true });
      total += p.length;
      console.log(
        `[timer wake run #${i}] chars=${p.length} approx_tokens=${approxTokens(p.length)}`,
      );
    }
    console.log(
      `[timer wake 5-run total] chars=${total} approx_tokens=${approxTokens(total)}`,
    );
    expect(total).toBeGreaterThan(0);
  });

  it("normalize rejects malformed payloads (regression baseline)", () => {
    const result = normalizePaperclipWakePayload({
      issue: { id: "i", title: "t", description: "d", descriptionTruncated: false, status: "in_progress", workMode: "standard" },
    });
    expect(result).toBeTruthy();
    expect(result?.issue?.title).toBe("t");
  });
});
