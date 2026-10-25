#!/bin/bash
# KakaoTalk bot health check (LaunchAgent com.example.dori.kakao-health, every 60 s).
# Tells the lead only when the state changes: a stall in kakao-loco (live stream) / kakao-push, then recovery.
# redesign S9: the lead is told through the event router (a kakao.* event appended to ~/.omodori/events/supervisor.ndjson:
# kakao.health_problem = DORI_ASK, kakao.recovered = digest), never by typing into the lead pane.
export PATH=$HOME/.local/bin:$HOME/.bun/bin:$HOME/.local/node-current/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
CFG=${DORI_PORTABLE_CONFIG:-${OMODORI_HOME:-$HOME/.omodori}/config.json}
PREFIX=$(jq -r '.launchd.prefix // "com.example.dori"' "$CFG" 2>/dev/null || echo com.example.dori)
PORT=$(jq -r '.kakao.locoPort // 8397' "$CFG" 2>/dev/null || echo 8397)
export CHAT=$(jq -r '.kakao.healthChatId // ""' "$CFG" 2>/dev/null)
[ -n "$CHAT" ] || { echo "$(date) kakao.healthChatId not set in $CFG, skipping"; exit 0; }
LOGDIR=$(jq -r '.paths.logDir // empty' "$CFG" 2>/dev/null); LOGDIR=${LOGDIR:-$HOME/Library/Logs/omodori}; LOGDIR=${LOGDIR/#\~/$HOME}
L=${OMODORI_KAKAO_LOGS:-$LOGDIR/kakao}
DATA=$(jq -r '.paths.dataDir // empty' "$CFG" 2>/dev/null); DATA=${OMODORI_HOME:-${DATA:-$HOME/.omodori}}; DATA=${DATA/#\~/$HOME}
STATE=$L/health.state
now=$(date +%s)
problem=""
if launchctl print "gui/$(id -u)/$PREFIX.kakao-live" 2>/dev/null | grep -q "state = running"; then
  echo 0 > "$L/health.down-runs"
else
  problem="실시간 읽기 서비스 멈춤"
  # 2026-10-25 19:41: an auto restart stalled in startup for 6 min and nothing retried it. Kick it again after 3 checks.
  down=$(( $(cat "$L/health.down-runs" 2>/dev/null || echo 0) + 1 ))
  echo "$down" > "$L/health.down-runs"
  if [ "$down" -ge 3 ]; then echo 0 > "$L/health.down-runs"; problem="실시간 읽기 서비스 멈춤(3회), 다시 시작"; launchctl kickstart -k "gui/$(id -u)/$PREFIX.kakao-live"; fi
fi
# kakao-token.ts writes auth.state when the token refresh failed: only a manual login helps, so report it and skip the
# stall checks below (their kickstarts would just log in again with the same dead token).
[ -f "$L/auth.state" ] && problem="카톡 재로그인 필요(토큰 갱신 실패: $(head -1 "$L/auth.state" | cut -d' ' -f2- | cut -c1-160)) - agent-kakaotalk auth login"
if [ -z "$problem" ]; then
  msg=$(tail -n 300 "$L/live.ndjson" | python3 -c '
import sys, json, re, datetime, os
last = 0
for line in sys.stdin:
    if not re.search(r"\"chat_id\"\s*:\s*" + os.environ["CHAT"] + r"\b", line): continue
    try: m = json.loads(line)
    except Exception: continue
    if m.get("is_from_me"): continue
    last = int(datetime.datetime.fromisoformat(m["timestamp"].replace("Z", "+00:00")).timestamp())
print(last)')
  push=$(stat -f %m "$L/push.log")
  # Someone else wrote in the room 2+ minutes after kakao-push last logged a delivery: it is stuck.
  if [ $((msg - push)) -gt 120 ] && [ $((now - msg)) -gt 60 ]; then
    problem="새 메시지 전달 멈춤(push), 자동 재시작"
    launchctl kickstart -k "gui/$(id -u)/$PREFIX.kakao-push"
  fi
fi
if [ -z "$problem" ]; then
  # The live stream can stall silently (session alive, no pushes): compare other people's newest message on the
  # server (kakao-loco API) with the newest one the stream wrote, and restart the stream when the server is ahead.
  api=$(curl -s -m 20 "http://127.0.0.1:$PORT/messages?chat=$CHAT&count=10")
  # 2026-10-25 08:00-12:20: the API stayed half-open for 4 h answering slowly or with a non-list body, which reset the
  # miss counter every minute. Only a JSON list within 20 s counts as an answer.
  case "$api" in "["*) ;; *) api="" ;; esac
  # One slow answer is not an outage: under host load spikes (150+) the API missed a 15 s window twice on 10-11
  # and each restart re-logs in to KakaoTalk. Restart only after 3 consecutive misses (about 3 minutes).
  if [ -z "$api" ]; then
    fails=$(( $(cat "$L/health.api-fails" 2>/dev/null || echo 0) + 1 ))
    echo "$fails" > "$L/health.api-fails"
    if [ "$fails" -ge 3 ]; then
      echo 0 > "$L/health.api-fails"
      problem="kakao-loco 응답 없음(3회 연속), 자동 재시작"
      # Keep evidence of the hang before the restart wipes it (2026-10-24: two hangs 14 min apart, cause unknown).
      pid=$(pgrep -f "bun kakao-loco.ts" | head -1)
      if [ -n "$pid" ]; then
        d="$L/hang-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$d"
        { sysctl -n vm.loadavg; ps -o pid,ni,pcpu,pmem,etime,stat -p "$pid"; } > "$d/ps.txt" 2>&1
        lsof -nP -a -p "$pid" -i > "$d/sockets.txt" 2>&1
        sample "$pid" 3 -file "$d/sample.txt" >/dev/null 2>&1
      fi
      launchctl kickstart -k "gui/$(id -u)/$PREFIX.kakao-live"
    else
      exit 0
    fi
  else
    echo 0 > "$L/health.api-fails"
  fi
fi
if [ -z "$problem" ]; then
  db=$(printf '%s' "$api" | python3 -c '
import sys, json, datetime
try:
    m = [x for x in json.load(sys.stdin) if not x["is_from_me"]][0]
    print(int(datetime.datetime.fromisoformat(m["timestamp"].replace("Z", "+00:00")).timestamp()))
except Exception:
    print(0)')
  stream=$(tail -n 300 "$L/live.ndjson" | grep -E "\"chat_id\" *: *$CHAT" | grep '"is_from_me":false' | tail -1 | python3 -c '
import sys, json, datetime
try:
    m = json.loads(sys.stdin.read())
    print(int(datetime.datetime.fromisoformat(m["timestamp"].replace("Z", "+00:00")).timestamp()))
except Exception:
    print(0)')
  handled=$(cat "$L/health.restarted-for" 2>/dev/null || echo 0)
  if [ "$db" -gt 0 ] && [ "$db" -gt "$handled" ] && [ $((db - stream)) -gt 60 ] && [ $((now - db)) -gt 20 ]; then
    echo "$db" > "$L/health.restarted-for"
    problem="실시간 읽기 멈춤(서버보다 $((db - stream))초 뒤처짐), 자동 재시작"
    launchctl kickstart -k "gui/$(id -u)/$PREFIX.kakao-live"
  fi
fi
EVENTS=$DATA/events/supervisor.ndjson
emit() { # kind severity text
  mkdir -p "$(dirname "$EVENTS")"
  jq -nc --arg kind "$1" --arg sev "$2" --arg text "$3" --arg at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" --arg id "$1:$now" \
    '{v: 2, at: $at, id: $id, kind: $kind, severity: $sev, lane: "kakao-health", source: "kakao", data: {text: $text}}' >> "$EVENTS"
}
prev=$(cat "$STATE" 2>/dev/null)
if [ "$problem" != "$prev" ]; then
  printf '%s' "$problem" > "$STATE"
  if [ -n "$problem" ]; then
    emit kakao.health_problem ask "[kakao-health] 장애: $problem"
  elif [ -n "$prev" ]; then
    emit kakao.recovered info "[kakao-health] 복구됨 ($prev)"
  fi
fi
