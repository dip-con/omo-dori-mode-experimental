# Lane profiles (redesign S8)

One JSON file per profile; `lane-transition.ts <key> --fresh --profile <name>` builds the omo argv from it and adds the
requested account (`--claude-account`) or model on top. Profile choice: `--profile` > registry `profile` > a file named
after the lane key > `default`.

Fields: `ext[]` (-e paths; `~` = $HOME, `{home}` = the data folder: paths.dataDir / OMODORI_HOME, `{install}` = the folder with the code), `tools` (--tools allowlist or null),
`model`/`thinking` or `modelFile`/`thinkingFile` (+ `modelDefault`/`thinkingDefault`), `noClaim` (no done-claim rule, no
dori lane record), `briefPath` (the standing brief), `label`/`cwd`/`thread` (used only when the lane is not in the registry
yet), `checkpointOnReset` (false: a --reason reset handoff carries the brief and carried requests, not recent conversation),
`busyFiles` (written in the last 2 min = not settled), `beforeClose` (argv lists run after the settled wait, before the old
session closes).

Shipped: `default` (any lane) and two examples matching the fictional bots in examples/config.example.json:
`kakao-chat` (모모, chat bot: KakaoTalk tools + web search, model/thinking read from files) and `kakao-docs` (루루, document
bot: adds the file tools). Copy one to `<lane key>.json` for your own lanes.
