# KakaoTalk source (`sources/kakao`)

Connects KakaoTalk rooms to lanes. Connect it after the core install with `omodori onboard kakao` (`--dry-run` first);
disconnect with `omodori offboard kakao`. Everything core knows about it is in `manifest.json`.

- `kakao-loco.ts` (LaunchAgent `kakao-live`): live stream over KakaoTalk's own protocol (agent-messenger, tablet
  sub-device of the bot account) -> `{logDir}/kakao/live.ndjson`, plus a local API (`/send`, `/photo`, `/file`, ...)
- `kakao-push.ts` (`kakao-push`): batches each room's lines into its lane through its own delivery queue
  (`kakao-queue.ts`, receipts, wake filter, secretary gate)
- `kakao-health.sh` (`kakao-health`, every 60 s): stall checks and restarts; `kakao-stall.ts` is the lead monitor
- `wake-filter-stats.ts` (`wake-filter-stats`, optional): daily wake-filter report
- `source.ts`: the contract module (inbound, send, heartbeat hook, lane-transition hook); `settings.ts` reads
  config.json `sources[{ name: "kakao", settings }]`
- `event-rules.json`: its event-router rules; `examples/`: room list, brief, config fragment

Settings (manifest.json `settings`): `healthChatId` (required), `botUserId`, `ownerRoom`, `ragChatIds`, `locoPort`,
`archiveRoot`, `archiveSyncLabel`, `requestsLedger`, `generatedImagesDir`, `docOutDir`, `issueRefRooms`. Room list:
`$OMODORI_HOME/kakao-rooms.json` (onboarding creates it; per-room switches are listed in `docs/PORTING.md`).

## Lane profiles

`lane-profiles/` holds two examples matching the fictional bots in `examples/config.fragment.json`:
`kakao-chat` (모모, chat bot: KakaoTalk tools + web search, model/thinking read from files) and `kakao-docs` (루루,
document bot: adds the file tools). Both load `kakao-lane-ext.ts` (the lane's KakaoTalk tools) and have no done-claim
rule. Copy one to `<lane key>.json` for your own lanes, and keep the lane names in step with `kakao-rooms.json`.
