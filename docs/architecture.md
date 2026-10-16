# Architecture

Chirp is a single-process Node.js application. React and Ink render its terminal interface; Baileys manages the WhatsApp connection; `node:sqlite` stores local history. There is no browser or separate server.

## Startup and shutdown

`src/cli.tsx` parses options, resolves the profile, acquires a process lock, opens SQLite, finishes interrupted account resets, and mounts the interface. It chooses either `WhatsAppClient` or `DemoClient` through the shared `Client` interface. Offline mode opens cached data without connecting.

Shutdown unmounts the UI, restores the terminal, closes the socket, awaits credential writes, closes the log and database, and releases the profile lock. Demo directories are removed after use.

## Connection and actions

`src/client.ts` owns QR and phone pairing, socket events, bounded reconnect backoff, and remote actions. Stale socket callbacks are ignored. Credential writes are serialized before reconnecting. The browser identity remains consistent across pairing and restoration.

`src/sync.ts` tracks pending notifications and downloaded history independently of applying that history. Contact snapshots are decoded through the SDK without resetting authentication keys.

`src/commands.ts` executes optional slash commands and returns structured UI results. Interactive menus share these actions or call the client interface directly.

## Persistence

`src/store.ts` stores chats, messages, contacts, address aliases, and text drafts. SQLite uses WAL mode, transactions, indexes, and cached prepared statements. Schema upgrades use `PRAGMA user_version`.

Message text is indexed by an external-content FTS5 table with the trigram tokenizer, kept in sync by triggers. Message writes are upserts so row ids stay stable for the index. Queries shorter than three characters fall back to `LIKE`. A `meta` table records one-time work such as the history scan that recovers contact names.

Messages use `(jid, id, from_me)` as their identity. Each record includes display fields and the original SDK payload. Ingestion merges duplicate echoes and preserves receipt, reaction, bookmark, and edit state. Background security events remain hidden records and do not affect the inbox, unread counts, or visible history.

Phone and LID aliases merge conversations. Saved contact names outrank verified business names, which outrank profile names. Receipt state advances monotonically; individual group participant receipts remain distinct from aggregate message status.

Chats store the unmute time in Unix seconds, with -1 for always. WhatsApp mute ends arrive in milliseconds and an explicit `null` unmutes.

Baileys does not decrypt poll votes, so `WhatsAppClient` does: it tries the creator and voter addresses (phone number, LID, and aliases) until AES-GCM authentication succeeds, then stores the vote on the poll. Outgoing votes use the poll's own addressing.

## Interface

`src/ui/App.tsx` owns focus, page selections, dialogs, the composer, replies, and image drafts. Store and client subscriptions trigger updates. Memoized history and transcript data depend on database revisions so editor and presence updates do not decode history again.

The main conversation loads a 60-message page. Text drafts persist across restarts; unsent clipboard image drafts only retain their chat association during the current session. Channels have a separate browsing page and no composer.

`src/ui/input.ts` preserves grapheme boundaries during editing and turns terminal focus reports (DECSET 1004, enabled by the CLI) into focus changes; automatic read receipts wait while the terminal is unfocused. Local and connection notices share the status line, and the most recent wins.

`src/kitty.ts` renders image previews with kitty Unicode placeholders: the PNG is transmitted out of band with a virtual placement, and placeholder characters inside the Ink layout draw it. Other terminals use RGB half-blocks. `src/ui/width.ts` measures Indic terminal cells, and the production build applies that calculation to Ink and wrapping dependencies.

## Media and accounts

Downloads are authenticated, streamed to a temporary file, renamed into the cache, and bounded by the bytes received. Executable and script attachments are never handed to the system opener. Sharp loads on demand for clipboard conversion and RGB half-block previews. View-once attachments direct users to official WhatsApp.

`src/accounts.ts` backs up SQLite and archives account files before clearing active data. A reset marker supports recovery after interrupted account switching. New profiles use the `chirp` data directory; `CHIRP_HOME` and `--data-dir` override it.
