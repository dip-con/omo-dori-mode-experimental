#!/bin/bash
# Hourly sync of this runtime folder to its git remote (LaunchAgent <launchd.prefix>.git-sync, opt-in).
# .gitignore keeps secrets and runtime data out; a staged diff that looks like a secret is never committed.
# Identity and the optional memory repo come from config.json (git.name, git.email, paths.memoryRepo, git.memoryRemote).
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
set -u
D=${OMODORI_HOME:-$HOME/.omodori}
CFG=${DORI_PORTABLE_CONFIG:-$D/config.json}
NAME=$(jq -r '.git.name // ""' "$CFG")
EMAIL=$(jq -r '.git.email // ""' "$CFG")
M=$(jq -r '.paths.memoryRepo // ""' "$CFG")
MREMOTE=$(jq -r '.git.memoryRemote // ""' "$CFG")
[ -n "$NAME" ] && [ -n "$EMAIL" ] || { echo "$(date) git.name / git.email not set in $CFG"; exit 2; }
cd "$D" || exit 1
git add -A
if ! git diff --cached --quiet; then
  if git diff --cached -U0 | grep -Eq '(glpat-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|xox[abp]-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)'; then
    git reset -q; echo "$(date) SECRET-LIKE CONTENT, not committed"; exit 2
  fi
  git -c user.name="$NAME" -c user.email="$EMAIL" commit -q -m "sync $(date '+%Y-%m-%d %H:%M')"
fi
git push -q origin HEAD 2>&1 | tail -2
if [ -n "$M" ] && [ -n "$MREMOTE" ]; then git -C "$M" push -q "$MREMOTE" HEAD:main 2>&1 | tail -2; fi
echo "$(date) ok $(git log -1 --format=%h)"
