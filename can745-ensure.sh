#!/bin/sh
# CAN-745 patch persistence — run by LaunchAgent ing.canopypowered.can745-patch
# whenever ~/.paperclip/cli/install.json changes (i.e. after any paperclipai
# update) and at load. Idempotent: exits quietly when the patch is present.
set -u

PATCH_DIR="$HOME/.paperclip/instances/default/patches"
LOG="$PATCH_DIR/can745-ensure.log"
NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"
API_BASE="http://127.0.0.1:3100"
KEY_FILE="$HOME/.paperclip/agent-keys/7beb5298-ab4e-4d65-b025-7c5c1bd6564b.key"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

notify_issue() {
  # Best-effort comment on CAN-745 so a failure is visible on the board.
  [ -f "$KEY_FILE" ] || return 0
  BODY=$(printf '%s' "$1" | sed 's/"/\\"/g')
  curl -s -m 10 -X POST \
    -H "Authorization: Bearer $(cat "$KEY_FILE")" \
    -H "Content-Type: application/json" \
    -d "{\"body\":\"$BODY\"}" \
    "$API_BASE/api/issues/CAN-745/comments" >> "$LOG" 2>&1 || true
  echo >> "$LOG"
}

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HOME/.paperclip/cli/install.json" 2>/dev/null | head -1)
log "check start (paperclipai $VERSION)"

# CAN-745 first.
"$NODE_BIN" "$PATCH_DIR/can745-apply.mjs" >> "$LOG" 2>&1
RC745=$?

case $RC745 in
  0)
    log "CAN-745 patch already present; nothing to do"
    ;;
  10)
    log "CAN-745 patch re-applied after update to $VERSION; restarting paperclipai service"
    launchctl kickstart -k "gui/$(id -u)/ing.paperclip.paperclipai" >> "$LOG" 2>&1
    notify_issue "🔧 CAN-745 auto-repatch: paperclipai updated to $VERSION; the recovery-sweep grace patch was re-applied automatically and the service was restarted. Verify with: grep -n RUN_OUTPUT_GRACE_MS ~/.paperclip/cli/current/node_modules/@paperclipai/server/dist/services/recovery/service.js"
    ;;
  *)
    log "CAN-745 PATCH FAILED (rc=$RC745) on paperclipai $VERSION — manual port needed"
    notify_issue "⚠️ CAN-745 auto-repatch FAILED (exit $RC745) after paperclipai update to $VERSION. The recovery-sweep grace patch is NOT active — the orphaned_running_run race is live again. Port the patch manually per ~/.paperclip/instances/default/patches/CAN-745-recovery-sweep-grace.patch.md."
    ;;
esac

# CAN-1117 next. The ing.canopypowered.can745-patch LaunchAgent only
# supports a single program argument, so CAN-1117 is wired in here
# instead of getting its own LaunchAgent. See
# CAN-1117-watchdog-self-authored-write.patch.md §5.
"$NODE_BIN" "$PATCH_DIR/can1117-apply.mjs" >> "$LOG" 2>&1
RC1117=$?

case $RC1117 in
  0)
    log "CAN-1117 patch already present; nothing to do"
    ;;
  10)
    log "CAN-1117 patch re-applied after update to $VERSION; restarting paperclipai service"
    launchctl kickstart -k "gui/$(id -u)/ing.paperclip.paperclipai" >> "$LOG" 2>&1
    notify_issue "🔧 CAN-1117 auto-repatch: paperclipai updated to $VERSION; the watchdog-self-authored-write patch was re-applied automatically and the service was restarted. Verify with: grep -n CAN-1117 ~/.paperclip/cli/current/node_modules/@paperclipai/server/dist/routes/issues.js ~/.paperclip/cli/current/node_modules/@paperclipai/server/dist/services/task-watchdog-scope.js"
    ;;
  *)
    log "CAN-1117 PATCH FAILED (rc=$RC1117) on paperclipai $VERSION — manual port needed"
    notify_issue "⚠️ CAN-1117 auto-repatch FAILED (exit $RC1117) after paperclipai update to $VERSION. The watchdog-self-authored-write patch is NOT active — task-watchdog runs that create child issues will 409 on the required follow-up assign/comment. Port the patch manually per ~/.paperclip/instances/default/patches/CAN-1117-watchdog-self-authored-write.patch.md."
    ;;
