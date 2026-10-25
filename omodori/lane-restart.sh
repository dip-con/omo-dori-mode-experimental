#!/bin/bash
# The one way to restart an OMO lane without losing its conversation (notes/facts/omo-update-lane-restart-2026-10-16).
#   lane-restart.sh <lane-key>          dry run: checks + prints the exact relaunch command, changes nothing
#   lane-restart.sh <lane-key> --live   /quit -> relaunch `omo ... --session <jsonl>` -> real verification turn
#   --force                             (humans only) proceed when children are unknown, as long as the lane is idle
# Refuses (exit 4) unless the supervisor snapshot says the lane is settled (final.md §2.5): children_unknown when child work
# cannot be observed, children_running while subagents/DAG runs are live, not_settled otherwise. Never replays the raw bun/cli.js argv
# (that loses auth: agent dir falls back to ~/.senpi/agent). Last output line is the one-line result.
export PATH=$HOME/.local/bin:$HOME/.bun/bin:$HOME/.local/node-current/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -u
KEY=${1:?usage: lane-restart.sh <lane-key> [--live] [--force]}
LIVE=0; FORCE=0
for a in "${@:2}"; do case "$a" in --live) LIVE=1 ;; --force) FORCE=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done
D=${OMOCAT_HOME:-$HOME/.omocat}
export D
LOG=$D/heartbeat/lane-restart.log
mkdir -p "$D/heartbeat"
log() { echo "$(date '+%F %T') $KEY $*" >> "$LOG"; echo "$*"; }
fail() { log "FAIL: $1"; exit "${2:-1}"; }

IFS=$'\t' read -r PANE CWD SID < <(python3 - "$KEY" <<'PY'
import json, sys, os
m = json.load(open(os.path.join(os.environ['D'], 'sessions-map.json')))
e = m.get(sys.argv[1])
print('\t'.join([e['pane'], e['cwd'], e['sessionId']]) if e and e['status'] == 'open' else '-\t-\t-')
PY
)
[ -z "$PANE" ] || [ "$PANE" = "-" ] && fail "no open lane '$KEY' in sessions-map" 2

# Fail closed: an unreadable status, unknown children or any running child means "do not touch". Checked again right before /quit.
guard() {
  read -r STATUS CSTATE RUNNING SETTLED REASONS < <(bun "$D/rpc.ts" status "$KEY" --json 2>/dev/null | python3 -c "
import json,sys
try: s=json.load(sys.stdin); c=s['children']
except Exception: print('unknown unknown 0 false status_unreadable'); sys.exit()
print(s.get('status') or 'unknown', c.get('state') or 'unknown', int(c.get('running') or 0), 'true' if s.get('settled') else 'false', ','.join(c.get('reasons') or []) or '-')")
  if [ "$CSTATE" != known ]; then
    [ $FORCE -eq 1 ] || fail "children_unknown ($REASONS) for $KEY (pane $PANE): not touching it" 4
    [ "$STATUS" = idle ] || fail "lane status '$STATUS' (pane $PANE): not touching it even with --force" 4
    log "FORCE: children_unknown ($REASONS), lane idle"
    return 0
  fi
  [ "$RUNNING" = 0 ] || fail "children_running ($RUNNING) for $KEY (pane $PANE): wait" 4
  [ "$SETTLED" = true ] || fail "not_settled: lane status '$STATUS' (pane $PANE): not touching it" 4
  return 0
}
guard

# Current argv (agent alive) or the last argv the heartbeat saw (agent already dead).
ARGV_JSON=$(herdr pane process-info --pane "$PANE" 2>/dev/null | python3 -c "
import json,sys
ps=json.load(sys.stdin)['result']['process_info'].get('foreground_processes') or []
cands=[p for p in ps if any(a.endswith('/cli.js') for a in p.get('argv') or [])]
main=[p for p in cands if '--session' in p['argv'] or '--session-id' in p['argv']]
p=min(main or cands,key=lambda p:p['pid']) if cands else None
print(json.dumps(p['argv']) if p else '')")
ALIVE=1
if [ -z "$ARGV_JSON" ]; then
  ALIVE=0
  ARGV_JSON=$(python3 -c "import json,os,sys;print(json.dumps(json.load(open(os.path.join(os.environ['D'], 'heartbeat/lane-argv.json'))).get(sys.argv[1]) or ''))" "$KEY" 2>/dev/null)
  [ -z "$ARGV_JSON" ] || [ "$ARGV_JSON" = '""' ] && fail "no running agent and no saved argv for $KEY (run heartbeat while it is alive, or use sess.ts reopen)" 3
fi

# Build `omo <args after cli.js minus the omo-ai --extension pair>` with --session <jsonl>.
BUILT=$(python3 - "$ARGV_JSON" "$CWD" "$SID" <<'PY'
import json, sys, os, glob, shlex
argv, cwd, sid = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3]
i = next(i for i, a in enumerate(argv) if a.endswith('/cli.js'))
rest, out, j = argv[i + 1:], [], 0
while j < len(rest):
    a = rest[j]
    if a == '--extension' and j + 1 < len(rest) and 'omo-ai' in rest[j + 1]: j += 2; continue
    if a in ('--session-id', '--session'): j += 2; continue
    out.append(a); j += 1
hits = glob.glob(os.path.expanduser(f'~/.omo/agent/sessions/*/*_{sid}.jsonl'))
if not hits: print('NOJSONL'); sys.exit()
print(hits[0] + '\t' + ' '.join(['omo', *map(shlex.quote, out), '--session', shlex.quote(hits[0])]))
PY
)
[ "$BUILT" = "NOJSONL" ] && fail "session jsonl for $SID not found under ~/.omo/agent/sessions" 3
JSONL=${BUILT%%$'\t'*}
CMD=${BUILT#*$'\t'}
# Never /quit a lane without a valid replacement command in hand.
case "$CMD" in "omo "*" --session "*) ;; *) fail "could not build the relaunch command" 3 ;; esac
[ -s "$JSONL" ] || fail "session jsonl $JSONL missing or empty" 3

