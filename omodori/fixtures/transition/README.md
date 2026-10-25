# Lane transition fixtures (S8)

- `old-argv.json`: omo argv the pre-S8 restart scripts produced, captured by `capture-old-argv.ts` from the
  `*.bak-20261023-S8` backups with fake bun/herdr/python3/perl/find/sleep (nothing real runs). lane-transition.test.ts checks
  that each one is a subsequence of the argv the matching profile generates (with and without `--account 86`).
- `old-session.jsonl`: an old-session transcript for the inventory step. Expected: `d-processed`, `h-user` (herdr-typed,
  tagged user message) and `kakao:1:1` are processed (a successful assistant entry follows); `d-error` (only an error
  assistant entry after it) and `d-none` (nothing after it) are carried.
