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

Messages use `(jid, id, from_me)` as their identity. Each record includes display fields and the original SDK payload. Ingestion merges duplicate echoes and preserves receipt, reaction, bookmark, and edit state. Background security events remain hidden records and do not affect the inbox, unread counts, or visible history.

Phone and LID aliases merge conversations. Saved contact names outrank verified business names, which outrank profile names. Receipt state advances monotonically; individual group participant receipts remain distinct from aggregate message status.

## Interface

`src/ui/App.tsx` owns focus, page selections, dialogs, the composer, replies, and image drafts. Store and client subscriptions trigger updates. Memoized history and transcript data depend on database revisions so editor and presence updates do not decode history again.

The main conversation loads a 60-message page. Text drafts persist across restarts; unsent clipboard image drafts only retain their chat association during the current session. Channels have a separate browsing page and no composer.

`src/ui/input.ts` preserves grapheme boundaries during editing. `src/ui/width.ts` measures Indic terminal cells, and the production build applies that calculation to Ink and wrapping dependencies.

## Media and accounts

Downloads are authenticated, cached on disk, and bounded by size checks. Sharp loads on demand for clipboard conversion and RGB half-block previews. View-once attachments direct users to official WhatsApp.

`src/accounts.ts` backs up SQLite and archives account files before clearing active data. A reset marker supports recovery after interrupted account switching. New profiles use the `chirp` data directory; `CHIRP_HOME` and `--data-dir` override it.
