# Lane transition fixtures (S8)

- `old-session.jsonl`: an old-session transcript for the inventory step. Expected: `d-processed`, `h-user` (herdr-typed,
  tagged user message) and `kakao:1:1` are processed (a successful assistant entry follows); `d-error` (only an error
  assistant entry after it) and `d-none` (nothing after it) are carried.
