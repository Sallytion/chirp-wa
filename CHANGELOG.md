# Changelog

## 0.1.0 — Initial release (unreleased)

- Introduce Chirp for WhatsApp, published as `chirp-wa` with the `chirp` command.
- Provide QR and phone pairing, independent profiles, and automatic reconnects.
- Add a keyboard-driven terminal interface with Chats and Channels pages, local history, search, and saved text drafts.
- Support messages, replies, reactions, edits, forwarding, attachments, group management, and poll creation.
- Include terminal image previews, clipboard attachments, emoji completion, and Unicode-aware editing.
- Keep account archives and logout recovery local to each profile.
- Ship a production bundle with bounded caches and on-demand protocol and image processing.
- Search history with a trigram full-text index; results load in pages as you scroll.
- Vote in polls, decrypt received votes, and show live tallies with your own choice marked.
- Show the quoted sender and text on replies, complete @ mentions in groups, and render mentions as names.
- Mute chats for 8 hours, 1 week, or always, with a sidebar marker; unmuting on the phone now syncs.
- Pause automatic read receipts while the terminal is unfocused, and make typing indicators optional.
- Preview images with the kitty graphics protocol in kitty and Ghostty, falling back to colored blocks.
- Show shared contact cards as names, numbers, and emails; open web links from messages.
- Add `/cache` and `chirp cache` to inspect or clear downloaded media.
- Refuse to open executable or script attachments externally, and strip bidi overrides from untrusted text.
- Write downloads atomically with a byte limit, delete sent or discarded clipboard images, and keep the newest status notice visible.
- Accept apostrophes in slash command arguments and stop printing Node's SQLite experimental warning.

This is the first Chirp release. Development snapshots are not published releases.
