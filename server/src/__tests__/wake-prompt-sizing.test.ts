import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueComments } from "@paperclipai/db";
import {
  buildPaperclipTaskMarkdown,
  buildPaperclipWakePayload,
} from "../services/heartbeat.js";

/**
 * Wake prompt sizing regression suite (CAN-4023).
 *
 * Each test asserts the cap-and-breadcrumb behavior introduced to bound the
 * remaining unbounded wake fields the CAN-4020 audit identified:
 *
 *   1. paperclipTaskMarkdown description -> MAX_TASK_MARKDOWN_DESCRIPTION_CHARS
 *   2. agent session message text        -> MAX_AGENT_SESSION_MESSAGE_CHARS for
 *                                          chat sources, the smaller review cap
 *                                          for `tool_action_review` sources.
 *   3. issueComments fetched once at heartbeat dispatch and shared with the
 *      wake payload via the prefetchedIssueComments seam.
 *
 * Each test also prints a before/after size measurement to stdout so the
 * implementation lane can paste it into the issue as evidence. The assertions
 * use real vitest expectations, not just the console output.
 */

/**
 * Counting db stub: tracks every chained `.from(table)` call and matches by
 * the unique object identity of the table reference. The Drizzle table
 * objects are module-singletons, so referential equality reliably identifies
 * the wake payload's `issueComments` select from every other fetch in the
 * pipeline.
 */
function makeCountingDbStub() {
  const tableCalls: unknown[] = [];
  const chain = () => ({
    where: () => chain(),
    orderBy: () => chain(),
    innerJoin: () => chain(),
    leftJoin: () => chain(),
    limit: () => chain(),
    offset: () => chain(),
    groupBy: () => chain(),
    then: (resolve: (rows: unknown[]) => void) => resolve([]),
  });
  return {
    tableCalls,
    db: {
      select: (..._args: unknown[]) => ({
        from: (table: unknown) => {
          tableCalls.push(table);
          return chain();
        },
      }),
      transaction: async (fn: (tx: unknown) => unknown) =>
        fn({
          select: (..._args: unknown[]) => ({
            from: () => ({
              where: () => ({
                then: (resolve: (rows: unknown[]) => void) => resolve([]),
              }),
            }),
          }),
        }),
    },
  };
}

