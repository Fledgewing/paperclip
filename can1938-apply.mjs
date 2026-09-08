#!/usr/bin/env node
// CAN-1938 patch applier — idempotent local authorization fix.
// Permits only a same-company CEO agent to cancel an active peer heartbeat
// run, preserving board access and recording truthful cancellation metadata.
import { copyFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const cliRoot = realpathSync(join(homedir(), ".paperclip/cli/current"));
const target = join(cliRoot, "node_modules/@paperclipai/server/dist/routes/agents.js");
const marker = "// CAN-1938: CEO agents may cancel same-company heartbeat runs.";
const src = readFileSync(target, "utf8");
if (src.includes(marker)) {
  const legacyAuditKey = "agentApiKeyId: req.actor.agentApiKeyId ?? null";
  if (src.includes(legacyAuditKey)) {
    const backup = `${target}.can1938-prepatch`;
    copyFileSync(target, backup);
    writeFileSync(target, src.replace(legacyAuditKey, "agentApiKeyId: req.actor.keyId ?? null"), "utf8");
    console.log(`upgraded CAN-1938 audit key attribution: ${target}`);
    console.log(`backup: ${backup}`);
    process.exit(10);
  }
  console.log(`already applied: ${target}`);
  process.exit(0);
}

const anchor = `    router.post("/heartbeat-runs/:runId/cancel", async (req, res) => {
        assertBoard(req);
        const runId = req.params.runId;
        const existing = await getAccessibleResource(req, res, heartbeat.getRun(runId), "Heartbeat run not found");
        if (!existing)
            return;
        // Stamp the cancellation as operator-initiated (this route is board-only).
        // Recovery reads this to stand down instead of classifying the cancelled
        // run as agent stranding and re-waking the agent the operator just stopped.
        const run = await heartbeat.cancelRun(runId, "Cancelled by a board operator", {
            resultJson: {
                cancelledByActorType: "user",
                cancelledByUserId: req.actor.userId ?? null,
            },
        });
        if (run) {
            await logActivity(db, {
                companyId: run.companyId,
                actorType: "user",
                actorId: req.actor.userId ?? "board",
                action: "heartbeat.cancelled",
                entityType: "heartbeat_run",
                entityId: run.id,
                details: { agentId: run.agentId },
            });
        }
        res.json(run);
    });`;

const replacement = `    router.post("/heartbeat-runs/:runId/cancel", async (req, res) => {
        const runId = req.params.runId;
        const existing = await getAccessibleResource(req, res, heartbeat.getRun(runId), "Heartbeat run not found");
        if (!existing)
            return;
        // CAN-1938: CEO agents may cancel same-company heartbeat runs.
        const isAgentCancellation = req.actor.type === "agent";
        let actorAgent = null;
        if (isAgentCancellation) {
            actorAgent = req.actor.agentId ? await svc.getById(req.actor.agentId) : null;
            if (!actorAgent || actorAgent.companyId !== existing.companyId) {
                res.status(403).json({ error: "Forbidden" });
                return;
            }
            if (actorAgent.role !== "ceo") {
                res.status(403).json({ error: "Only CEO agents can cancel heartbeat runs" });
                return;
            }
        }
        else {
            assertBoard(req);
        }
        const cancellationSource = isAgentCancellation ? "agent_ceo" : "board_operator";
        const cancellationKind = isAgentCancellation ? "agent_ceo_verified_hung_run" : "board_operator";
        const run = await heartbeat.cancelRun(runId, isAgentCancellation ? "Cancelled by a same-company CEO agent" : "Cancelled by a board operator", {
            resultJson: {
                cancelledByActorType: isAgentCancellation ? "agent" : "user",
                cancelledByUserId: isAgentCancellation ? null : req.actor.userId ?? null,
                cancelledByAgentId: isAgentCancellation ? actorAgent.id : null,
                cancelledByRunId: req.actor.runId ?? null,
                cancellationSource,
                cancellationKind,
                targetAgentId: existing.agentId,
                targetRunId: existing.id,
            },
        });
        // cancelRun returns an already-terminal run unchanged, so do not
        // append a duplicate cancellation audit event for that result.
        if (run && ["queued", "running"].includes(existing.status)) {
            await logActivity(db, {
                companyId: run.companyId,
                actorType: isAgentCancellation ? "agent" : "user",
                actorId: isAgentCancellation ? actorAgent.id : req.actor.userId ?? "board",
                agentId: isAgentCancellation ? actorAgent.id : null,
                runId: req.actor.runId ?? null,
                agentApiKeyId: req.actor.keyId ?? null,
                action: "heartbeat.cancelled",
                entityType: "heartbeat_run",
                entityId: run.id,
                details: {
                    agentId: run.agentId,
                    targetAgentId: existing.agentId,
                    targetRunId: existing.id,
                    cancellationSource,
                    cancellationKind,
                },
            });
        }
        res.json(run);
    });`;

if (!src.includes(anchor)) {
  console.error(`ANCHOR MISSING: ${target} changed; port CAN-1938 manually.`);
  process.exit(2);
}
const backup = `${target}.can1938-prepatch`;
copyFileSync(target, backup);
writeFileSync(target, src.replace(anchor, replacement), "utf8");
try {
  execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
} catch (error) {
  copyFileSync(backup, target);
  console.error(`node --check failed; restored ${target} from ${backup}`);
  console.error(error.stderr?.toString() ?? error.message);
  process.exit(3);
}
console.log(`applied CAN-1938 to ${target}`);
console.log(`backup: ${backup}`);
process.exit(10);
