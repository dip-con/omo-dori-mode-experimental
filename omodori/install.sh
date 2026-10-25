#!/bin/bash
# Installs the Dori runtime (this folder) into $OMOCAT_HOME (default ~/.omocat) on a Mac.
#   ./install.sh                 dry run (default): checks everything, renders the LaunchAgents to a temp dir, changes nothing
#   ./install.sh --apply         copy code, create config/data files from examples, bun install, write + load the LaunchAgents
#   ./install.sh --apply --no-load   same, but leave the LaunchAgents unloaded
# Last line is INSTALL_OK, INSTALL_DRY_RUN_OK or INSTALL_FAILED <reason>.
set -u
SRC=$(cd "$(dirname "$0")" && pwd)
OMOCAT_HOME=${OMOCAT_HOME:-$HOME/.omocat}
APPLY=0; LOAD=1
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --no-load) LOAD=0 ;;
    *) echo "unknown option $a" >&2; echo "INSTALL_FAILED usage"; exit 2 ;;
  esac
done
say() { echo "$*"; }
run() { if [ $APPLY -eq 1 ]; then "$@"; else say "  would run: $*"; fi; }
fail() { say "INSTALL_FAILED $1"; exit 1; }

say "source      $SRC"
say "OMOCAT_HOME $OMOCAT_HOME"
say "mode        $([ $APPLY -eq 1 ] && echo apply || echo dry-run)"

missing=()
for bin in bun omo herdr sqlite3 jq plutil launchctl; do
  if p=$(command -v "$bin"); then say "ok   $bin $p"; else say "MISSING $bin"; missing+=("$bin"); fi
done
[ ${#missing[@]} -eq 0 ] || fail "missing: ${missing[*]} (see docs/PORTING.md)"
BUN=$(command -v bun)

if [ "$SRC" != "$OMOCAT_HOME" ]; then
  run mkdir -p "$OMOCAT_HOME"
  run rsync -a --exclude .git --exclude node_modules "$SRC/" "$OMOCAT_HOME/"
fi

CONFIG="$OMOCAT_HOME/config.json"
if [ -f "$CONFIG" ]; then CHECK="$CONFIG"; else
  say "config      $CONFIG missing -> created from examples/config.example.json"
  run cp "$SRC/examples/config.example.json" "$CONFIG"
  CHECK="$SRC/examples/config.example.json"
fi
jq empty "$CHECK" 2>/dev/null || fail "config is not valid JSON: $CHECK"
DORI_PORTABLE_CONFIG="$CHECK" "$BUN" "$SRC/config.ts" --check || fail "config check failed: $CHECK"
for f in channels.json kakao-rooms.json seo-sites.json repo-patrol.json; do
  if [ -f "$OMOCAT_HOME/$f" ]; then say "ok   $f"; else say "data        $f missing -> created from examples/$f"; run cp "$SRC/examples/$f" "$OMOCAT_HOME/$f"; fi
done
for f in channels.json kakao-rooms.json seo-sites.json repo-patrol.json; do jq empty "$SRC/examples/$f" || fail "examples/$f is not valid JSON"; done

if [ $APPLY -eq 1 ]; then (cd "$OMOCAT_HOME" && "$BUN" install --frozen-lockfile) || fail "bun install"; else say "  would run: (cd $OMOCAT_HOME && bun install --frozen-lockfile)"; fi

SHIM="$OMOCAT_HOME/omo-extensions/dori-guard.ts"
if [ $APPLY -eq 1 ]; then mkdir -p "$(dirname "$SHIM")" && sed "s#__OMOCAT_HOME__#$OMOCAT_HOME#" "$SRC/omo-extensions/dori-guard.shim.txt" > "$SHIM"; fi
say "omo ext     $SHIM (copy or link it into your omo extensions folder to enable dori-guard)"

if [ $APPLY -eq 1 ]; then OUT="$HOME/Library/LaunchAgents"; else OUT=$(mktemp -d "${TMPDIR:-/tmp}/dori-plists.XXXXXX"); fi
if [ $APPLY -eq 1 ]; then mkdir -p "$OUT" "$HOME/Library/Logs/dandori-kakao" "$HOME/Library/Logs/dandori-supervisor" || fail "cannot create $OUT"; fi
RENDERED=$(OMOCAT_HOME="$OMOCAT_HOME" DORI_PORTABLE_CONFIG="$CHECK" "$BUN" "$SRC/launchagents/render.ts" --out "$OUT" --bun "$BUN") || { echo "$RENDERED"; fail "render"; }
echo "$RENDERED"
while read -r _ label file; do
  plutil -lint -s "$file" || fail "plist lint $file"
  if [ $APPLY -eq 1 ] && [ $LOAD -eq 1 ]; then
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$file" || fail "launchctl bootstrap $label"
    say "loaded      $label"
  else
    say "  would run: launchctl bootstrap gui/\$(id -u) $HOME/Library/LaunchAgents/$label.plist"
  fi
done <<< "$(grep '^RENDERED ' <<< "$RENDERED")"

if [ $APPLY -eq 1 ]; then say "INSTALL_OK"; else say "plists     rendered to $OUT (not installed)"; say "INSTALL_DRY_RUN_OK"; fi