describe("wake prompt sizing (CAN-4023)", () => {
  it("buildPaperclipTaskMarkdown caps a 60 KB issue description and adds a truncation breadcrumb", () => {
    const fullDescription = [
      "Plan: ship the in-canopy agent loop milestone before the board sync.",
      "x".repeat(60_000),
    ].join("\n");
    const fullSize = fullDescription.length;

    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-bloat",
        identifier: "PAP-4023",
        title: "Cap unbounded wake fields",
        workMode: "standard",
        description: fullDescription,
      },
      wakeComment: {
        id: "wake-comment-1",
        body: "please cap the wake prompt",
      },
    });

    expect(markdown).not.toBeNull();
    expect(markdown!).toContain("Issue description:");
    expect(markdown!).toContain("Plan: ship the in-canopy agent loop");
    expect(markdown!).toContain(
      "[Issue description truncated at 12000 chars; the remainder is on the issue page and will not be re-sent this run.]",
    );
    const fenced = markdown!.match(/```text\n([\s\S]*?)\n```/);
    expect(fenced).not.toBeNull();
    expect(fenced![1].length).toBeLessThanOrEqual(12_000);
    expect(fenced![1].length).toBeGreaterThan(11_000);

    const markdownSize = markdown!.length;
    console.log(
      `[wake-prompt-sizing] buildPaperclipTaskMarkdown description: before=${fullSize} after=${markdownSize} ratio=${(
        markdownSize / fullSize
      ).toFixed(3)}`,
    );
  });

  it("buildPaperclipTaskMarkdown leaves a sub-cap description untouched (no breadcrumb)", () => {
    const description = "Short plan that fits well under the cap.";
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-small",
        identifier: "PAP-4023-S",
        title: "Small issue",
        workMode: "standard",
        description,
      },
      wakeComment: {
        id: "wake-comment-2",
        body: "ping",
      },
    });

    expect(markdown).not.toBeNull();
    expect(markdown!).toContain(description);
    expect(markdown!).not.toContain("truncated at 12000 chars");
  });

  it("buildPaperclipWakePayload caps chat-bound agent messages at 12,000 chars", async () => {
    const longText = "x".repeat(15_000);
    const wakePayload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "gateway_chat_message",
        paperclipAgentMessage: {
          source: "plugin_session",
          pluginKey: "paperclip.gateway",
          sessionId: "session-1",
          text: longText,
        },
      },
    });

    expect(wakePayload?.agentMessage?.source).toBe("plugin_session");
    expect(wakePayload?.agentMessage?.text.length).toBeLessThanOrEqual(12_000);
    expect(wakePayload?.agentMessage?.text.length).toBeGreaterThan(11_000);

    const before = longText.length;
    const after = wakePayload?.agentMessage?.text.length ?? 0;
    console.log(
      `[wake-prompt-sizing] chat agent message: before=${before} after=${after} ratio=${(
        after / before
      ).toFixed(3)}`,
    );
  });

  it("buildPaperclipWakePayload caps tool_action_review-bound agent messages at 2,000 chars", async () => {
    const longText = "y".repeat(15_000);
    const wakePayload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "issue_commented",
        paperclipAgentMessage: {
          source: "tool_action_review",
          sessionId: "session-2",
          text: longText,
        },
      },
    });

    expect(wakePayload?.agentMessage?.source).toBe("tool_action_review");
    expect(wakePayload?.agentMessage?.text.length).toBeLessThanOrEqual(2_000);

    const before = longText.length;
    const after = wakePayload?.agentMessage?.text.length ?? 0;
    console.log(
      `[wake-prompt-sizing] tool_action_review agent message: before=${before} after=${after} ratio=${(
        after / before
      ).toFixed(3)}`,
    );
  });

  it("buildPaperclipWakePayload does not query issue_comments when prefetchedIssueComments is provided", async () => {
    const issueId = randomUUID();
    const wakeCommentId = randomUUID();
    const companyId = "company-1";
    const prefetchedRows = [
      {
        id: wakeCommentId,
        issueId,
        companyId,
        body: "shared from buildExecutionContinuation",
        authorType: "user" as const,
        authorAgentId: null,
        authorUserId: "user-1",
        createdByRunId: null,
        presentation: null,
        metadata: null,
        deletedAt: null,
        deletedByType: null,
        deletedByAgentId: null,
        deletedByUserId: null,
        deletedByRunId: null,
        sourceTrust: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    const counter = makeCountingDbStub();

    const wakePayload = await buildPaperclipWakePayload({
      db: counter.db as never,
      companyId,
      contextSnapshot: {
        wakeReason: "issue_commented",
        issueId,
        wakeCommentIds: [wakeCommentId],
      },
      issueSummary: {
        id: issueId,
        identifier: "PAP-4023",
        title: "Cap unbounded wake fields",
        description: null,
        status: "in_progress",
        priority: "medium",
        workMode: "standard",
      },
      prefetchedIssueComments: prefetchedRows,
    });

    const issueCommentsCalls = counter.tableCalls.filter(
      (table) => table === issueComments,
    ).length;
    expect(issueCommentsCalls).toBe(0);
    expect(wakePayload?.comments?.length).toBe(1);
    expect(wakePayload?.comments?.[0]).toMatchObject({
      id: wakeCommentId,
      body: "shared from buildExecutionContinuation",
    });
    console.log(
      `[wake-prompt-sizing] prefetched comments reuse: issueComments selects=${issueCommentsCalls} (target=0)`,
    );
  });

  it("buildPaperclipWakePayload falls back to its own issue_comments fetch when prefetchedIssueComments is omitted", async () => {
    const issueId = randomUUID();
    const wakeCommentId = randomUUID();
    const counter = makeCountingDbStub();

    const wakePayload = await buildPaperclipWakePayload({
      db: counter.db as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "issue_commented",
        issueId,
        wakeCommentIds: [wakeCommentId],
      },
      issueSummary: {
        id: issueId,
        identifier: "PAP-4023-FALLBACK",
        title: "Fallback path",
        description: null,
        status: "in_progress",
        priority: "medium",
        workMode: "standard",
      },
    });

    const issueCommentsCalls = counter.tableCalls.filter(
      (table) => table === issueComments,
    ).length;
    expect(issueCommentsCalls).toBeGreaterThanOrEqual(1);
    expect(wakePayload).not.toBeNull();
    console.log(
      `[wake-prompt-sizing] fallback comments fetch: issueComments selects=${issueCommentsCalls} (target>=1)`,
    );
  });
});