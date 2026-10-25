# omodori: Discord + KakaoTalk runtime for a Dori

This folder is the always-on runtime one Dori runs on a Mac, next to the `dori` CLI in `skills/dori-mode`:

- `listener.ts`, `buttons.ts`, `oc.ts`, `mkthread.ts`: the Discord bot (inbound messages, buttons, threads, voice notes)
- `dori-supervisor.ts`, `rpc.ts`, `registry.ts`, `lane-*.ts`, `sess.ts`: lane supervision over omo RPC, the lane registry, quota-aware lane transitions
- `kakao-loco.ts`, `kakao-push.ts`, `kakao-queue.ts`, `kakao-lane-ext.ts`: KakaoTalk live stream, per-room batching into lanes, the lane's Kakao tools
- `decision.ts`, `heartbeat.ts`, `ceo-weekly.ts`, `repo-patrol.ts`, `ledger.ts`, `event-router.ts`: decision inbox, self-heal checks, weekly brief, repo patrol, promise/request ledger, event routing to the lead
- `config.ts`: every per-machine value (Discord ids, Kakao rooms, launchd labels, accounts, disks) read from `$OMOCAT_HOME/config.json`

Install on a new Mac: [`docs/PORTING.md`](docs/PORTING.md) (Korean). Short version:

```sh
cd omodori
./install.sh             # dry run, changes nothing
./install.sh --apply     # copy to ~/.omocat, create config + data files from examples/, bun install, load LaunchAgents
```

Tests: `bun test` (runs against `examples/config.example.json`; all ids in it are fake).
Pre-publication checks: [`docs/SECURITY-CHECK.md`](docs/SECURITY-CHECK.md).
