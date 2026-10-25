#!/bin/bash
# Installs the Dori core (this folder) into $OMODORI_HOME (default ~/.omodori) on a Mac. No messenger source is
# connected here: after the install, `omodori onboard` connects one (`omodori sources` lists them).
#   ./install.sh                 dry run (default): checks everything, renders the core LaunchAgents to a temp dir, changes nothing
#   ./install.sh --apply         copy code, create config/data files from examples, bun install, write + load the core LaunchAgents,
#                                link the `omodori` command into ~/.local/bin
#   ./install.sh --apply --no-load   same, but leave the LaunchAgents unloaded
# Last line is INSTALL_OK, INSTALL_DRY_RUN_OK or INSTALL_FAILED <reason>.
set -u
SRC=$(cd "$(dirname "$0")" && pwd)
OMODORI_HOME=${OMODORI_HOME:-$HOME/.omodori}
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
say "OMODORI_HOME $OMODORI_HOME"
say "mode        $([ $APPLY -eq 1 ] && echo apply || echo dry-run)"

missing=()
for bin in bun omo herdr sqlite3 jq plutil launchctl; do
  if p=$(command -v "$bin"); then say "ok   $bin $p"; else say "MISSING $bin"; missing+=("$bin"); fi
done
[ ${#missing[@]} -eq 0 ] || fail "missing: ${missing[*]} (see docs/PORTING.md)"
BUN=$(command -v bun)

if [ "$SRC" != "$OMODORI_HOME" ]; then
  run mkdir -p "$OMODORI_HOME"
  run rsync -a --exclude .git --exclude node_modules "$SRC/" "$OMODORI_HOME/"
fi

CONFIG="$OMODORI_HOME/config.json"
if [ -f "$CONFIG" ]; then CHECK="$CONFIG"; else
  say "config      $CONFIG missing -> created from examples/config.example.json (core only, sources: [])"
  run cp "$SRC/examples/config.example.json" "$CONFIG"
  CHECK="$SRC/examples/config.example.json"
fi
jq empty "$CHECK" 2>/dev/null || fail "config is not valid JSON: $CHECK"
DORI_PORTABLE_CONFIG="$CHECK" "$BUN" "$SRC/core/config.ts" --check || fail "config check failed: $CHECK"
for f in channels.json seo-sites.json repo-patrol.json; do
  jq empty "$SRC/examples/$f" || fail "examples/$f is not valid JSON"
  if [ -f "$OMODORI_HOME/$f" ]; then say "ok   $f"; else say "data        $f missing -> created from examples/$f"; run cp "$SRC/examples/$f" "$OMODORI_HOME/$f"; fi
done

if [ $APPLY -eq 1 ]; then (cd "$OMODORI_HOME" && "$BUN" install --frozen-lockfile) || fail "bun install"; else say "  would run: (cd $OMODORI_HOME && bun install --frozen-lockfile)"; fi

SHIM="$OMODORI_HOME/omo-extensions/dori-guard.ts"
if [ $APPLY -eq 1 ]; then mkdir -p "$(dirname "$SHIM")" && sed "s#__OMODORI_HOME__#$OMODORI_HOME#" "$SRC/omo-extensions/dori-guard.shim.txt" > "$SHIM"; fi
say "omo ext     $SHIM (copy or link it into your omo extensions folder to enable dori-guard)"

CLI="$HOME/.local/bin/omodori"
if [ $APPLY -eq 1 ]; then
  mkdir -p "$(dirname "$CLI")" && printf '#!/bin/bash\nexport OMODORI_HOME=%q\nexec %q %q "$@"\n' "$OMODORI_HOME" "$BUN" "$OMODORI_HOME/core/cli.ts" > "$CLI" && chmod +x "$CLI" || fail "cannot write $CLI"
fi
say "command     $CLI -> $OMODORI_HOME/core/cli.ts"

if [ $APPLY -eq 1 ]; then OUT="$HOME/Library/LaunchAgents"; else OUT=$(mktemp -d "${TMPDIR:-/tmp}/dori-plists.XXXXXX"); fi
LOGDIR=$(DORI_PORTABLE_CONFIG="$CHECK" "$BUN" -e "import { logDir } from '$SRC/core/config.ts'; console.log(logDir())") || fail "cannot read paths.logDir"
say "logs        $LOGDIR"
RENDERED=$(OMODORI_HOME="$OMODORI_HOME" DORI_PORTABLE_CONFIG="$CHECK" "$BUN" "$SRC/core/launchagents/render.ts" --only core --out "$OUT" --bun "$BUN" --config "$CONFIG") || { echo "$RENDERED"; fail "render"; }
echo "$RENDERED"
while read -r _ label file logs; do
  [ -n "${label:-}" ] || continue
  plutil -lint -s "$file" || fail "plist lint $file"
  if [ $APPLY -eq 1 ]; then mkdir -p "$logs" "$LOGDIR/supervisor" || fail "cannot create $logs"; fi
  if [ $APPLY -eq 1 ] && [ $LOAD -eq 1 ]; then
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$file" || fail "launchctl bootstrap $label"
    say "loaded      $label"
  else
    say "  would run: launchctl bootstrap gui/\$(id -u) $HOME/Library/LaunchAgents/$label.plist"
  fi
done <<< "$(grep '^RENDERED ' <<< "$RENDERED")"

say "next        connect a messenger source: omodori onboard   (list: omodori sources)"
if [ $APPLY -eq 1 ]; then say "INSTALL_OK"; else say "plists     rendered to $OUT (not installed)"; say "INSTALL_DRY_RUN_OK"; fi
