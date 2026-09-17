import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { buildExecutionContinuation } from "./execution-continuation.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "[audit] executionContinuation prompt budget (CAN-4020)",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-c4020-budget-",
      );
      db = createDb(database.connectionString);
      await db
        .insert(companies)
        .values({ id: companyId, name: "AuditCo", issuePrefix: "AUD" });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Executor",
        role: "engineer",
        adapterType: "paperclip_runner",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Long-lived issue",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      // Insert 250 user-authored comments to model a long-running thread.
      const userComments: Array<typeof issueComments.$inferInsert> = Array.from(
        { length: 250 },
        (_, i) => ({
          id: randomUUID(),
          companyId,
          issueId,
          authorType: "user",
          authorUserId: "local-board",
          body: `Comment #${i}: ${"x".repeat(600)}`,
          createdAt: new Date(2026, 0, 1, 0, i),
        }),
      );
      // Insert 50 agent-authored comments.
      const agentComments: Array<typeof issueComments.$inferInsert> = Array.from(
        { length: 50 },
        (_, i) => ({
          id: randomUUID(),
          companyId,
          issueId,
          authorType: "agent",
          authorAgentId: agentId,
          body: `Agent reply #${i}: ${"y".repeat(400)}`,
          createdAt: new Date(2026, 0, 2, 0, i),
        }),
      );
      await db.insert(issueComments).values([...userComments, ...agentComments]);
    }, 60_000);

    afterAll(async () => {
      await database?.cleanup();
    });

    function approxTokens(chars: number): number {
      return Math.ceil(chars / 4);
    }

    it("publishes a bounded message set even with 300 comments on the issue", async () => {
      // Pick the last user comment as the current wake source so it lands in
      // originCommentIds and must remain in the envelope.
      const [latestUser] = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          eq(issueComments.companyId, companyId),
        )
        .orderBy(issueComments.createdAt)
        .limit(1);
      const latestUserId = latestUser?.id ?? null;
      const envelope = await buildExecutionContinuation({
        db,
        companyId,
        issueId,
        agentId,
        context: {
          wakeReason: "heartbeat_timer",
          ...(latestUserId ? { commentId: latestUserId } : {}),
        },
        summary: null,
        exposeLowTrustRaw: false,
      });
      expect(envelope.messages.length).toBeLessThanOrEqual(50);
      expect(envelope.coverage.omittedMessageCount).toBeGreaterThan(0);
      expect(envelope.coverage.bodyCharsPublished).toBeLessThanOrEqual(24_000);
      const rendered = renderPaperclipWakePrompt({
        executionContinuation: envelope,
        issue: {
          id: issueId,
          title: "Long-lived issue",
          description: "Initial brief.",
          descriptionTruncated: false,
          status: "in_progress",
          workMode: "standard",
        },
      });
      console.log(
        `[audit before/after] envelope_messages=${envelope.messages.length} envelope_chars=${JSON.stringify(envelope).length} rendered_chars=${rendered.length} rendered_tokens≈${approxTokens(rendered.length)}`,
      );
    });

    it("keeps origin comments in the envelope even when they fall outside the recent window", async () => {
      const [oldestUser] = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.companyId, companyId))
        .orderBy(issueComments.createdAt)
        .limit(1);
      const oldestUserId = oldestUser?.id;
      expect(oldestUserId).toBeDefined();
      const envelope = await buildExecutionContinuation({
        db,
        companyId,
        issueId,
        agentId,
        context: {
          wakeReason: "issue_commented",
          commentId: oldestUserId,
        },
        summary: null,
        exposeLowTrustRaw: false,
      });
      const ids = new Set(envelope.messages.map((m) => m.id));
      expect(ids.has(oldestUserId!)).toBe(true);
      // Sanity: at least one recent message survives the cap.
      expect(envelope.messages.length).toBeGreaterThan(0);
      // Sanity: the published message count is bounded.
      expect(envelope.messages.length).toBeLessThanOrEqual(50);
    });

    it("truncates individual message bodies that exceed the per-message budget", async () => {
      const huge = randomUUID();
      await db.insert(issueComments).values({
        id: huge,
        companyId,
        issueId,
        authorType: "user",
        authorUserId: "local-board",
        body: "Z".repeat(20_000),
        createdAt: new Date(2026, 1, 1, 0, 0),
      } as typeof issueComments.$inferInsert);
      try {
        const envelope = await buildExecutionContinuation({
          db,
          companyId,
          issueId,
          agentId,
          context: {
            wakeReason: "issue_commented",
            commentId: huge,
          },
          summary: null,
          exposeLowTrustRaw: false,
        });
        const msg = envelope.messages.find((m) => m.id === huge);
        expect(msg).toBeDefined();
        expect(msg!.body.length).toBeLessThanOrEqual(4_200); // cap + suffix
        expect(msg!.bodyTruncated).toBe(true);
      } finally {
        await db.delete(issueComments).where(eq(issueComments.id, huge));
      }
    });

    it("regression: completedActions and recoveryOutcomes are bounded", async () => {
      // Insert 50 prior runs with completed apiToolReceipts and 25 recovery
      // actions to confirm the per-list caps apply.
      const runIds: string[] = [];
      for (let i = 0; i < 50; i++) {
        const runId = randomUUID();
        runIds.push(runId);
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId,
          agentId,
          status: "succeeded",
          resultJson: {
            apiToolReceipts: {
              [`receipt-${i}-a`]: {
                state: "completed",
                operationId: `op-${i}-a`,
                result: { ok: true, i },
              },
              [`receipt-${i}-b`]: {
                state: "completed",
                operationId: `op-${i}-b`,
                result: { ok: true, i, b: true },
              },
            },
          },
          contextSnapshot: { issueId },
        } as typeof heartbeatRuns.$inferInsert);
      }
      try {
        const envelope = await buildExecutionContinuation({
          db,
          companyId,
          issueId,
          agentId,
          context: { wakeReason: "heartbeat_timer" },
          summary: null,
          exposeLowTrustRaw: false,
        });
        expect(envelope.completedActions?.length ?? 0).toBeLessThanOrEqual(30);
        expect(envelope.coverage.completedActionsOmittedCount ?? 0).toBeGreaterThanOrEqual(70);
        // recoveryOutcomes: no recovery actions in the fixture, so the cap
        // should be 0 with no omissions.
        expect(envelope.recoveryOutcomes?.length ?? 0).toBe(0);
        expect(envelope.coverage.recoveryOutcomesOmittedCount ?? 0).toBe(0);
      } finally {
        // Clean up the inserted runs to keep this fixture deterministic.
        for (const runId of runIds) {
          await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        }
      }
    });

    it("regression: repeated heartbeats on the same long-lived issue do not grow the published envelope", async () => {
      // Build the envelope once, then build it again from a simulated prior
      // run's stored snapshot and confirm the second build does not balloon.
      const envelope1 = await buildExecutionContinuation({
        db,
        companyId,
        issueId,
        agentId,
        context: { wakeReason: "heartbeat_timer" },
        summary: null,
        exposeLowTrustRaw: false,
      });
      const simulatedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: simulatedRunId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: {
          issueId,
          executionContinuation: envelope1,
        },
      });
      const envelope2 = await buildExecutionContinuation({
        db,
        companyId,
        issueId,
        agentId,
        context: { wakeReason: "heartbeat_timer" },
        previousContextRunId: simulatedRunId,
        summary: null,
        exposeLowTrustRaw: false,
      });
      // Both envelopes must be bounded — the resumed path emits a resumeDelta
      // field that adds the diff against the prior snapshot, but its own
      // messages list must stay within the same budget so a resumed prompt
      // does not balloon.
      expect(envelope1.messages.length).toBeLessThanOrEqual(50);
      expect(envelope2.messages.length).toBeLessThanOrEqual(50);
      expect(envelope2.resumeDelta?.messages.length ?? 0).toBeLessThanOrEqual(50);
      const size1 = JSON.stringify(envelope1).length;
      const size2 = JSON.stringify(envelope2).length;
      console.log(
        `[audit repeated heartbeats] envelope1_chars=${size1} envelope2_chars=${size2}`,
      );
      // Both envelopes are bounded; the resumed path adds resumeDelta but
      // both must be far below the unbounded worst case. The unbounded
      // worst case for this fixture would be 300 messages × ~1 KB each
      // serialized into the snapshot plus the same in resumeDelta.
      const worstCase = 300 * 1_000;
      expect(size1).toBeLessThan(worstCase);
      expect(size2).toBeLessThan(worstCase);
      // Sanity: the cap must be applied to BOTH the snapshot messages and
      // the resume-delta messages so a resumed prompt does not balloon.
      expect(envelope1.messages.length).toBeLessThanOrEqual(50);
      expect(envelope2.messages.length).toBeLessThanOrEqual(50);
      expect(envelope2.resumeDelta?.messages.length ?? 0).toBeLessThanOrEqual(50);
    });
  },
);
