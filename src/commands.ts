import { copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Client, Message, Settings } from './types.js';
import { isMuted } from './types.js';
import type { Store } from './store.js';
import { isChannel, type ChatSection } from './conversations.js';
import { jidFor, linksIn, tokens } from './util.js';
import { pollOf, pollTally } from './messages.js';
import { clearMediaCache, formatBytes, mediaCacheUsage, openExternally } from './media.js';

const muteDurations: Record<string, number> = { h: 3600, d: 86400, w: 604800 };
// "8h", "1w", "always" or "off"; seconds for Client.mute (-1 always, null off).
export function muteDuration(value: string): number | null {
  const text = value.toLowerCase();
  if (text === 'always') return -1;
  if (text === 'off') return null;
  const match = /^(\d{1,4})([hdw])$/.exec(text);
  if (!match || !+match[1]) throw new Error('/mute 8h | 1w | always | off');
  return +match[1] * muteDurations[match[2]];
}

export const HELP = `NAVIGATION · Control shortcuts work on Windows, Linux, and macOS
Ctrl+N          Switch Chats (direct + groups) / Channels
Tab / Shift+Tab  Switch between chats, messages, and composer
↑ / ↓           Navigate chats or messages; ↑ in empty composer selects a message
PageUp / PageDn Browse cached history · Home / End in messages jump to oldest / latest
Ctrl+K          Search / switch chats · Ctrl+F searches this conversation
Alt+U           Jump to next unread chat · Esc returns to composer
Ctrl+P          Preview selected attachment or pasted image
Messages focus  Enter actions · R reply · P preview · L open link · V vote
Ctrl+R          Reply to selected message · Ctrl+T attach a file
Ctrl+V          Paste clipboard image or text (also in the Ctrl+G menu)
Ctrl+G          Actions, bookmarks, receipts, help, and logout
Enter           Send · Alt+Enter or Ctrl+J inserts a newline
:smile          Emoji suggestions · ↑ / ↓ select · Tab / Enter insert · Esc dismiss
@name           Mention suggestions in groups (inserts @number, shown as names)
Backspace / Del Delete previous / next character (including complete emoji)
Ctrl+W          Delete previous word · Ctrl+Backspace / Option+Backspace aliases
Ctrl+Delete     Delete next word · Ctrl+← / → move by word
Ctrl+A / Ctrl+E Start / end of composer · Ctrl+U clear before cursor
Ctrl+Q / Ctrl+C Quit (drafts are saved)

Use Control on macOS. Command belongs to the terminal application.
Legacy Alt/Option shortcuts remain: 1/2 pages, A actions, P preview, R reply,
T attach, O external viewer, I info, S bookmark, U next unread, H help, L logout.
Terminals may intercept Ctrl+V or Ctrl+Backspace; use the action menu / Ctrl+W.

COMMANDS
/open +number                         Start or open a chat
/chats [all|unread|groups|archived]     Change sidebar filter
/channels [all|unread|archived]        Open the separate channels page
/sync-contacts                        Sync WhatsApp contact names
/search text                          Search all cached messages (scroll for more)
/find text                            Search this conversation
/history                              Request older history from your phone
/attach "path" [caption]              Send image, video, audio, or document
/voice "recording.ogg"                Send an existing Ogg/Opus voice note
/preview · /open-media                Preview or open selected media
/download ["destination"]             Cache or copy the selected attachment
/links                                Open a web link from the selected message
/cache [clear]                        Show or clear downloaded media
/reply [message-id] · /cancel          Reply to selection, or cancel reply
/react emoji                          React to selection ("" removes yours)
/edit replacement text                Edit your selected text message
/delete confirm                       Delete your selected message for everyone
/forward +number                      Forward the selected message
/mention +number text                 Send a group mention
/read                                 Mark visible messages read
/info                                 Message delivery details and reactions
/star                                 Toggle a local bookmark
/stars                                Search local bookmarks in this chat
/archive · /pin · /unread              Chat actions (synced to WhatsApp)
/mute [8h|1w|always|off]               Mute this chat (no argument toggles)
/poll "Question" "Option 1" "Option 2" Create a single-choice poll
/vote 2 · /vote 1,3 · /vote clear      Vote in the selected poll
/group info                           Group details and members
/group create "Name" +number […]      Create a group
/group add|remove|promote|demote +num   Manage participants
/group subject|description text       Update group metadata
/group invite                         Show invite link
/group ephemeral seconds              0, 86400, 604800, or 7776000
/group leave confirm                  Leave this group
/settings                             Show preferences
/receipts on|off                       Automatic receipts for visible messages
/notifications on|off                  Terminal bell for incoming messages
/typing on|off                         Send typing indicators
/images auto|kitty|blocks              Image previews (kitty graphics or blocks)
/theme dark|light                      Change palette
/export "path.json"                    Export this cached conversation
/logout confirm                       Unlink and archive this account; Q links another
/help · /quit

Commands act on the selected message, or the newest message if none is selected.
Send a literal slash by starting the text with //.`;

