#!/bin/bash
# All dori sweeps in one monitor (a session holds at most 5 persistent monitors).
# watch (5-min done flow), dead-panes, host guard, freshness. (The one-shot G2RS reminder fired 10/11 and was removed:
# a past-due one-shot fires again on every restart.)
# redesign S6: every sweep line and every supervisor event goes through the event router (the lead's only entry):
# it prints DORI_ASK (now) and DORI_DIGEST (15 min, 60 at night) and checkpoints in ~/.omodori/state/router-cursor.json.
trap 'kill 0' EXIT INT TERM
D=${OMODORI_HOME:-$HOME/.omodori}
EVENTS=$D/events/supervisor.ndjson
{
dori watch 2>&1 &
dori dead-panes --loop 3 2>&1 &
dori guard --loop 1 2>&1 &
# redesign S9: freshness only proposes (NO-NUDGE lines); the nudge executor is the supervisor nudge policy (flag-gated)
dori freshness --loop 5 --no-nudge 2>&1 &
# dori-improve 2: LANE_STALLED / LANE_QUOTA / LANE_QUOTA_ALL / LANE_QUOTA_RESET (proposals only; S9 moved the executor to the supervisor)
bun $D/lane-health.ts --loop 2 --stall-min 20 2>&1 &
# dori-improve 3: MONITOR_MISSING / MONITOR_PENDING / MONITOR_EXPIRING (day 6 of 7) / MONITOR_DRIFT, from ~/.omodori/monitors.json
bun $D/monitors-check.ts --loop 30 2>&1 &
# dori-improve 4/5: PROMISE_DUE (timed promises in bot messages) + request ledger upkeep (~/.omodori/ledger.json)
bun $D/ledger.ts sweep --loop 2 2>&1 &
# dori-improve 6: KAKAO_STALL live|push / KAKAO_STALL_RECOVERED (busy-hour aware, 30 min floor)
bun $D/kakao-stall.ts --loop 5 2>&1 &
# dori-improve 2: LANE_REAP_TAB / LANE_HOLD_EXPIRED / LANE_LEFTOVER / LANE_EMPTY_TAB / LANE_REAPER_ERROR (proposal only, never --apply)
bun $D/lane-reaper.ts --loop 10 2>&1 &
# dori-improve 2: DAILY_REVIEW <date> open=<n> path=<file> (once per KST day after 23:30)
bun $D/daily-review.ts --loop 30 2>&1 &
# redesign S3: registry reconciler (DRIFT / REGISTRY_RECONCILED / REGISTRY_ERROR / UNCONFIRMED, each once per change)
bun $D/registry-sync.ts --write --loop 1 2>&1 &
# dori-improve 2: RELEASE_WATCH omo=<installed>-><latest> high=<n> critical=<n> (only on change)
bun $D/release-watch.ts --loop 60 2>&1 &
# redesign S4 supervisor events, replayed from line 1 on every start; the router skips what its checkpoint already routed
tail -n +1 -F "$EVENTS" 2>/dev/null &
wait
} | bun $D/event-router.ts --events "$EVENTS"
# the router ended (crash or EOF): exit so the EXIT trap stops every sweep and the lead's monitor reports the exit
exit
