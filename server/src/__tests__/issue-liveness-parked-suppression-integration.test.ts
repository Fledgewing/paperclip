import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres parked-by-design suppression tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("parked-by-design liveness suppression (CAN-4691)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-can-4691-parked-suppression-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: `${prefix} Assignee`,
        role: "engineer",
        status: "idle",
      },
      {
        id: otherAgentId,
        companyId,
        name: `${prefix} Other`,
        role: "engineer",
        status: "idle",
      },
    ]);
    return { companyId, agentId, otherAgentId };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    title: string;
    status: string;
    assigneeAgentId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: null,
      originKind: "manual",
      originId: null,
      originFingerprint: "default",
    });
    return id;
  }

  async function insertComment(input: {
    companyId: string;
    issueId: string;
    authorAgentId: string | null;
    body: string;
    createdAt: Date;
  }) {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorAgentId: input.authorAgentId,
      authorUserId: null,
      body: input.body,
      createdAt: input.createdAt,
    });
  }

  it("surfaces the blocked_by_assigned_backlog_issue finding when there are no recent comments", async () => {
    const { companyId, agentId } = await seedCompany("BPS");
    const parentId = await insertIssue({
      companyId,
      identifier: "BPS-1",
      title: "Downstream blocked work",
      status: "blocked",
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BPS-2",
      title: "Parked assigned blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: parentId,
      type: "blocks",
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const parent = rows.find((row) => row.id === parentId);

    expect(parent?.blockedInboxAttention).toMatchObject({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_by_assigned_backlog_issue",
      severity: "high",
      owner: { type: "agent", agentId },
      leafIssue: { id: blockerId, identifier: "BPS-2" },
      action: { label: "Resume parked blocker" },
    });
  });

  it("suppresses the finding when the current assignee authored a parked-by-design comment within 7 days", async () => {
    const { companyId, agentId } = await seedCompany("PSS");
    const parentId = await insertIssue({
      companyId,
      identifier: "PSS-1",
      title: "Downstream blocked work",
      status: "blocked",
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PSS-2",
      title: "Intentionally parked blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: parentId,
      type: "blocks",
    });

    const commentAt = new Date(Date.now() - 60 * 60 * 1000);
    await insertComment({
      companyId,
      issueId: blockerId,
      authorAgentId: agentId,
      body: "parked-by-design while upstream design lands",
      createdAt: commentAt,
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const parent = rows.find((row) => row.id === parentId);

    // The specific liveness finding must be suppressed — even if a
    // fallback attention row (`blocked_chain_stalled` from the
    // blocker-attention map) still surfaces, the parked-by-design
    // suppression rule itself must not produce
    // `blocked_by_assigned_backlog_issue` once the assignee has
    // authored a recent comment with the suppression phrase.
    expect(parent?.blockedInboxAttention?.reason).not.toBe(
      "blocked_by_assigned_backlog_issue",
    );
    expect(rows.find((row) => row.id === parentId)).toBeDefined();
  });

  it("resumes the finding when a different author posts a follow-up comment after the suppressor", async () => {
    const { companyId, agentId, otherAgentId } = await seedCompany("PSR");
    const parentId = await insertIssue({
      companyId,
      identifier: "PSR-1",
      title: "Downstream blocked work",
      status: "blocked",
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PSR-2",
      title: "Was parked by design",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: parentId,
      type: "blocks",
    });

    const earlier = new Date(Date.now() - 60 * 60 * 1000);
    const later = new Date(Date.now() - 5 * 60 * 1000);
    await insertComment({
      companyId,
      issueId: blockerId,
      authorAgentId: agentId,
      body: "intentional parked log — design still in flight",
      createdAt: earlier,
    });
    await insertComment({
      companyId,
      issueId: blockerId,
      authorAgentId: otherAgentId,
      body: "Heads up — are we still parked? Need this for the next sprint.",
      createdAt: later,
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const parent = rows.find((row) => row.id === parentId);

    expect(parent?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_assigned_backlog_issue",
      leafIssue: { id: blockerId },
    });
  });

  it("does not surface blocked_by_assigned_backlog_issue when the blocker leaves backlog (other reason wins)", async () => {
    const { companyId, agentId } = await seedCompany("PSL");
    const parentId = await insertIssue({
      companyId,
      identifier: "PSL-1",
      title: "Downstream blocked work",
      status: "blocked",
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PSL-2",
      title: "Moved off backlog",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: parentId,
      type: "blocks",
    });

    await insertComment({
      companyId,
      issueId: blockerId,
      authorAgentId: agentId,
      body: "parked-by-design — moving on anyway",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const parent = rows.find((row) => row.id === parentId);

    // With status `todo`, the leaf is not a backlog blocker, so the
    // suppressed-by-parked finding is not the one that fires. The
    // blocked_inbox attention either surfaces a different reason or
    // is absent — either way, the suppression rule does not falsely
    // hide a real backlog finding.
    expect(parent?.blockedInboxAttention?.reason ?? null).not.toBe(
      "blocked_by_assigned_backlog_issue",
    );
  });

  it("ignores a parked-by-design comment from an author who is not the current assignee", async () => {
    const { companyId, agentId, otherAgentId } = await seedCompany("PSX");
    const parentId = await insertIssue({
      companyId,
      identifier: "PSX-1",
      title: "Downstream blocked work",
      status: "blocked",
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PSX-2",
      title: "Backlog blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: parentId,
      type: "blocks",
    });

    await insertComment({
      companyId,
      issueId: blockerId,
      authorAgentId: otherAgentId,
      body: "parked-by-design",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const parent = rows.find((row) => row.id === parentId);

    expect(parent?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_assigned_backlog_issue",
      leafIssue: { id: blockerId },
    });
  });

  it("ignores a parked-by-design comment that is older than the 7-day lookback", async () => {
    const { companyId, agentId } = await seedCompany("PSO");
    const parentId = await insertIssue({
      companyId,
      identifier: "PSO-1",
      title: "Downstream blocked work",
      status: "blocked",
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PSO-2",
      title: "Stale parked blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: parentId,
      type: "blocks",
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await insertComment({
      companyId,
      issueId: blockerId,
      authorAgentId: agentId,
      body: "parked-by-design",
      createdAt: eightDaysAgo,
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const parent = rows.find((row) => row.id === parentId);

    expect(parent?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_assigned_backlog_issue",
      leafIssue: { id: blockerId },
    });
  });

  it("ignores deleted parked-by-design comments", async () => {
    const { companyId, agentId } = await seedCompany("PSD");
    const parentId = await insertIssue({
      companyId,
      identifier: "PSD-1",
      title: "Downstream blocked work",
      status: "blocked",
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PSD-2",
      title: "Backlog blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: parentId,
      type: "blocks",
    });

    const commentAt = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issueComments).values({
      companyId,
      issueId: blockerId,
      authorAgentId: agentId,
      body: "parked-by-design",
      createdAt: commentAt,
      deletedAt: new Date(),
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const parent = rows.find((row) => row.id === parentId);

    expect(parent?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_assigned_backlog_issue",
      leafIssue: { id: blockerId },
    });
  });

  it("scopes the comment fetch to backlog blockers that appear in relations (bounded cost)", async () => {
    const { companyId, agentId } = await seedCompany("PSB");
    const parentId = await insertIssue({
      companyId,
      identifier: "PSB-1",
      title: "Blocked parent",
      status: "blocked",
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PSB-2",
      title: "Backlog blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    const todoBlockerId = await insertIssue({
      companyId,
      identifier: "PSB-3",
      title: "Todo blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    // `orphanBacklogId` is a backlog issue assigned to the same agent
    // but it appears in zero `blocks` relations. A parked-by-design
    // comment authored here must not reach the parent's liveness
    // computation — the helper scopes to blocker leaves only.
    const orphanBacklogId = await insertIssue({
      companyId,
      identifier: "PSB-4",
      title: "Orphan backlog issue",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    // `secondBacklogBlockerId` is a backlog blocker for the same
    // parent but is NOT the parent the suppression is anchored to.
    // A parked-by-design comment here must not suppress the finding
    // for the first blocker either.
    const secondBacklogBlockerId = await insertIssue({
      companyId,
      identifier: "PSB-5",
      title: "Second backlog blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });

    await db.insert(issueRelations).values([
      {
        companyId,
        issueId: blockerId,
        relatedIssueId: parentId,
        type: "blocks",
      },
      {
        companyId,
        issueId: todoBlockerId,
        relatedIssueId: parentId,
        type: "blocks",
      },
      {
        companyId,
        issueId: secondBacklogBlockerId,
        relatedIssueId: parentId,
        type: "blocks",
      },
    ]);

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    // Comments seeded on issues that are NOT in the blocker-leaf set:
    // the orphan (no relation at all) and the todo blocker (status is
    // not `backlog`). These must not affect the parent's liveness
    // finding — neither one appears in the helper's issue-id list.
    await insertComment({
      companyId,
      issueId: orphanBacklogId,
      authorAgentId: agentId,
      body: "parked-by-design — never going to be a blocker",
      createdAt: oneHourAgo,
    });
    await insertComment({
      companyId,
      issueId: todoBlockerId,
      authorAgentId: agentId,
      body: "parked-by-design",
      createdAt: oneHourAgo,
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const parent = rows.find((row) => row.id === parentId);

    // The parent's blocker (PSB-2) has no comment, so the
    // assigned-backlog finding must fire. The orphan's comment must
    // not have leaked in to suppress it, and the todo-blocker's
    // comment must not have either (todo blockers are excluded by
    // status).
    expect(parent?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_assigned_backlog_issue",
    });
    // The leaf must be one of the actual backlog blockers, never the
    // orphan or the todo blocker.
    const leafId = parent?.blockedInboxAttention?.leafIssue?.id;
    expect([blockerId, secondBacklogBlockerId]).toContain(leafId);
    expect(leafId).not.toBe(orphanBacklogId);
    expect(leafId).not.toBe(todoBlockerId);
  });
});