esac

# CAN-1414 next, same single-LaunchAgent reason as CAN-1117. Stops a review
# stage from escalating to the local-board pseudo-user (which nothing can
# action) once the changes-requested round cap trips. See
# CAN-1414-board-escalation-dissolve.patch.md.
"$NODE_BIN" "$PATCH_DIR/can1414-apply.mjs" >> "$LOG" 2>&1
RC1414=$?

case $RC1414 in
  0)
    log "CAN-1414 patch already present; nothing to do"
    ;;
  10)
    log "CAN-1414 patch re-applied after update to $VERSION; restarting paperclipai service"
    launchctl kickstart -k "gui/$(id -u)/ing.paperclip.paperclipai" >> "$LOG" 2>&1
    notify_issue "🔧 CAN-1414 auto-repatch: paperclipai updated to $VERSION; the board-escalation-dissolve patch was re-applied automatically and the service was restarted. Verify with: grep -n CAN-1414 ~/.paperclip/cli/current/node_modules/@paperclipai/server/dist/services/issue-execution-policy.js"
    ;;
  *)
    log "CAN-1414 PATCH FAILED (rc=$RC1414) on paperclipai $VERSION — manual port needed"
    notify_issue "⚠️ CAN-1414 auto-repatch FAILED (exit $RC1414) after paperclipai update to $VERSION. Review stages will again escalate to local-board on round-cap exhaustion and deadlock the issue for every agent (the CAN-1389 failure). Port the patch manually per ~/.paperclip/instances/default/patches/CAN-1414-board-escalation-dissolve.patch.md."
    ;;
esac

# CAN-1720 next, same single-LaunchAgent reason as CAN-1117. Stops the
# cross-issue influence gate from 403-ing every comment/update issued by a
# timer-woken heartbeat run (which carries no issueId in its contextSnapshot) —
# the failure that silenced the Ops Sentinel watchdog entirely. See
# CAN-1720-cross-issue-influence-timer-run-context.patch.md.
"$NODE_BIN" "$PATCH_DIR/can1720-apply.mjs" >> "$LOG" 2>&1
RC1720=$?

case $RC1720 in
  0)
    log "CAN-1720 patch already present; nothing to do"
    ;;
  10)
    log "CAN-1720 patch re-applied after update to $VERSION; restarting paperclipai service"
    launchctl kickstart -k "gui/$(id -u)/ing.paperclip.paperclipai" >> "$LOG" 2>&1
    notify_issue "🔧 CAN-1720 auto-repatch: paperclipai updated to $VERSION; the cross-issue-influence timer-run-context patch was re-applied automatically and the service was restarted. Verify with: grep -n CAN-1720 ~/.paperclip/cli/current/node_modules/@paperclipai/server/dist/services/cross-issue-influence-limit.js"
    ;;
  *)
    log "CAN-1720 PATCH FAILED (rc=$RC1720) on paperclipai $VERSION — manual port needed"
    notify_issue "⚠️ CAN-1720 auto-repatch FAILED (exit $RC1720) after paperclipai update to $VERSION. Every comment and issue update from a timer-woken heartbeat run will 403 with cross_issue_influence_run_context_required again — this silences the Ops Sentinel and any other timer-cadence agent completely. Port the patch manually per ~/.paperclip/instances/default/patches/CAN-1720-cross-issue-influence-timer-run-context.patch.md."
    ;;
esac

# CAN-1938 last: preserve the CEO same-company hung-run cancellation route
# after Paperclip updates, using the existing single LaunchAgent hook.
"$NODE_BIN" "$PATCH_DIR/can1938-apply.mjs" >> "$LOG" 2>&1
RC1938=$?

case $RC1938 in
  0)
    log "CAN-1938 patch already present; nothing to do"
    ;;
  10)
    log "CAN-1938 patch re-applied after update to $VERSION; restarting paperclipai service"
    launchctl kickstart -k "gui/$(id -u)/ing.paperclip.paperclipai" >> "$LOG" 2>&1
    ;;
  *)
    log "CAN-1938 PATCH FAILED (rc=$RC1938) on paperclipai $VERSION — manual port needed"
    ;;
esac
exit 0
