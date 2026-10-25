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

Shipped here: `default` (any lane). Example profiles of a messenger source live in that source's folder
(`sources/<name>/lane-profiles/`, named by manifest.json `laneProfiles`) and are searched after this folder once the source
is connected; each source's README describes them. Copy one to `<lane key>.json` for your own lanes.