# herdr reports a pane "idle" during tool calls, so recent session writes also count as busy.
recent_activity() { [ $(( $(date +%s) - $(stat -f %m "$JSONL") )) -lt 120 ]; }
if [ $ALIVE -eq 1 ] && recent_activity; then
  [ $LIVE -eq 1 ] && fail "session written in the last 2 min (pane $PANE): not touching it" 4
  log "DRY_RUN note: session written in the last 2 min, --live would refuse now"
fi

if [ $LIVE -eq 0 ]; then
  log "DRY_RUN pane=$PANE alive=$ALIVE status=$STATUS"
  log "DRY_RUN would: $( [ $ALIVE -eq 1 ] && echo '/quit, ' )run: $CMD"
  exit 0
fi

log "LIVE start pane=$PANE alive=$ALIVE"
if [ $ALIVE -eq 1 ]; then
  guard
  recent_activity && fail "session written in the last 2 min (pane $PANE): not touching it" 4
  herdr pane run "$PANE" /quit >/dev/null 2>&1
  for _ in $(seq 1 30); do
    sleep 1
    herdr pane process-info --pane "$PANE" 2>/dev/null | grep -q '/cli.js' || break
  done
  herdr pane process-info --pane "$PANE" 2>/dev/null | grep -q '/cli.js' && fail "/quit did not exit the agent in 30 s"
fi
herdr pane run "$PANE" "cd $(printf %q "$CWD") && $CMD" >/dev/null 2>&1 || fail "herdr pane run failed"
for _ in $(seq 1 45); do
  sleep 2
  S=$(herdr pane read "$PANE" --source visible --lines 40 2>/dev/null)
  echo "$S" | grep -q 'No project session found' && fail "relaunch opened an EMPTY session (No project session found)"
  herdr pane process-info --pane "$PANE" 2>/dev/null | grep -q '/cli.js' && READY=1 && break
done
[ "${READY:-0}" = 1 ] || fail "agent did not come back in 90 s"
sleep 8
OFFSET=$(stat -f %z "$JSONL")
herdr pane run "$PANE" "[리드·lane-restart] 재시작 인증 확인 턴. 카톡·디스코드·메일 등 바깥으로 아무것도 보내지 말고, 도구도 쓰지 말고, 이 pane에 RESTART_OK 한 단어만 답해." >/dev/null 2>&1
for _ in $(seq 1 60); do
  sleep 3
  NEW=$(tail -c +$((OFFSET + 1)) "$JSONL" 2>/dev/null)
  echo "$NEW" | grep -Eq 'No API key found|authentication_error|invalid x-api-key' && fail "verification turn hit an auth error"
  echo "$NEW" | python3 -c "
import json,sys
for l in sys.stdin:
  try: m=json.loads(l).get('message') or {}
  except Exception: continue
  c=m.get('content'); t=c if isinstance(c,str) else ' '.join(x.get('text','') for x in c or [] if isinstance(x,dict))
  if m.get('role')=='assistant' and 'RESTART_OK' in t: sys.exit(0)
sys.exit(1)" && { log "OK restarted and verified by a real turn ($(du -h "$JSONL" | cut -f1) session)"; exit 0; }
done
fail "no RESTART_OK reply within 180 s (check pane $PANE)"
