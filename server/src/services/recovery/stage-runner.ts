import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { agents, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { issueService } from "../issues.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "../issue-assignment-wakeup.js";

export type RecoveryStageLogger = {
  info: (obj?: unknown, msg?: string) => void;
  warn: (obj?: unknown, msg?: string) => void;
  error: (obj?: unknown, msg?: string) => void;
};

export type RecoveryStageHealth = {
  stage: string;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  firstFailureAt: Date | null;
  consecutiveFailures: number;
  lastErrorMessage: string | null;
  escalated: boolean;
};

// Five minutes at the 30s tick: long enough to ride out a transient, short
// enough that a multi-hour silent recovery outage cannot pass unnoticed.
export const RECOVERY_STAGE_FAILURE_ESCALATION_THRESHOLD = 10;

export const RECOVERY_STAGE_STUCK_TITLE_PREFIX = "Recovery stage stuck:";

// The stuck-stage escalation owner (CAN-4307): the CEO. Assigned so a dead
// recovery stage becomes first-class work instead of a line in a 460MB log.
export const RECOVERY_STAGE_ESCALATION_CEO_AGENT_ID =
  "8a527ddc-a8f4-4706-a46e-f7f30c970aeb";

export type RecoveryStageResults = ReadonlyMap<string, unknown>;

export type RecoveryStage = {
  name: string;
  run: (results: RecoveryStageResults) => Promise<unknown>;
};

function stageErrorDetail(err: unknown): { err: unknown; message: string } {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);
  return { err, message };
}

export function createRecoveryStageRunner(deps: {
  stages: RecoveryStage[];
  logger: RecoveryStageLogger;
  escalate?: (stage: RecoveryStageHealth) => Promise<unknown>;
  escalationThreshold?: number;
  isStopped?: () => boolean;
  now?: () => Date;
}) {
  const threshold = deps.escalationThreshold ?? RECOVERY_STAGE_FAILURE_ESCALATION_THRESHOLD;
  const now = deps.now ?? (() => new Date());
  const isStopped = deps.isStopped ?? (() => false);
  const seenNames = new Set<string>();
  for (const stage of deps.stages) {
    if (seenNames.has(stage.name)) {
      throw new Error(`duplicate recovery stage name: ${stage.name}`);
    }
    seenNames.add(stage.name);
  }
  const health = new Map<string, RecoveryStageHealth>();
  for (const stage of deps.stages) {
    health.set(stage.name, {
      stage: stage.name,
      lastSuccessAt: null,
      lastFailureAt: null,
      firstFailureAt: null,
      consecutiveFailures: 0,
      lastErrorMessage: null,
      escalated: false,
    });
  }

  async function failStage(name: string, err: unknown, at: Date) {
    const stageHealth = health.get(name)!;
    stageHealth.consecutiveFailures += 1;
    stageHealth.lastFailureAt = at;
    if (stageHealth.firstFailureAt === null) stageHealth.firstFailureAt = at;
    stageHealth.lastErrorMessage = stageErrorDetail(err).message;
    deps.logger.error(
      { err, stage: name },
      "heartbeat recovery stage failed",
    );
    if (
      stageHealth.consecutiveFailures >= threshold &&
      !stageHealth.escalated &&
      deps.escalate
    ) {
      // Claim the escalation before awaiting so a slow or failing escalation
      // cannot double-fire on a later tick of the same failure episode.
      stageHealth.escalated = true;
      try {
        await deps.escalate({ ...stageHealth });
      } catch (escalationErr) {
        stageHealth.escalated = false;
        deps.logger.error(
          { err: escalationErr, stage: name },
          "recovery stage escalation failed",
        );
      }
    }
  }

  function succeedStage(name: string, at: Date) {
    const stageHealth = health.get(name)!;
    stageHealth.consecutiveFailures = 0;
    stageHealth.lastSuccessAt = at;
    stageHealth.firstFailureAt = null;
    // Recovery releases the escalation latch so a future stuck episode can
    // escalate again; the durable issue itself is reconciled by the
    // escalator (update-in-place while open, create once it is closed).
    stageHealth.escalated = false;
  }

  async function runOnce(): Promise<RecoveryStageResults> {
    const results = new Map<string, unknown>();
    for (const stage of deps.stages) {
      if (isStopped()) break;
      try {
        results.set(stage.name, await stage.run(results));
        succeedStage(stage.name, now());
      } catch (err) {
        results.set(stage.name, undefined);
        await failStage(stage.name, err, now());
      }
    }
    return results;
  }

  function getStageHealth(name: string): RecoveryStageHealth | null {
    const stageHealth = health.get(name);
    return stageHealth ? { ...stageHealth } : null;
  }

  function getStageHealthSnapshot(): RecoveryStageHealth[] {
    return [...health.values()].map((stageHealth) => ({ ...stageHealth }));
  }

  return { runOnce, getStageHealth, getStageHealthSnapshot };
}

