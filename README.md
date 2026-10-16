# Chirp for WhatsApp

A keyboard-first WhatsApp client for your terminal. Browse conversations, search local history, reply, and preview images without leaving your workspace.

[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Source](https://github.com/Sallytion/chirp-wa) · [Issues](https://github.com/Sallytion/chirp-wa/issues) · [Contributing](CONTRIBUTING.md)

**npm package:** `chirp-wa` · **command:** `chirp` · **initial release:** `0.1.0`

Built with TypeScript, React/Ink, and Baileys. Runs locally in one process with SQLite history.

## Install

Requires **Node.js 24 or newer** and an interactive terminal on Windows, macOS, or Linux.

```sh
npm i -g chirp-wa
chirp
```

> The initial release is prepared locally and has not been published yet. The registry command above will work after publication. To try this checkout now, use the development instructions below.

Explore the interface without linking WhatsApp:

```sh
chirp --demo
```

Prefer a project-local installation? Run `npm i chirp-wa`, then `npx chirp`. Global installation makes the bare `chirp` command available across terminals.

## Link WhatsApp

Start `chirp`, then scan the terminal QR with **WhatsApp → Linked devices → Link a device**. Press **P** to use phone-number pairing or **Q** to return to QR.

Chirp saves the linked session locally and reconnects on subsequent launches. QR codes are displayed only when the complete code fits the terminal; otherwise, enlarge the terminal or use phone pairing.

```sh
chirp --phone +919876543210
chirp --profile work
chirp --offline
chirp doctor
chirp cache --clear
```

Profiles keep independent authentication, history, preferences, drafts, and media. Only one process can open a profile at a time. Offline mode browses cached data without connecting.

## Features

- **Conversations:** direct chats and groups, unread navigation, archive/pin actions, muting for 8 hours, 1 week, or always (marked ⊘ in the sidebar), and a separate channel browsing page.
- **Messaging:** text, replies that show the quoted sender and text, @ mention completion in groups, reactions, edits, deletion of your own messages, and forwarding.
- **Local history:** SQLite persistence, chronological pagination, fast full-text search with paged results, JSON exports, saved text drafts, and local bookmarks.
- **Attachments:** images, video, audio, documents, stickers, clipboard images, captions, authenticated downloads, readable shared contact cards, opening web links from messages, and terminal image previews (kitty graphics protocol where supported, colored blocks elsewhere).
- **Groups and polls:** group creation and participant management, invite links, disappearing-message settings, poll creation, voting, and live vote totals.
- **Keyboard workflow:** fixed composer, action menus, search dialogs, emoji and mention autocomplete, grapheme-safe editing, and light/dark themes.
- **Privacy and status:** automatic read receipts pause while the terminal is in the background, optional typing indicators, background sync progress, typing/recording indicators, receipt details, and an optional terminal notification bell.

A wide terminal shows a sidebar; compact terminals use the chat switcher. True-color support improves block image previews; kitty and Ghostty show full-resolution previews.

## Keyboard guide

| Shortcut           | Action                                                    |
| ------------------ | --------------------------------------------------------- |
| Ctrl+K             | Find or switch a conversation                             |
| Ctrl+N             | Switch Chats / Channels                                   |
| Tab / Shift+Tab    | Move focus between panels                                 |
| Ctrl+F             | Search the current conversation                           |
| Ctrl+G             | Open the action menu                                      |
| ↑ / ↓              | Navigate lists or select messages                         |
| PageUp / PageDown  | Browse cached history                                     |
| Ctrl+R             | Reply to the selected message                             |
| Ctrl+T             | Attach a file                                             |
| Ctrl+V             | Paste text or attach a clipboard image                    |
| Ctrl+P             | Preview selected media or an image draft                  |
| L / V              | Open a link / vote in a poll (selected message)           |
| Enter              | Send from the composer                                    |
| Alt+Enter / Ctrl+J | Insert a newline                                          |
| Ctrl+W             | Delete the previous word                                  |
| Ctrl+← / Ctrl+→    | Move by word                                              |
| Ctrl+A / Ctrl+E    | Move to the start / end                                   |
| Esc                | Close a dialog, cancel a reply, or discard an image draft |
| Ctrl+Q / Ctrl+C    | Quit and save text drafts                                 |

Type `:smile`, `:heart`, or another shortcode for emoji suggestions. In groups, type `@` and part of a name for mention suggestions; the mention is inserted as `@number` and shown as the contact's name once sent. Use ↑ / ↓ to select and Tab / Enter to insert; press Enter again to send. Clipboard images attach without sending automatically.

Use the **Control** key on macOS. Terminals may intercept Ctrl+V or some Alt/Option shortcuts; the action menu provides equivalent flows. Channels are read-only and retain their navigation separately from Chats. Text drafts persist across restarts; unsent clipboard image drafts do not.

Slash commands are optional. `/help` lists the full reference; `//text` sends a message starting with a literal slash.

```text
/open +919876543210
/search meeting
/sync-contacts
/history
/attach "path/to/photo.jpg" "From today"
/react 💚
/poll "Dinner?" "Pizza" "Pasta"
/vote 2
/mute 8h
/links
/group info
/receipts off
/typing off
/images kitty
/cache clear
/export "conversation.json"
```

## Clipboard and media

Desktop clipboard access uses the optional [CrossCopy backend](https://github.com/CrossCopy/clipboard). On Linux Wayland, install `wl-clipboard`; the X11 fallback uses `xclip`. If clipboard support is unavailable, use Ctrl+T to attach a file. Remote sessions need access to their own desktop clipboard.

Clipboard images are limited to 32 MB and 40 million pixels. Attachment uploads and downloads are limited to 100 MB. Images and stickers render in the terminal; other media can open in your system viewer. Chirp refuses to open executables and scripts (for example `.exe`, `.js`, `.sh`) with the system handler; save them with `/download` instead. Voice notes require an existing Ogg/Opus file. Protected view-once media opens through official WhatsApp.

Image previews use the kitty graphics protocol (Unicode placeholders) in kitty and Ghostty, and colored half-blocks elsewhere, including inside tmux or screen. Choose with `/images auto|kitty|blocks` or in Preferences.

Downloaded media is cached in the profile so previews open instantly. `/cache` shows its size and `/cache clear` removes it; while Chirp is closed, use `chirp cache` and `chirp cache --clear`. Attachments download again when opened. Pasted clipboard images are deleted after they are sent or discarded.

## Local data

Chirp stores profiles under:

| Platform      | Data root                                           |
| ------------- | --------------------------------------------------- |
| Windows       | `%LOCALAPPDATA%\chirp\`                             |
| macOS / Linux | `$XDG_DATA_HOME/chirp/`, or `~/.local/share/chirp/` |

Override the root with `CHIRP_HOME` or `--data-dir <path>`. Each profile contains authentication files, `history.sqlite`, downloaded media, settings, and a connection log.

Credentials and history are **not encrypted at rest**. Keep profile files private. Incoming terminal control sequences are stripped, and background security events are excluded from visible conversations and unread counts.

Choose **Ctrl+G → Log out / link another account** to unlink the device and archive that account's local history, contacts, drafts, authentication, and media. Separate profiles let you keep multiple accounts available.

```sh
chirp --profile personal
chirp --profile work
```

For a broken local session while Chirp is closed, `chirp logout --yes` archives the account locally and prepares a fresh login. It does not contact WhatsApp; revoke the old linked device on your phone when needed.

## Limitations

- WhatsApp controls which historical messages and media a linked device receives. Search and export use cached data; a complete lifetime archive is not guaranteed.
- Receipt visibility depends on WhatsApp events and privacy settings. Disabling automatic receipts here changes Chirp's behavior, not account-wide privacy settings.
- Channels display locally synced updates. Publishing, following/unfollowing, channel reactions, and full channel archive retrieval are not implemented.
- Calls, microphone recording, built-in video/audio playback, status stories, business catalogs, desktop notifications, and WhatsApp-synced stars are not implemented. Bookmarks are local.
- Poll votes use the same encryption Baileys uses to decrypt them and follow the poll's phone-number or LID addressing. They have not yet been tested against the official WhatsApp apps.
- Read receipts pause in the background only in terminals that report focus changes (most modern terminals); elsewhere Chirp assumes the window is focused.
- Baileys is an unofficial client library pinned to `7.0.0-rc14`. WhatsApp protocol changes can affect compatibility. Chirp is not affiliated with WhatsApp or Meta.

## Development

```sh
npm ci
npm run dev -- --demo
```

Build and install this checkout globally:

```sh
npm run build
npm i -g .
chirp
```

Run the checks:

```sh
npm run verify
npm run build
npm run check:package
```

See [Contributing](CONTRIBUTING.md), [Architecture](docs/architecture.md), [Performance](docs/performance.md), and [Releasing](docs/releasing.md). Production optimizations are checked against pinned dependencies; source development runs do not use every build adaptation.

`npm pack` creates the single current release artifact, `chirp-wa-0.1.0.tgz`. Install it on another machine with `npm i -g ./chirp-wa-0.1.0.tgz`.

## License

[MIT](LICENSE). Bundled third-party license notices ship with the package.
