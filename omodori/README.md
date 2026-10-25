# omodori: the always-on runtime for a Dori

This folder is the runtime one Dori runs on a Mac, next to the `dori` CLI in `skills/dori-mode`. It has two parts:

- `core/`: the same on every machine. Lane supervisor over omo RPC (`dori-supervisor.ts`, `rpc.ts`, `deliver.ts`), event
  router to the lead (`event-router.ts`), opening, closing and handing over lanes (`sess.ts`, `lane-transition.ts`), guards,
  heartbeat, host watch, request/promise ledger, decision inbox, the lead's Discord ops channel, and the source contract
  (`sources.ts`, `source-queue.ts`, `onboard.ts`). `config.ts` reads every per-machine value from `$OMODORI_HOME/config.json`.
- `sources/<name>/`: messenger sources (chat rooms differ per machine). Each one plugs into core through one contract:
  `manifest.json` (settings, credentials, data files, LaunchAgents, health check) and `source.ts` (inbound -> common
  queue event, outbound send, optional heartbeat and lane-transition hooks). Core reads only config.json `sources[]`
  and the manifests; it never names a source. Shipped: `kakao` (KakaoTalk live stream, per-room lanes, delivery queue)
  and `discord` (owner messages via the bot gateway).

Order on a new Mac: install the core, then connect sources. Details (Korean): [`docs/PORTING.md`](docs/PORTING.md).

```sh
cd omodori
./install.sh                 # dry run, changes nothing
./install.sh --apply         # core only: copy to ~/.omodori, config + data files from examples/, bun install, core LaunchAgents, `omodori` command
omodori sources              # which sources exist, which are connected
omodori onboard kakao --dry-run   # what connecting it would write: config entry, data files, its LaunchAgents
omodori onboard kakao        # asks for the settings, rooms and bot, checks config, loads only that source's LaunchAgents, runs its health check
omodori offboard kakao       # unload + remove its LaunchAgents, drop it from config.json (data files stay)
```

Tests: `bun test` (runs against `examples/config.example.json` plus every source's `examples/config.fragment.json`; all
ids are fake). `OMODORI_TEST_SOURCES=none bun test core` runs the core alone, with no source connected.
Pre-publication checks: [`docs/SECURITY-CHECK.md`](docs/SECURITY-CHECK.md).

Adding a source: make `sources/<name>/manifest.json` and `source.ts` (see the types at the top of `core/sources.ts`, and
`core/tests/source-contract.test.ts` for a complete fake source). Nothing in `core/` changes.
