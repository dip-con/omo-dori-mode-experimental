# supervisor fixtures (S4)

- rpc-smoke-turn.recorded.ndjson: raw records recorded from the rpc-smoke tui endpoint (2026-10-23T07:42Z) during one ping turn: subscribe_sessions response (snapshot), subscribe response (cursor), get_state before/after (turn_epoch 1 -> 2), and the live stream between. Report text elided.
- child-running.ndjson: derived from the recorded session_status shape: lane running -> worker child (context.parent_session_id = lane) running -> lane idle -> completion -> child idle.
- host-superseded.ndjson: the host_superseded record shape from senpi docs/rpc.md (Supersession lifecycle).
- resync-required.ndjson: the resync_required record shape from senpi docs/rpc.md.