export interface CommandContext {
  store: Store;
  client: Client;
  jid?: string;
  selected?: Message;
  visible: Message[];
  settings: Settings;
  section?: ChatSection;
  // Profile directory and unsent attachment drafts that /cache clear must keep.
  dir?: string;
  keep?: string[];
}
export interface CommandResult {
  notice?: string;
  info?: { title: string; text: string };
  openJid?: string;
  filter?: string;
  section?: ChatSection;
  results?: Message[];
  // A paged search the dialog continues as you scroll.
  search?: { query: string; jid?: string };
  links?: string[];
  reply?: Message;
  cancelReply?: boolean;
  preview?: Message;
  quit?: boolean;
  settings?: Settings;
  resetAccount?: boolean;
}
export async function command(input: string, ctx: CommandContext): Promise<CommandResult> {
  const [name, ...args] = tokens(input);
  const { store, client, settings } = ctx;
  const requireJid = () => {
    if (!ctx.jid) throw new Error('Open a conversation first (Ctrl+K or /open +number).');
    return ctx.jid;
  };
  const selected = () => {
    if (!ctx.selected) throw new Error('Select a message with ↑ / ↓ first.');
    return ctx.selected;
  };
  const argText = () => {
    const value = args.join(' ');
    if (!value.trim()) throw new Error(`${name} requires text.`);
    return value;
  };
  switch (name.toLowerCase()) {
    case '/help':
      return { info: { title: 'Keyboard & command guide', text: HELP } };
    case '/quit':
    case '/exit':
      return { quit: true };
    case '/open': {
      if (!args[0]) throw new Error('/open +number');
      const jid = store.resolve(jidFor(args[0]));
      store.upsertChat({ jid });
      return { openJid: jid };
    }
    case '/chats': {
      const filter = args[0] || 'all';
      if (!['all', 'unread', 'groups', 'archived'].includes(filter))
        throw new Error('Chat filters: all, unread, groups, archived');
      return { filter, section: 'chats' };
    }
    case '/channels': {
      const filter = args[0] || 'all';
      if (!['all', 'unread', 'archived'].includes(filter))
        throw new Error('Channel filters: all, unread, archived');
      return { filter, section: 'channels' };
    }
    case '/sync-contacts':
      return { notice: await client.syncContacts() };
    case '/search':
      return { search: { query: argText() } };
    case '/find':
      return { search: { query: argText(), jid: requireJid() } };
    case '/history':
      await client.history(
        requireJid(),
        store.history(requireJid(), 1, Math.max(0, store.count(requireJid()) - 1))[0],
      );
      return { notice: 'Requested older messages from your phone' };
    case '/attach':
    case '/voice':
      if (!args[0]) throw new Error(`${name} "path" [caption]`);
      await client.sendFile(requireJid(), args[0], args.slice(1).join(' '), name === '/voice');
      return { notice: 'Attachment sent' };
    case '/preview':
      return { preview: selected() };
    case '/open-media':
      await openExternally(await client.download(selected()));
      return { notice: 'Opened in your default application' };
    case '/links': {
      const links = linksIn(selected().text);
      if (!links.length) throw new Error('The selected message has no web links.');
      return { links };
    }
    case '/cache': {
      const dir = ctx.dir;
      if (!dir) throw new Error('No profile directory.');
      if (args[0] === 'clear') {
        const cleared = await clearMediaCache(dir, ctx.keep);
        return {
          notice: `Cleared ${cleared.files} cached files (${formatBytes(cleared.bytes)}). Attachments download again when opened.`,
        };
      }
      if (args[0]) throw new Error('/cache [clear]');
      const usage = await mediaCacheUsage(dir);
      return {
        info: {
          title: 'Media cache',
          text: `${usage.files} files · ${formatBytes(usage.bytes)}\n\nDownloaded attachments are kept so previews open instantly.\n/cache clear removes them; they download again when opened.`,
        },
      };
    }
    case '/download': {
      const path = await client.download(selected());
      if (args[0]) {
        const destination = resolve(args[0]);
        await copyFile(path, destination);
        return { notice: `Saved to ${destination}` };
      }
      return { info: { title: 'Attachment saved', text: path } };
    }
    case '/reply': {
      const m = args[0] ? store.message({ remoteJid: requireJid(), id: args[0] }) : selected();
      if (!m || m.deleted) throw new Error('Message not found or deleted.');
      if (isChannel(m.jid)) throw new Error('Channel updates cannot be replied to here.');
      return { reply: m };
    }
    case '/cancel':
      return { cancelReply: true };
    case '/react':
      if (!args.length) throw new Error('/react emoji (or /react "" to remove)');
      await client.react(selected(), args[0]);
      return { notice: 'Reaction updated' };
    case '/edit':
      await client.edit(selected(), argText());
      return { notice: 'Message edited' };
    case '/delete':
      if (args[0] !== 'confirm')
        throw new Error('Use /delete confirm to delete the selected message for everyone.');
      await client.delete(selected());
      return { notice: 'Message deleted' };
    case '/forward':
      if (!args[0]) throw new Error('/forward +number');
      await client.forward(selected(), jidFor(args[0]));
      return { notice: 'Message forwarded' };
    case '/mention': {
      if (args.length < 2) throw new Error('/mention +number text');
      const jid = requireJid();
      if (!jid.endsWith('@g.us')) throw new Error('Mentions are for group chats.');
      const target = jidFor(args[0]);
      await client.send(jid, `@${target.split('@')[0]} ${args.slice(1).join(' ')}`, undefined, [
        target,
      ]);
      return { notice: 'Mention sent' };
    }
    case '/read':
      await client.read(requireJid(), ctx.visible);
      return { notice: 'Visible messages marked read' };
    case '/info': {
      const m = selected();
      const receipts = Object.entries(m.receipts).map(
        ([user, r]) =>
          `${store.name(user)}: ${r.played ? 'played' : r.read ? 'read' : 'delivered'} at ${new Date((r.played || r.read || r.delivered || 0) * 1000).toLocaleString()}`,
      );
      const poll =
        m.kind === 'poll'
          ? '\n\nPoll results (received votes):\n' +
            pollTally(m.raw)
              .map(
                (o) =>
                  `${o.name}: ${o.voters.length}${o.voters.length ? ` · ${o.voters.map((v) => (v === 'me' ? 'You' : store.name(v))).join(', ')}` : ''}`,
              )
              .join('\n')
          : '';
      return {
        info: {
          title: 'Message info',
          text: `${m.sender} · ${new Date(m.timestamp * 1000).toLocaleString()}\nID: ${m.id}\nType: ${m.kind} · ${m.fromMe ? m.status : m.localRead ? 'read locally' : 'unread locally'}${m.edited ? ' · edited' : ''}\n${m.filename || ''}\n${m.mimetype || ''}\n\n${receipts.length ? receipts.join('\n') : 'No per-recipient receipts received. Privacy settings may suppress receipts.'}\n\nReactions:\n${
            Object.entries(m.reactions)
              .map(([user, emoji]) => `${store.name(user)} ${emoji}`)
              .join('\n') || 'None'
          }${poll}`,
        },
      };
    }
    case '/star': {
      const m = selected();
      store.patch(m.raw.key, { starred: !m.starred });
      return { notice: m.starred ? 'Local bookmark removed' : 'Bookmarked locally' };
    }
    case '/stars':
      return { results: store.starred(requireJid()) };
    case '/archive':
    case '/pin':
    case '/unread': {
      const jid = requireJid();
      const chat = store.chat(jid);
      const action = name.slice(1) as 'archive' | 'pin' | 'unread';
      const value =
        action === 'archive' ? !chat?.archived : action === 'pin' ? !chat?.pinned : true;
      await client.modifyChat(jid, action, value);
      return { notice: `Chat ${action} updated` };
    }
    case '/mute': {
      const jid = requireJid();
      const seconds = args[0] ? muteDuration(args[0]) : isMuted(store.chat(jid)) ? null : -1;
      await client.mute(jid, seconds);
      return {
        notice:
          seconds == null
            ? 'Chat unmuted'
            : seconds < 0
              ? 'Chat muted · always'
              : `Chat muted until ${new Date(Date.now() + seconds * 1000).toLocaleString()}`,
      };
    }
    case '/poll':
      if (args.length < 3) throw new Error('/poll "Question" "Option 1" "Option 2"');
      await client.poll(requireJid(), args[0], args.slice(1));
      return { notice: 'Poll sent' };
    case '/vote': {
      const m = selected();
      const poll = pollOf(m.raw);
      if (m.kind !== 'poll' || !poll) throw new Error('Select a poll with ↑ / ↓ first.');
      if (!args.length) throw new Error('/vote 2 · /vote 1,3 · /vote clear');
      const options =
        args[0] === 'clear'
          ? []
          : args
              .join(',')
              .split(/[,\s]+/)
              .filter(Boolean)
              .map((n) => {
                if (!/^\d+$/.test(n)) throw new Error('/vote takes option numbers, e.g. /vote 2');
                return +n - 1;
              });
      await client.vote(m, options);
      return {
        notice: options.length
          ? `Voted for ${options.map((i) => poll.options?.[i]?.optionName).join(', ')}`
          : 'Vote removed',
      };
    }
    case '/group': {
      const text = await client.group(ctx.jid || '', args[0] || 'info', args.slice(1));
      return { info: { title: 'Group', text } };
    }
    case '/settings':
      return {
        info: {
          title: 'Preferences',
          text: `Automatic visible-message receipts: ${settings.autoRead ? 'on' : 'off'} (paused while the terminal is unfocused)\nTyping indicators: ${settings.typing !== false ? 'on' : 'off'}\nTerminal bell: ${settings.notifications ? 'on' : 'off'}\nImage previews: ${settings.images || 'auto'}\nTheme: ${settings.theme}\n\n/receipts on|off\n/typing on|off\n/notifications on|off\n/images auto|kitty|blocks\n/theme dark|light\n\nLocal history and credentials are stored in this profile.\nDisabling automatic receipts does not change your WhatsApp account privacy settings.`,
        },
      };
    case '/receipts':
    case '/typing':
    case '/notifications': {
      if (!['on', 'off'].includes(args[0])) throw new Error(`${name} on|off`);
      const key =
        name === '/receipts' ? 'autoRead' : name === '/typing' ? 'typing' : 'notifications';
      return {
        settings: { ...settings, [key]: args[0] === 'on' },
        notice: `${name.slice(1)} ${args[0]}`,
      };
    }
    case '/images':
      if (!['auto', 'kitty', 'blocks'].includes(args[0]))
        throw new Error('/images auto|kitty|blocks');
      return {
        settings: { ...settings, images: args[0] as 'auto' | 'kitty' | 'blocks' },
        notice: `Image previews: ${args[0]}`,
      };
    case '/theme':
      if (!['dark', 'light'].includes(args[0])) throw new Error('/theme dark|light');
      return { settings: { ...settings, theme: args[0] as 'dark' | 'light' } };
    case '/export': {
      if (!args[0]) throw new Error('/export "path.json"');
      const jid = requireJid();
      const path = resolve(args[0]);
      await writeFile(
        path,
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            chat: store.chat(jid),
            messages: store.allMessages(jid).map(({ raw, ...m }) => m),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      return { notice: `Exported to ${path}` };
    }
    case '/logout':
      if (args[0] !== 'confirm')
        throw new Error(
          'Use /logout confirm to unlink this session and archive its local history before linking another account.',
        );
      await client.logout();
      return { resetAccount: true };
    default:
      throw new Error(`Unknown command ${name}. Try /help. Use // to send a literal slash.`);
  }
}