export type RecoveryStageEscalationPorts = {
  findCompanyIdForAgent: (agentId: string) => Promise<string | null>;
  findOpenIssueByTitle: (
    companyId: string,
    title: string,
  ) => Promise<{ id: string; status: string } | null>;
  createIssue: (
    companyId: string,
    input: {
      title: string;
      description: string;
      priority: "high";
      assigneeAgentId: string;
      idempotencyKey: string;
      allowDuplicate: false;
    },
  ) => Promise<{ id: string; assigneeAgentId: string | null; status: string }>;
  updateIssue: (
    issueId: string,
    input: { description: string },
  ) => Promise<unknown>;
  wakeAssignee: (
    issue: { id: string; assigneeAgentId: string | null; status: string },
    stage: string,
  ) => Promise<unknown>;
};

export function normalizeRecoveryStageIssueTitle(title: string) {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

export function buildRecoveryStageStuckIssueMarkdown(
  health: RecoveryStageHealth,
  at: Date = new Date(),
): string {
  return [
    `A periodic heartbeat recovery stage has failed ${health.consecutiveFailures} times in a row (threshold ${RECOVERY_STAGE_FAILURE_ESCALATION_THRESHOLD}). This stage's recovery work has been dead since the first failure; every other stage keeps running, so nothing else will surface this.`,
    "",
    `## Stage`,
    `- Stage: \`${health.stage}\``,
    `- Consecutive failures: ${health.consecutiveFailures}`,
    `- First failure at: ${health.firstFailureAt?.toISOString() ?? "unknown"}`,
    `- Last failure at: ${health.lastFailureAt?.toISOString() ?? "unknown"}`,
    `- Last success at: ${health.lastSuccessAt?.toISOString() ?? "never (since process start)"}`,
    "",
    `## Last error`,
    "```",
    health.lastErrorMessage ?? "unknown",
    "```",
    "",
    `This issue is updated in place while the stage stays stuck and is not re-created for later episodes while it remains open. Check \`${health.stage}\` in \`server/src/index.ts\` and the stage log lines \`heartbeat recovery stage failed\` with \`stage: "${health.stage}"\` in the service log.`,
    "",
    `Updated at: ${at.toISOString()}`,
  ].join("\n");
}

export function createRecoveryStageEscalator(deps: {
  ceoAgentId: string;
  ports: RecoveryStageEscalationPorts;
  logger: RecoveryStageLogger;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return async function escalateRecoveryStage(
    health: RecoveryStageHealth,
  ): Promise<
    { kind: "created"; issueId: string } | { kind: "updated"; issueId: string } | { kind: "skipped" }
  > {
    const title = `${RECOVERY_STAGE_STUCK_TITLE_PREFIX} ${health.stage}`;
    const description = buildRecoveryStageStuckIssueMarkdown(health, now());
    const companyId = await deps.ports.findCompanyIdForAgent(deps.ceoAgentId);
    if (!companyId) {
      deps.logger.error(
        { stage: health.stage, ceoAgentId: deps.ceoAgentId },
        "recovery stage escalation skipped: CEO agent not found",
      );
      return { kind: "skipped" };
    }
    const existing = await deps.ports.findOpenIssueByTitle(companyId, title);
    if (existing) {
      await deps.ports.updateIssue(existing.id, { description });
      deps.logger.warn(
        { stage: health.stage, issueId: existing.id },
        "recovery stage escalation updated existing stuck-stage issue",
      );
      return { kind: "updated", issueId: existing.id };
    }
    const episodeKey = health.firstFailureAt
      ? String(health.firstFailureAt.getTime())
      : String(now().getTime());
    const created = await deps.ports.createIssue(companyId, {
      title,
      description,
      priority: "high",
      assigneeAgentId: deps.ceoAgentId,
      idempotencyKey: `recovery-stage-stuck:${health.stage}:${episodeKey}`,
      allowDuplicate: false,
    });
    deps.logger.warn(
      {
        stage: health.stage,
        issueId: created.id,
        consecutiveFailures: health.consecutiveFailures,
      },
      "recovery stage escalation created stuck-stage issue for CEO",
    );
    await deps.ports.wakeAssignee(created, health.stage);
    return { kind: "created", issueId: created.id };
  };
}

export function createPostgresRecoveryStageEscalationPorts(deps: {
  db: Db;
  heartbeat: IssueAssignmentWakeupDeps;
}): RecoveryStageEscalationPorts {
  const db = deps.db;
  const issuesSvc = issueService(db);
  return {
    async findCompanyIdForAgent(agentId) {
      const row = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row?.companyId ?? null;
    },
    async findOpenIssueByTitle(companyId, title) {
      const normalized = normalizeRecoveryStageIssueTitle(title);
      const row = await db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            isNull(issues.hiddenAt),
            notInArray(issues.status, ["done", "cancelled"]),
            sql`lower(regexp_replace(btrim(${issues.title}), '\\s+', ' ', 'g')) = ${normalized}`,
          ),
        )
        .orderBy(sql`${issues.createdAt} asc`, sql`${issues.id} asc`)
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row;
    },
    async createIssue(companyId, input) {
      return issuesSvc.create(companyId, input);
    },
    async updateIssue(issueId, input) {
      return issuesSvc.update(issueId, input);
    },
    async wakeAssignee(issue, stage) {
      return queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        issue,
        reason: "recovery_stage_stuck_assigned",
        mutation: "recovery.stage_stuck_assigned",
        contextSource: "recovery_stage_watchdog",
        requestedByActorType: "system",
        taskKey: `recovery-stage-stuck:${stage}`,
        rethrowOnError: false,
      });
    },
  };
}
