# CAN-1938 — CEO cancellation of verified hung runs

`can1938-apply.mjs` patches the installed Paperclip server route
`dist/routes/agents.js` and recovery service `dist/services/recovery/service.js`.
It leaves the board path intact and permits only an agent whose stored role is
`ceo` and whose company matches the target run. The patch rejects ordinary
agents and cross-company requests.

For an active cancellation, `resultJson` and the activity log record the actor
type/id/run, `agent_ceo` source/kind, and target agent/run. A terminal run is
returned unchanged without a duplicate activity event.

Recovery treats only stamped `agent_ceo` cancellations (along with the existing
board/user cancellation forms) as an authorized stop, preventing an automatic
stranding wake from undoing the CEO cancellation.

The existing `can745-ensure.sh` launch-agent hook invokes this applier after
each Paperclip update. Exit `0` means the patch is present or was applied; `2`
means the installed build no longer matches the safe anchor; `3` means syntax
validation failed.
