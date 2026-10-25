# Lane profiles (redesign S8, docs/dori-redesign/final.md §2.8)

One JSON file per profile; `lane-transition.ts <key> --fresh --profile <name>` builds the omo argv from it and adds the
requested account (`--claude-account`) or model on top. Profile choice: `--profile` > registry `profile` > a file named
after the lane key > `default`.

Fields: `ext[]` (-e paths, `~` = $HOME, kept as the old scripts wrote them), `tools` (--tools allowlist or null),
`model`/`thinking` or `modelFile`/`thinkingFile` (+ `modelDefault`/`thinkingDefault`), `noClaim` (no done-claim rule, no
dori lane record), `briefPath` (the standing brief), `label`/`cwd`/`thread` (used only when the lane is not in the registry
yet), `checkpointOnReset` (false: a --reason reset handoff carries the brief and carried requests, not recent conversation),
`busyFiles` (written in the last 2 min = not settled), `beforeClose` (argv lists run after the settled wait, before the old
session closes).

The kakao profiles reproduce the pre-S8 restart scripts exactly; fixtures/transition/old-argv.json (captured from the
script backups by fixtures/transition/capture-old-argv.ts) is checked as a subset of the generated argv in lane-transition.test.ts.
