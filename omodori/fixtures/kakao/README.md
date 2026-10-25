Kakao queue fixtures (redesign S7). Synthetic only: no real chat content.
- rooms.json: three rooms; chat ids above 2^53, one pinned room (does not write the legacy active-room file).
- big-ids.ndjson: three complete lines with chat_id/log_id above 2^53 (one is 2^63-1) and a partial last line without a newline.
kakao-push.test.ts builds its other live.ndjson streams in code (crash matrix, split, held context) from these rooms.
