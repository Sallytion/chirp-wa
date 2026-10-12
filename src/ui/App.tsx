import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import QRCode from 'qrcode';
import { readFile, stat } from 'node:fs/promises';
import open from 'open';
import wrapAnsi from 'wrap-ansi';
import type { Client, Message, Settings } from '../types.js';
import { Store } from '../store.js';
import { command, HELP, type CommandResult } from '../commands.js';
import { imagePreview } from '../media.js';
import { errorText, jidFor, safeText, saveSettings } from '../util.js';
import { Composer, composerLines } from './Composer.js';
import { EmojiSuggestions } from './EmojiSuggestions.js';
import { emojiToken, insertEmoji, searchEmoji } from '../emoji.js';
import {
  deleteAtCursor,
  deleteWordAtCursor,
  moveCursor,
  moveWordCursor,
  useTerminalInput,
} from './input.js';
import { isChannel, sectionFor, type ChatSection } from '../conversations.js';
import { fit, pad, qrText, transcript, viewport } from './layout.js';
import { palette } from './theme.js';
import { SyncStatus } from './SyncStatus.js';
import { readClipboard, type ClipboardContent, type ClipboardImage } from '../clipboard.js';

interface MenuItem {
  label: string;
  run: () => void | Promise<void>;
}
interface Modal {
  type: 'info' | 'chats' | 'search' | 'menu' | 'prompt' | 'preview';
  title: string;
  text?: string;
  query?: string;
  results?: Message[];
  items?: MenuItem[];
  submit?: (text: string) => void | Promise<void>;
  file?: string;
  image?: string;
  initial?: string;
}
export interface AppProps {
  store: Store;
  client: Client;
  dir: string;
  profile: string;
  settings: Settings;
  demo?: boolean;
  initialJid?: string;
  clipboard?: (dir: string) => Promise<ClipboardContent>;
}

export function App({
  store,
  client,
  dir,
  profile,
  settings: initialSettings,
  demo,
  initialJid,
  clipboard = readClipboard,
}: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 120, rows: stdout.rows || 36 });
  const [, setVersion] = useState(0);
  const [settings, setSettings] = useState(initialSettings);
  const [jid, setJid] = useState<string | undefined>(() => initialJid || store.chats()[0]?.jid);
  const [focus, setFocus] = useState<'chats' | 'messages' | 'composer'>(
    initialJid && isChannel(initialJid) ? 'messages' : 'composer',
  );
  const [filter, setFilter] = useState('all');
  const [section, setSection] = useState<ChatSection>(
    initialJid ? sectionFor(initialJid) : 'chats',
  );
  const pages = useRef<
    Partial<Record<ChatSection, { jid?: string; offset: number; selectedId: string | null }>>
  >({});
  const [chatIndex, setChatIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [value, setValueState] = useState(() => (jid ? store.draft(jid) : ''));
  const [cursor, setCursorState] = useState(Array.from(value).length);
  const editorRef = useRef({ value, cursor });
  const emojiRef = useRef({ key: '', index: 0, dismissed: '' });
  const [, refreshEmoji] = useState(0);
  function setValue(next: string) {
    emojiRef.current.dismissed = '';
    editorRef.current.value = next;
    setValueState(next);
  }
  function setCursor(next: number | ((previous: number) => number)) {
    const number = typeof next === 'function' ? next(editorRef.current.cursor) : next;
    editorRef.current.cursor = number;
    setCursorState(number);
  }
  const [reply, setReply] = useState<Message>();
  const [imageDrafts, setImageDrafts] = useState<Record<string, ClipboardImage>>({});
  const clipboardPending = useRef(false);
  const pastedImage = jid ? imageDrafts[jid] : undefined;
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [modal, setModal] = useState<Modal>();
  const [modalInput, setModalInput] = useState('');
  const [modalIndex, setModalIndex] = useState(0);
  const [modalScroll, setModalScroll] = useState(0);
  const [qr, setQr] = useState('');
  const readPending = useRef(new Set<string>());
  const draftRef = useRef({ jid, value });
  draftRef.current = { jid, value };
  const columns = Math.max(40, size.columns);
  const rows = Math.max(15, size.rows);
  const sidebar = columns >= 90;
  const sidebarWidth = sidebar ? Math.min(36, Math.floor(columns * 0.28)) : 0;
  const contentWidth = columns - sidebarWidth - (sidebar ? 1 : 0);
  const colors = useMemo(() => palette(settings.theme), [settings.theme]);
  const { accent, muted, highlight, border } = colors;
  const state = client.state;
  const login = !demo && !store.stats().chats && state.connection !== 'open';
  const loginVisible =
    !demo && (state.connection === 'qr' || state.connection === 'logged-out' || login);
  const syncVisible = !!state.sync && !loginVisible;
  function emojiPicker(text: string, position: number) {
    if (focus !== 'composer' || section === 'channels' || modal || loginVisible) return;
    const token = emojiToken(text, position);
    if (!token || token.key === emojiRef.current.dismissed) return;
    const items = searchEmoji(token.query);
    if (!items.length) return;
    return {
      token,
      items,
      index:
        token.key === emojiRef.current.key ? Math.min(emojiRef.current.index, items.length - 1) : 0,
    };
  }
  const picker = emojiPicker(value, cursor);
  const emojiRows = Math.min(4, Math.max(1, rows - 18));
  const pickerHeight = picker ? Math.min(emojiRows, picker.items.length) + 1 : 0;
  const composerExtra =
    section === 'chats' && value
      ? Math.max(0, composerLines(value, cursor, columns - 2).length - 1)
      : 0;
  const bodyHeight = Math.max(
    5,
    rows -
      9 -
      +syncVisible -
      pickerHeight -
      (reply ? 1 : 0) -
      (pastedImage ? 1 : 0) -
      composerExtra,
  );
  // Editor, presence, and dialog updates must not decode history or rerun inbox queries.
  const revision = store.revision;
  const chats = useMemo(() => store.chats('', filter, section), [store, revision, filter, section]);
  const messages = useMemo(
    () => (jid ? store.history(jid, 60, offset) : []),
    [store, revision, jid, offset],
  );
  const selected = messages.find((m) => m.id === selectedId) || messages.at(-1);
  const transcriptLines = useMemo(
    () => transcript(messages, contentWidth - 6, (m) => store.senderName(m)),
    [messages, contentWidth, store, revision],
  );
  const lines = useMemo(
    () =>
      viewport(
        transcriptLines,
        Math.max(1, bodyHeight - (rows < 20 ? 4 : 5)),
        focus === 'messages' ? selectedId : null,
      ),
    [transcriptLines, bodyHeight, rows, focus, selectedId],
  );
  const visibleMessages = useMemo(
    () => [
      ...new Map(
        lines.flatMap((l) =>
          l.message && l.text.trim() ? [[l.message.id, l.message] as const] : [],
        ),
      ).values(),
    ],
    [lines],
  );
  const messageRows = useMemo(
    () =>
      lines.map((line, i) => (
        <Box
          key={i}
          height={1}
          flexShrink={0}
          justifyContent={
            line.day || line.message?.kind === 'system'
              ? 'center'
              : line.message?.fromMe && line.bubbleWidth
                ? 'flex-end'
                : 'flex-start'
          }
        >
          <Text
            color={focus === 'messages' && line.message?.id === selectedId ? accent : undefined}
          >
            {focus === 'messages' && line.message?.id === selectedId ? '▎' : ''}
          </Text>
          <Text
            color={
              line.message?.kind === 'system' || line.day
                ? muted
                : line.meta
                  ? line.message?.fromMe && ['read', 'played'].includes(line.message.status)
                    ? colors.read
                    : accent
                  : line.message?.deleted
                    ? muted
                    : colors.text
            }
            backgroundColor={
              focus === 'messages' && line.message?.id === selectedId
                ? highlight
                : line.bubbleWidth
                  ? line.message?.fromMe
                    ? colors.outgoing
                    : colors.incoming
                  : undefined
            }
          >
            {fit(line.text, contentWidth - 7)}
          </Text>
        </Box>
      )),
    [lines, focus, selectedId, accent, muted, colors, highlight, contentWidth],
  );

  useEffect(() => {
    const update = () => setVersion((v) => v + 1);
    const a = store.subscribe(update);
    const b = client.subscribe(update);
    const resize = () => setSize({ columns: stdout.columns || 120, rows: stdout.rows || 36 });
    stdout.on('resize', resize);
    return () => {
      a();
      b();
      stdout.off('resize', resize);
      const draft = draftRef.current;
      if (draft.jid) store.saveDraft(draft.jid, draft.value);
    };
  }, [client, store, stdout]);
  useEffect(() => {
    if (jid) store.saveDraft(jid, value);
  }, [jid, value, store]);
  useEffect(() => {
    setChatIndex((i) => Math.min(i, Math.max(0, chats.length - 1)));
  }, [chats.length]);
  useEffect(() => {
    if (!state.qr) {
      setQr('');
      return;
    }
    try {
      setQr(qrText(QRCode.create(state.qr, { errorCorrectionLevel: 'L' }).modules));
    } catch (error) {
      setNotice(errorText(error));
    }
  }, [state.qr]);
  const visibleKey = visibleMessages.map((m) => `${m.id}:${m.localRead}`).join(',');
  useEffect(() => {
    if (!jid || !settings.autoRead || state.connection !== 'open' || modal) return;
    const unread = visibleMessages.filter(
      (m) =>
        !m.fromMe && !m.localRead && !m.deleted && !readPending.current.has(`${m.jid}:${m.id}`),
    );
    if (!unread.length) return;
    const timer = setTimeout(() => {
      for (const m of unread) readPending.current.add(`${m.jid}:${m.id}`);
      void client
        .read(jid, unread)
        .catch((error) => setNotice(errorText(error)))
        .finally(() => {
          for (const m of unread) readPending.current.delete(`${m.jid}:${m.id}`);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [jid, visibleKey, settings.autoRead, state.connection, !!modal]);
  useEffect(() => {
    if (!jid || state.connection !== 'open' || !value || value.startsWith('/')) return;
    const timer = setTimeout(() => {
      void client.typing(jid, true).catch(() => {});
    }, 300);
    const paused = setTimeout(() => {
      void client.typing(jid, false).catch(() => {});
    }, 3000);
    return () => {
      clearTimeout(timer);
      clearTimeout(paused);
    };
  }, [value, jid, state.connection]);

  function setDraft(text: string) {
    setValue(text);
    setCursor(Array.from(text).length);
  }
  function switchSection(next: ChatSection) {
    if (next === section) {
      setModal(undefined);
      return;
    }
    if (jid) store.saveDraft(jid, editorRef.current.value);
    pages.current[section] = { jid, offset, selectedId };
    const previous = pages.current[next];
    const nextChats = store.chats('', 'all', next);
    const nextJid = previous?.jid || nextChats[0]?.jid;
    setSection(next);
    setFilter('all');
    setJid(nextJid);
    setDraft(nextJid ? store.draft(nextJid) : '');
    setOffset(previous?.offset || 0);
    setSelectedId(previous?.selectedId || null);
    setReply(undefined);
    setChatIndex(
      Math.max(
        0,
        nextChats.findIndex((c) => c.jid === nextJid),
      ),
    );
    setFocus(next === 'channels' ? 'messages' : 'composer');
    setModal(undefined);
  }
  function switcher() {
    show({
      type: 'chats',
      title:
        section === 'channels'
          ? 'Switch channel · type a channel name'
          : 'Switch chat · type a name or phone number',
    });
  }
  function openChat(nextJid: string, message?: Message) {
    if (jid) store.saveDraft(jid, editorRef.current.value);
    const resolved = store.resolve(nextJid);
    const nextSection = sectionFor(resolved);
    if (nextSection !== section) {
      pages.current[section] = { jid, offset, selectedId };
      setSection(nextSection);
      setFilter('all');
    }
    setJid(resolved);
    setDraft(store.draft(resolved));
    setReply(undefined);
    const index = store
      .chats('', nextSection === section ? filter : 'all', nextSection)
      .findIndex((c) => c.jid === resolved);
    setChatIndex(Math.max(0, index));
    if (message) {
      const all = store.allMessages(resolved);
      const i = all.findIndex((m) => m.id === message.id && m.fromMe === message.fromMe);
      setOffset(Math.max(0, all.length - i - 30));
      setSelectedId(message.id);
      setFocus('messages');
    } else {
      setOffset(0);
      setSelectedId(null);
      setFocus(nextSection === 'channels' ? 'messages' : 'composer');
    }
    setModal(undefined);
    void client.typing(resolved, false).catch(() => {});
  }
  function show(next: Modal) {
    setModal(next);
    setModalInput(next.initial || '');
    setModalIndex(0);
    setModalScroll(0);
  }
  function preferences(next: Settings) {
    setSettings(next);
    saveSettings(dir, next);
  }
  async function task(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function preview(message: Message) {
    const path = await client.download(message);
    show({
      type: 'preview',
      title: `${message.kind.toUpperCase()} · ${message.filename || message.text.split('\n')[0] || message.id}`,
      file: path,
      text: 'Loading preview…',
    });
    let image: string | undefined;
    let text = '';
    if (['image', 'sticker'].includes(message.kind)) {
      try {
        image = await imagePreview(path, columns - 10, rows - 11);
      } catch {
        text =
          'This image format cannot be rendered here. Press O to open it in your default viewer.';
      }
    } else if (message.mimetype?.startsWith('text/') && (await stat(path)).size < 1024 * 1024)
      text = safeText(await readFile(path, 'utf8'));
    else
      text = `${message.text}\n\n${message.mimetype || message.kind}\n${path}\n\nPress O to open with your default player or viewer.`;
    setModal((current) => (current?.file === path ? { ...current, image, text } : current));
  }
  function discardImage() {
    if (!jid) return;
    setImageDrafts((previous) => {
      const next = { ...previous };
      delete next[jid];
      return next;
    });
    setNotice('Image attachment removed');
  }
  async function previewDraftImage() {
    if (!pastedImage) {
      if (!selected) throw new Error('Select a message with an attachment first.');
      await preview(selected);
      return;
    }
    const file = pastedImage.path;
    show({
      type: 'preview',
      title: `Clipboard image · ${pastedImage.width} × ${pastedImage.height}`,
      file,
      text: 'Loading preview…',
    });
    const image = await imagePreview(file, columns - 10, rows - 11);
    setModal((current) => (current?.file === file ? { ...current, image, text: '' } : current));
  }
  async function pasteClipboard() {
    if (section === 'channels') {
      setNotice('Switch to Chats with Ctrl+N to paste an attachment.');
      return;
    }
    if (!jid) {
      setNotice('Open a conversation with Ctrl+K before pasting.');
      return;
    }
    const target = jid;
    await task(async () => {
      clipboardPending.current = true;
      try {
        const content = await clipboard(dir);
        if (content.type === 'image') {
          setImageDrafts((previous) => ({ ...previous, [target]: content }));
          setFocus('composer');
          setNotice('Image attached · add a caption, Ctrl+P preview, Enter send');
        } else {
          const editor = editorRef.current;
          const chars = Array.from(editor.value);
          chars.splice(editor.cursor, 0, ...Array.from(content.text));
          setValue(chars.join(''));
          setCursor(editor.cursor + Array.from(content.text).length);
          setFocus('composer');
          setNotice('Clipboard text pasted');
        }
      } finally {
        clipboardPending.current = false;
      }
    });
  }
  async function apply(result: CommandResult) {
    if (result.resetAccount) {
      pages.current = {};
      readPending.current.clear();
      setImageDrafts({});
      setJid(undefined);
      setDraft('');
      setReply(undefined);
      setSelectedId(null);
      setOffset(0);
      setChatIndex(0);
      setModal(undefined);
      setSection('chats');
      setFilter('all');
      setFocus('composer');
      setNotice('');
    }
    if (result.notice) setNotice(result.notice);
    if (result.info) show({ type: 'info', ...result.info });
    if (result.openJid) openChat(result.openJid);
    if (result.section) switchSection(result.section);
    if (result.filter) setFilter(result.filter);
    if (result.results)
      show({ type: 'search', title: 'Search results · Enter to jump', results: result.results });
    if (result.reply) {
      setReply(result.reply);
      setFocus('composer');
    }
    if (result.cancelReply) setReply(undefined);
    if (result.settings) preferences(result.settings);
    if (result.preview) await preview(result.preview);
    if (result.quit) exit();
  }
  const execute = async (text: string) => {
    await task(async () => {
      await apply(
        await command(text, {
          store,
          client,
          jid,
          selected,
          visible: visibleMessages,
          settings,
          section,
        }),
      );
    });
  };
  function prompt(title: string, submit: (text: string) => Promise<void>, initial = '') {
    show({
      type: 'prompt',
      title,
      submit: async (text) => {
        await task(async () => {
          await submit(text);
        });
      },
      initial,
    });
  }
  function attachment() {
    if (section === 'channels') {
      setNotice('Channels are read-only here. Switch to Chats with Ctrl+N.');
      return;
    }
    if (!jid) {
      setNotice('Open a chat to attach a file.');
      return;
    }
    prompt('Attach file · enter an absolute path', async (path) => {
      if (!path.trim()) return;
      show({
        type: 'prompt',
        title: 'Attachment caption · optional',
        submit: async (caption) => {
          await task(async () => {
            await client.sendFile(jid, path.replace(/^"|"$/g, ''), caption);
            setNotice('Attachment sent');
          });
        },
      });
    });
  }
  function form(title: string, fields: string[], submit: (values: string[]) => Promise<void>) {
    const values: string[] = [];
    const step = (index: number) =>
      show({
        type: 'prompt',
        title: `${title} · ${fields[index]} (${index + 1}/${fields.length})`,
        submit: async (text) => {
          values.push(text);
          if (index + 1 < fields.length) step(index + 1);
          else
            await task(async () => {
              await submit(values);
            });
        },
      });
    step(0);
  }
  function groupMenu() {
    const runGroup = async (action: string, args: string[]) => {
      show({ type: 'info', title: 'Group', text: await client.group(jid || '', action, args) });
    };
    show({
      type: 'menu',
      title: 'Groups',
      items: [
        { label: 'Group details & participants', run: () => execute('/group info') },
        {
          label: 'Create a group',
          run: () =>
            form(
              'Create group',
              ['Name', 'Participant phone numbers, separated by spaces'],
              async ([name, people]) =>
                runGroup('create', [name, ...people.split(/[,\s]+/).filter(Boolean)]),
            ),
        },
        ...['add', 'remove', 'promote', 'demote'].map((action) => ({
          label: `${action[0].toUpperCase() + action.slice(1)} participants`,
          run: () =>
            prompt(`Group ${action} · phone numbers or JIDs separated by spaces`, async (text) =>
              runGroup(action, text.split(/[,\s]+/).filter(Boolean)),
            ),
        })),
        {
          label: 'Change group name',
          run: () => prompt('Group name', async (text) => runGroup('subject', [text])),
        },
        {
          label: 'Change description',
          run: () => prompt('Group description', async (text) => runGroup('description', [text])),
        },
        { label: 'Show group invite link', run: () => execute('/group invite') },
        {
          label: 'Disappearing messages',
          run: () =>
            show({
              type: 'menu',
              title: 'Group disappearing messages',
              items: [
                ['Off', '0'],
                ['24 hours', '86400'],
                ['7 days', '604800'],
                ['90 days', '7776000'],
              ].map(([label, seconds]) => ({
                label,
                run: () => execute(`/group ephemeral ${seconds}`),
              })),
            }),
        },
        {
          label: 'Leave this group',
          run: () =>
            show({
              type: 'menu',
              title: 'Leave this WhatsApp group?',
              items: [
                { label: 'Cancel', run: () => {} },
                { label: 'Leave group', run: () => execute('/group leave confirm') },
              ],
            }),
        },
      ],
    });
  }
  function settingsMenu() {
    show({
      type: 'menu',
      title: 'Preferences',
      items: [
        {
          label: `Automatic read receipts: ${settings.autoRead ? 'ON' : 'OFF'}`,
          run: () => {
            preferences({ ...settings, autoRead: !settings.autoRead });
            setNotice('Read receipt preference saved');
          },
        },
        {
          label: `Message notification bell: ${settings.notifications ? 'ON' : 'OFF'}`,
          run: () => {
            preferences({ ...settings, notifications: !settings.notifications });
          },
        },
        {
          label: `Theme: ${settings.theme}`,
          run: () => {
            preferences({ ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' });
          },
        },
        {
          label: 'Keyboard & command guide',
          run: () => show({ type: 'info', title: 'Help', text: HELP }),
        },
      ],
    });
  }
  function logoutMenu() {
    show({
      type: 'menu',
      title: 'Log out / link another account?',
      items: [
        { label: 'Cancel', run: () => {} },
        {
          label: 'Log out (archive history, contacts, drafts & media)',
          run: () => execute('/logout confirm'),
        },
      ],
    });
  }
  function actions() {
    if (section === 'channels') {
      show({
        type: 'menu',
        title: 'Channel actions',
        items: [
          {
            label: 'Switch to Chats (direct + groups)            Ctrl+N',
            run: () => switchSection('chats'),
          },
          { label: 'Switch channel                              Ctrl+K', run: switcher },
          {
            label: 'Preview selected attachment                  Ctrl+P',
            run: () => execute('/preview'),
          },
          { label: 'Open selected attachment', run: () => execute('/open-media') },
          { label: 'Update info', run: () => execute('/info') },
          { label: 'Bookmark selected update', run: () => execute('/star') },
          { label: 'Show bookmarked updates', run: () => execute('/stars') },
          {
            label: 'Channel filters',
            run: () =>
              show({
                type: 'menu',
                title: 'Channel filters',
                items: ['all', 'unread', 'archived'].map((f) => ({
                  label: f,
                  run: () => {
                    setFilter(f);
                    setFocus('chats');
                  },
                })),
              }),
          },
          { label: 'Sync WhatsApp contact names', run: () => execute('/sync-contacts') },
          { label: 'Preferences', run: settingsMenu },
          { label: 'Keyboard guide', run: () => show({ type: 'info', title: 'Help', text: HELP }) },
          { label: 'Log out / link another account', run: logoutMenu },
        ],
      });
      return;
    }
    show({
      type: 'menu',
      title: 'Actions · ↑ ↓ select · Enter apply',
      items: [
        {
          label: 'Switch to Channels                           Ctrl+N',
          run: () => switchSection('channels'),
        },
        { label: 'Sync WhatsApp contact names', run: () => execute('/sync-contacts') },
        { label: 'Paste from clipboard (image or text)          Ctrl+V', run: pasteClipboard },
        {
          label: 'Reply to selected message                    Ctrl+R',
          run: () => execute('/reply'),
        },
        {
          label: 'React to selected message',
          run: () =>
            show({
              type: 'menu',
              title: 'Choose a reaction',
              items: ['👍', '💚', '😂', '😮', '😢', '🙏', 'Remove my reaction'].map((emoji) => ({
                label: emoji,
                run: () => execute(`/react "${emoji.startsWith('Remove') ? '' : emoji}"`),
              })),
            }),
        },
        {
          label: 'Preview selected attachment                  Ctrl+P',
          run: () => execute('/preview'),
        },
        { label: 'Open selected attachment externally', run: () => execute('/open-media') },
        { label: 'Send an attachment                           Ctrl+T', run: attachment },
        {
          label: 'Send a voice note from an Ogg/Opus file',
          run: () =>
            prompt('Voice note · path to an Ogg/Opus recording', async (path) => {
              if (!jid) throw new Error('Open a chat first.');
              await client.sendFile(jid, path, '', true);
              setNotice('Voice note sent');
            }),
        },
        {
          label: 'Download selected attachment',
          run: () =>
            prompt('Save attachment · destination path (blank = cache)', async (path) => {
              await apply(
                await command(`/download "${path}"`, {
                  store,
                  client,
                  selected,
                  jid,
                  settings,
                  visible: visibleMessages,
                }),
              );
            }),
        },
        {
          label: 'Edit selected message',
          run: () =>
            prompt(
              'Edit your selected message',
              async (text) => {
                if (!selected) throw new Error('Select a message.');
                await client.edit(selected, text);
                setNotice('Message edited');
              },
              selected?.text,
            ),
        },
        {
          label: 'Delete selected message for everyone',
          run: () =>
            show({
              type: 'menu',
              title: 'Delete this message for everyone?',
              items: [
                { label: 'Cancel', run: () => {} },
                { label: 'Delete selected message', run: () => execute('/delete confirm') },
              ],
            }),
        },
        {
          label: 'Forward selected message',
          run: () =>
            prompt('Forward to · international phone number or JID', async (phone) => {
              if (!selected) throw new Error('Select a message.');
              await client.forward(selected, jidFor(phone));
              setNotice('Message forwarded');
            }),
        },
        { label: 'Message info & per-recipient receipts', run: () => execute('/info') },
        { label: 'Toggle local bookmark   ', run: () => execute('/star') },
        { label: 'Show bookmarked messages', run: () => execute('/stars') },
        { label: 'Request older conversation history', run: () => execute('/history') },
        { label: 'Mark visible messages read', run: () => execute('/read') },
        { label: 'Archive / unarchive this chat', run: () => execute('/archive') },
        { label: 'Pin / unpin this chat', run: () => execute('/pin') },
        { label: 'Mute / unmute this chat', run: () => execute('/mute') },
        { label: 'Mark this chat unread', run: () => execute('/unread') },
        {
          label: 'Filter chats',
          run: () =>
            show({
              type: 'menu',
              title: 'Chat filters',
              items: ['all', 'unread', 'groups', 'archived'].map((f) => ({
                label: f,
                run: () => {
                  setFilter(f);
                  setFocus('chats');
                },
              })),
            }),
        },
        {
          label: 'Create a poll',
          run: () =>
            form(
              'Create poll',
              ['Question', 'Options separated by | (2–12 choices)'],
              async ([title, choices]) => {
                if (!jid) throw new Error('Open a chat first.');
                await client.poll(
                  jid,
                  title,
                  choices
                    .split('|')
                    .map((v) => v.trim())
                    .filter(Boolean),
                );
                setNotice('Poll sent');
              },
            ),
        },
        {
          label: 'Mention a group participant',
          run: () =>
            form(
              'Group mention',
              ['Participant phone number', 'Message'],
              async ([phone, text]) => {
                if (!jid?.endsWith('@g.us')) throw new Error('Open a group first.');
                const target = jidFor(phone);
                await client.send(jid, `@${target.split('@')[0]} ${text}`, undefined, [target]);
                setNotice('Mention sent');
              },
            ),
        },
        { label: 'Group management', run: groupMenu },
        {
          label: 'Export this conversation',
          run: () =>
            prompt('Export conversation · destination .json path', async (path) => {
              await apply(
                await command(`/export "${path}"`, {
                  store,
                  client,
                  jid,
                  selected,
                  settings,
                  visible: visibleMessages,
                }),
              );
            }),
        },
        { label: 'Preferences', run: settingsMenu },
        {
          label: 'Keyboard & command guide',
          run: () => show({ type: 'info', title: 'Help', text: HELP }),
        },
        { label: 'Log out / link another account', run: logoutMenu },
      ],
    });
  }
  function navigateMessage(direction: number) {
    if (!messages.length) return;
    const index = selectedId ? messages.findIndex((m) => m.id === selectedId) : messages.length;
    const next = index + direction;
    if (next < 0 && offset + messages.length < store.count(jid!)) {
      const nextOffset = offset + 30;
      const earlier = store.history(jid!, 60, nextOffset);
      setOffset(nextOffset);
      setSelectedId(earlier.at(-31)?.id || earlier[0]?.id || null);
    } else if (next >= messages.length && offset > 0) {
      const nextOffset = Math.max(0, offset - 30);
      const later = store.history(jid!, 60, nextOffset);
      setOffset(nextOffset);
      setSelectedId(later[Math.min(30, later.length - 1)]?.id || null);
    } else setSelectedId(messages[Math.max(0, Math.min(messages.length - 1, next))]?.id || null);
    setFocus('messages');
  }
  async function send() {
    const { value } = editorRef.current;
    if ((!value.trim() && !pastedImage) || busyRef.current) return;
    const text = value;
    await task(async () => {
      if (text.startsWith('/') && !text.startsWith('//')) {
        const result = await command(text, {
          store,
          client,
          jid,
          selected,
          visible: visibleMessages,
          settings,
          section,
        });
        setDraft('');
        await apply(result);
      } else {
        if (!jid) throw new Error('Open a conversation first with Ctrl+K.');
        if (pastedImage)
          await client.sendFile(
            jid,
            pastedImage.path,
            text.startsWith('//') ? text.slice(1) : text,
            false,
            reply,
          );
        else await client.send(jid, text.startsWith('//') ? text.slice(1) : text, reply);
        if (pastedImage)
          setImageDrafts((previous) => {
            const next = { ...previous };
            delete next[jid];
            return next;
          });
        setDraft('');
        setReply(undefined);
        setOffset(0);
        setSelectedId(null);
        setNotice(pastedImage ? 'Image sent' : 'Message sent');
        void client.typing(jid, false).catch(() => {});
      }
    });
  }
  useTerminalInput((input, key) => {
    const { value, cursor } = editorRef.current;
    if (key.ctrl && ['c', 'q'].includes(input)) {
      exit();
      return;
    }
    if (clipboardPending.current) return;
    if (
      busyRef.current &&
      (key.return ||
        key.meta ||
        (key.ctrl && ['k', 'f', 'g', 'n', 'v', 'p', 'r', 't'].includes(input)))
    )
      return;
    if (modal) {
      if (key.escape) {
        setModal(undefined);
        return;
      }
      if (modal.type === 'info' || modal.type === 'preview') {
        if (key.downArrow || key.pageDown) setModalScroll((n) => n + (key.pageDown ? 8 : 1));
        if (key.upArrow || key.pageUp) setModalScroll((n) => Math.max(0, n - (key.pageUp ? 8 : 1)));
        if (modal.file && input.toLowerCase() === 'o')
          void task(async () => {
            await open(modal.file!);
          });
        return;
      }
      const items =
        modal.type === 'chats'
          ? store.directory(modalInput, section)
          : modal.type === 'search'
            ? modal.results || (modalInput ? store.search(modalInput, modal.query, section) : [])
            : modal.items || [];
      if (key.upArrow) {
        setModalIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setModalIndex((i) => Math.min(Math.max(0, items.length - 1), i + 1));
        return;
      }
      if (key.return) {
        if (modal.type === 'chats') {
          const chat = (items as ReturnType<Store['chats']>)[modalIndex];
          if (chat) {
            store.upsertChat({ jid: chat.jid, name: chat.name });
            openChat(chat.jid);
          } else if (section === 'channels') setNotice('No matching synced channel.');
          else {
            try {
              const next = jidFor(modalInput);
              store.upsertChat({ jid: next });
              openChat(next);
            } catch (error) {
              setNotice(errorText(error));
            }
          }
        } else if (modal.type === 'search') {
          const m = (items as Message[])[modalIndex];
          if (m) openChat(m.jid, m);
        } else if (modal.type === 'menu') {
          const item = (items as MenuItem[])[modalIndex];
          setModal(undefined);
          if (item) Promise.resolve(item.run()).catch((error) => setNotice(errorText(error)));
        } else if (modal.type === 'prompt') {
          const submit = modal.submit;
          setModal(undefined);
          if (submit)
            Promise.resolve(submit(modalInput)).catch((error) => setNotice(errorText(error)));
        }
        return;
      }
      if (modal.type === 'menu') return;
      if ((key.ctrl && input === 'w') || ((key.ctrl || key.meta) && key.backspace)) {
        setModalInput((s) => deleteWordAtCursor(s, Array.from(s).length, true).value);
        setModalIndex(0);
      } else if (key.backspace) {
        setModalInput((s) => deleteAtCursor(s, Array.from(s).length, true).value);
        setModalIndex(0);
      } else if (key.ctrl && input === 'u') setModalInput('');
      else if (!key.ctrl && !key.meta && !key.tab && input) {
        setModalInput((s) => s + safeText(input).replace(/\n/g, ''));
        setModalIndex(0);
      }
      return;
    }
    if (loginVisible) {
      if (input.toLowerCase() === 'p' && !state.linked && state.connection !== 'logged-out')
        prompt('Pair with phone number · include country code', async (phone) =>
          client.requestPairing(phone),
        );
      if (input.toLowerCase() === 'q')
        void task(async () => {
          await client.useQr();
        });
      return;
    }
    if (key.ctrl && input === 'k') {
      switcher();
      return;
    }
    if (key.ctrl && input === 'f') {
      show({ type: 'search', title: 'Search messages · Enter to jump', query: jid });
      return;
    }
    if (key.ctrl && input === 'g') {
      actions();
      return;
    }
    if (key.ctrl && input === 'n') {
      switchSection(section === 'chats' ? 'channels' : 'chats');
      return;
    }
    if (key.ctrl && input === 'v') {
      void pasteClipboard();
      return;
    }
    if (key.ctrl && input === 'p') {
      void task(previewDraftImage);
      return;
    }
    if (key.ctrl && input === 'r') {
      void execute('/reply');
      return;
    }
    if (key.ctrl && input === 't') {
      attachment();
      return;
    }
    if (focus === 'composer' && section === 'chats') {
      if (
        (key.ctrl && input === 'w') ||
        ((key.ctrl || key.meta) && key.backspace) ||
        (key.ctrl && key.delete)
      ) {
        const next = deleteWordAtCursor(value, cursor, !(key.ctrl && key.delete));
        setValue(next.value);
        setCursor(next.cursor);
        return;
      }
      if ((key.ctrl || key.meta) && (key.leftArrow || key.rightArrow)) {
        setCursor(moveWordCursor(value, cursor, key.leftArrow ? -1 : 1));
        return;
      }
    }
    const currentPicker = emojiPicker(value, cursor);
    if (currentPicker && !key.ctrl && (!key.meta || key.escape)) {
      if (key.escape) {
        emojiRef.current.dismissed = currentPicker.token.key;
        refreshEmoji((n) => n + 1);
        return;
      }
      if (key.upArrow || key.downArrow) {
        emojiRef.current.key = currentPicker.token.key;
        emojiRef.current.index =
          (currentPicker.index + (key.upArrow ? currentPicker.items.length - 1 : 1)) %
          currentPicker.items.length;
        refreshEmoji((n) => n + 1);
        return;
      }
      if (key.tab || key.return) {
        const next = insertEmoji(
          value,
          currentPicker.token,
          currentPicker.items[currentPicker.index].emoji,
        );
        setValue(next.value);
        setCursor(next.cursor);
        return;
      }
    }
    if (key.escape) {
      if (pastedImage) discardImage();
      setReply(undefined);
      setSelectedId(null);
      setFocus(section === 'channels' ? 'messages' : 'composer');
      return;
    }
    if (key.meta) {
      const action = input.toLowerCase();
      if (action === '1') switchSection('chats');
      else if (action === '2') switchSection('channels');
      else if (action === 'a') actions();
      else if (action === 'l') logoutMenu();
      else if (action === 'h') show({ type: 'info', title: 'Help', text: HELP });
      else if (action === 'p') void task(previewDraftImage);
      else if (action === 'o') void execute('/open-media');
      else if (action === 'r') void execute('/reply');
      else if (action === 'i') void execute('/info');
      else if (action === 's') void execute('/star');
      else if (action === 't') attachment();
      else if (action === 'u') {
        const unread = store.chats('', 'unread', section).find((c) => c.jid !== jid);
        if (unread) openChat(unread.jid);
        else setNotice(`No other unread ${section}`);
      } else if (key.return && focus === 'composer') {
        const c = Array.from(value);
        c.splice(cursor, 0, '\n');
        setValue(c.join(''));
        setCursor(cursor + 1);
      }
      return;
    }
    if (key.tab) {
      const order: ('chats' | 'messages' | 'composer')[] =
        section === 'channels'
          ? sidebar
            ? ['chats', 'messages']
            : ['messages']
          : sidebar
            ? ['chats', 'messages', 'composer']
            : ['messages', 'composer'];
      const i = order.findIndex((f) => f === focus);
      setFocus(order[(i + (key.shift ? order.length - 1 : 1)) % order.length]);
      return;
    }
    if (key.pageUp || key.pageDown) {
      const max = Math.max(0, store.count(jid || '') - 1);
      const next = Math.min(max, Math.max(0, offset + (key.pageUp ? 10 : -10)));
      setOffset(next);
      setSelectedId(null);
      return;
    }
    if (focus === 'chats') {
      if (key.upArrow) setChatIndex((i) => Math.max(0, i - 1));
      if (key.downArrow) setChatIndex((i) => Math.min(chats.length - 1, i + 1));
      if (key.return && chats[chatIndex]) openChat(chats[chatIndex].jid);
      if (input === '/') switcher();
      return;
    }
    if (focus === 'messages') {
      if (key.upArrow) navigateMessage(-1);
      else if (key.downArrow) navigateMessage(1);
      else if (key.return || input === 'a') actions();
      else if (input === 'r') void execute('/reply');
      else if (input === 'p') void execute('/preview');
      else if (input === 'i' && section === 'chats') setFocus('composer');
      else if (key.end) {
        setOffset(0);
        setSelectedId(null);
      } else if (key.home) {
        const next = Math.max(0, store.count(jid || '') - 60);
        setOffset(next);
        setSelectedId(store.history(jid || '', 60, next)[0]?.id || null);
      }
      return;
    }
    if (section === 'channels') return;
    if (key.ctrl && input === 'j') {
      const c = Array.from(value);
      c.splice(cursor, 0, '\n');
      setValue(c.join(''));
      setCursor(cursor + 1);
      return;
    }
    if (key.ctrl && input === 'a') {
      setCursor(0);
      return;
    }
    if (key.ctrl && input === 'e') {
      setCursor(Array.from(value).length);
      return;
    }
    if (key.ctrl && input === 'u') {
      setValue(Array.from(value).slice(cursor).join(''));
      setCursor(0);
      return;
    }
    if (key.ctrl && input === 'k') {
      setValue(Array.from(value).slice(0, cursor).join(''));
      return;
    }
    if (key.upArrow && !value) {
      navigateMessage(-1);
      return;
    }
    if (key.leftArrow) {
      setCursor(moveCursor(value, cursor, -1));
      return;
    }
    if (key.rightArrow) {
      setCursor(moveCursor(value, cursor, 1));
      return;
    }
    if (key.home) {
      setCursor(0);
      return;
    }
    if (key.end) {
      setCursor(Array.from(value).length);
      return;
    }
    if (key.backspace || key.delete) {
      const next = deleteAtCursor(value, cursor, key.backspace);
      setValue(next.value);
      setCursor(next.cursor);
      return;
    }
    if (key.return) {
      void send();
      return;
    }
    if (!key.ctrl && input) {
      const clean = safeText(input).replace(/\r/g, '\n');
      const c = Array.from(value);
      c.splice(cursor, 0, ...Array.from(clean));
      setValue(c.join(''));
      setCursor(cursor + Array.from(clean).length);
    }
  });

  const modalHeight = rows - 7 - +syncVisible;
  function modalContent() {
    if (!modal) return null;
    if (modal.type === 'info' || modal.type === 'preview') {
      const textLines = wrapAnsi(safeText(modal.text || ''), columns - 8, { hard: true }).split(
        '\n',
      );
      const scroll = Math.min(modalScroll, Math.max(0, textLines.length - modalHeight + 4));
      return (
        <>
          <Text>{modal.image || textLines.slice(scroll, scroll + modalHeight - 4).join('\n')}</Text>
          <Box flexGrow={1} />
          <Text color={muted}>
            Esc close {modal.file ? '· O open externally ' : ''}· ↑ ↓ scroll
          </Text>
        </>
      );
    }
    if (modal.type === 'prompt')
      return (
        <>
          <Text color={muted}>Enter to continue · Esc cancel</Text>
          <Box marginTop={1}>
            <Text color={accent}>› {modalInput}▌</Text>
          </Box>
          <Box flexGrow={1} />
        </>
      );
    const list: MenuItem[] =
      modal.type === 'chats'
        ? store.directory(modalInput, section).map((c) => ({
            label: `${c.name}${c.unread ? ` (${c.unread})` : ''} · ${c.jid}`,
            run: () => {},
          }))
        : modal.type === 'search'
          ? (
              modal.results || (modalInput ? store.search(modalInput, modal.query, section) : [])
            ).map((m) => ({
              label: `${store.name(m.jid)} · ${m.text.replace(/\n/g, ' ')}`,
              run: () => {},
            }))
          : modal.items || [];
    const available = modalHeight - (modal.type === 'menu' ? 5 : 7);
    const start = Math.max(0, modalIndex - available + 1);
    return (
      <>
        {modal.type !== 'menu' && (
          <>
            <Text color={accent}>⌕ {modalInput}▌</Text>
            <Text color={muted}>
              {list.length} results{' '}
              {modal.type === 'chats'
                ? section === 'channels'
                  ? '· synced channels only'
                  : '· enter a phone number to start a chat'
                : ''}
            </Text>
            <Text> </Text>
          </>
        )}
        {list.slice(start, start + available).map((item, i) => (
          <Text
            key={start + i}
            color={start + i === modalIndex ? accent : undefined}
            backgroundColor={start + i === modalIndex ? highlight : undefined}
          >
            {fit(`${start + i === modalIndex ? '›' : ' '} ${item.label}`, columns - 8)}
          </Text>
        ))}
        {!list.length && (
          <Text color={muted}>
            {modal.type === 'search' && !modalInput && !modal.results
              ? 'Type to search locally cached messages.'
              : 'No results.'}
          </Text>
        )}
        <Box flexGrow={1} />
        <Text color={muted}>
          ↑ ↓ select · Enter confirm · Esc close
          {start + available < list.length ? ' · more below ↓' : ''}
        </Text>
      </>
    );
  }
  function loginContent() {
    const qrLines = qr.split('\n');
    const fits = qr && qrLines.length <= rows - 9 && qrLines[0].length <= columns - 8;
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <Text bold color={accent}>
          {state.linked && state.connection !== 'logged-out'
            ? 'Finishing WhatsApp login'
            : 'Link WhatsApp'}
        </Text>
        <Text color={muted}>
          {state.linked && state.connection !== 'logged-out'
            ? 'Restoring your linked session…'
            : 'WhatsApp → Linked devices → Link a device'}
        </Text>
        <Text> </Text>
        {state.pairingCode ? (
          <>
            <Text bold color={accent}>
              Pairing code: {state.pairingCode.match(/.{1,4}/g)?.join('-')}
            </Text>
            <Text>On your phone: Linked devices → Link a device → Link with phone number</Text>
          </>
        ) : fits ? (
          <Text color="black" backgroundColor="white">
            {qr}
          </Text>
        ) : qr ? (
          <Text color="yellow">
            QR needs {qrLines[0].length + 8} columns × {qrLines.length + 9} rows. Enlarge the
            terminal or press P.
          </Text>
        ) : (
          <Text color={muted}>
            {state.connection === 'logged-out'
              ? state.signedOut
                ? 'Logged out. Previous account archived. Press Q for a fresh QR.'
                : 'Session disconnected. Press Q to back up credentials and link again. Chat history is kept.'
              : state.linked
                ? 'QR accepted. Waiting for WhatsApp to finish connecting…'
                : 'Preparing your QR code…'}
          </Text>
        )}
        {(!state.linked || state.connection === 'logged-out') && (
          <>
            <Text> </Text>
            <Text color={accent}>
              {state.connection === 'logged-out'
                ? state.signedOut
                  ? '[Q] Link another account with QR'
                  : '[Q] Relink with a fresh QR (history is kept)'
                : '[Q] QR code (default)     [P] Pair with phone number'}
            </Text>
          </>
        )}
      </Box>
    );
  }
  const chatStart = Math.max(0, chatIndex - Math.floor((bodyHeight - 6) / 3) + 1);
  return (
    <Box width={columns} height={rows} flexDirection="column" paddingX={1}>
      <Box height={2} flexShrink={0} alignItems="center" justifyContent="space-between">
        <Text bold color={accent}>
          ◉ CHIRP{' '}
          <Text color={muted}>
            {' '}
            / {profile}
            {demo ? ' · DEMO' : ''}
          </Text>
        </Text>
        <Text color={state.connection === 'open' ? accent : 'yellow'}>
          ● {state.connection}
          <Text color={muted}>
            {columns >= 65 ? `  ${fit(safeText(state.user || ''), 25)}` : ''}
          </Text>
        </Text>
      </Box>
      {!modal && !loginVisible && (
        <Box height={2} flexShrink={0}>
          <Text
            bold
            color={section === 'chats' ? colors.badgeText : muted}
            backgroundColor={section === 'chats' ? accent : undefined}
          >
            {' '}
            Chats{columns >= 60 ? ` (${store.sectionCount('chats')})` : ''}{' '}
          </Text>
          <Text color={muted}> </Text>
          <Text
            bold
            color={section === 'channels' ? colors.badgeText : muted}
            backgroundColor={section === 'channels' ? accent : undefined}
          >
            {' '}
            Channels{columns >= 60 ? ` (${store.sectionCount('channels')})` : ''}{' '}
          </Text>
          <Text color={muted}>{columns >= 65 ? '  Ctrl+N switch' : ''}</Text>
        </Box>
      )}
      {syncVisible && (
        <SyncStatus
          state={state}
          messages={store.stats().messages}
          width={columns - 2}
          accent={accent}
          muted={muted}
        />
      )}
      {modal ? (
        <Box
          borderStyle="round"
          borderColor={accent}
          flexDirection="column"
          height={modalHeight}
          paddingX={2}
        >
          <Text bold color={accent}>
            {fit(safeText(modal.title), columns - 8)}
          </Text>
          <Text> </Text>
          {modalContent()}
        </Box>
      ) : loginVisible ? (
        loginContent()
      ) : (
        <Box flexGrow={1} minHeight={0}>
          {sidebar && (
            <Box
              width={sidebarWidth}
              flexDirection="column"
              borderStyle="round"
              borderColor={focus === 'chats' ? accent : border}
              paddingX={1}
            >
              <Text bold color={colors.text}>
                {section === 'channels' ? 'CHANNELS' : 'INBOX'}{' '}
                <Text color={accent}> · {filter}</Text>
              </Text>
              <Text color={muted}>
                {section === 'channels'
                  ? 'Ctrl+K · find a channel'
                  : 'Ctrl+K · find or start a chat'}
              </Text>
              <Text> </Text>
              {chats
                .slice(chatStart, chatStart + Math.floor((bodyHeight - 6) / 3))
                .map((chat, i) => (
                  <Box key={chat.jid} flexDirection="column" height={3}>
                    <Text
                      bold={chat.jid === jid || chat.unread > 0}
                      color={
                        chat.jid === jid || (focus === 'chats' && chatStart + i === chatIndex)
                          ? accent
                          : colors.text
                      }
                      backgroundColor={
                        chat.jid === jid || (focus === 'chats' && chatStart + i === chatIndex)
                          ? highlight
                          : undefined
                      }
                    >
                      {pad(
                        `${chat.jid === jid ? '›' : chat.jid.endsWith('@g.us') ? '#' : section === 'channels' ? '~' : '·'} ${chat.pinned ? '◆ ' : ''}${fit(chat.name, sidebarWidth - 8 - (chat.unread ? String(chat.unread).length + 2 : 0))}${chat.unread ? `  ${chat.unread}` : ''}`,
                        sidebarWidth - 4,
                      )}
                    </Text>
                    <Text color={muted} backgroundColor={chat.jid === jid ? highlight : undefined}>
                      {pad(
                        `  ${chat.preview || (chat.jid.endsWith('@g.us') ? 'Group chat' : 'Start a conversation')}`,
                        sidebarWidth - 4,
                      )}
                    </Text>
                  </Box>
                ))}
              <Box flexGrow={1} />
              <Text color={muted}>
                {chats.length} {section === 'channels' ? 'channels' : 'conversations'}
                {chats.length === 500 ? ' · search for more' : ''}
              </Text>
            </Box>
          )}
          <Box
            width={contentWidth - 2}
            marginLeft={sidebar ? 1 : 0}
            flexDirection="column"
            borderStyle="round"
            borderColor={focus === 'messages' ? accent : border}
            paddingX={1}
          >
            <Box justifyContent="space-between">
              <Text bold color={colors.text}>
                {jid
                  ? fit(store.name(jid), contentWidth - 22)
                  : section === 'channels'
                    ? 'Your channels'
                    : 'Your conversations'}{' '}
                <Text color={accent}>{jid ? state.presence[jid] || '' : ''}</Text>
              </Text>
              {contentWidth >= 50 && (
                <Text color={muted}>
                  {section === 'channels' ? 'CHANNEL' : jid?.endsWith('@g.us') ? 'GROUP' : 'CHAT'}
                </Text>
              )}
            </Box>
            <Text color={muted}>
              {jid
                ? `${store.count(jid).toLocaleString()} cached messages${offset ? ` · browsing history (${offset} back)` : ''}`
                : 'Private. Local. Keyboard first.'}
            </Text>
            {rows >= 20 && <Box height={1} />}
            {messages.length ? (
              messageRows
            ) : (
              <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
                <Text bold color={accent}>
                  {section === 'channels'
                    ? jid
                      ? 'No cached updates yet.'
                      : 'Your channels live here.'
                    : 'Stay in the flow.'}
                </Text>
                <Text color={muted}>
                  {section === 'channels'
                    ? 'Ctrl+K to select a synced channel'
                    : 'Ctrl+K to open a conversation'}
                </Text>
                <Text color={muted}>
                  {section === 'channels'
                    ? 'Ctrl+N returns to chats and groups'
                    : 'Ctrl+G for actions · /help for shortcuts'}
                </Text>
                {state.connection === 'open' && !chats.length && (
                  <Text color={muted}>Waiting for phone history sync…</Text>
                )}
              </Box>
            )}
            <Box flexGrow={1} />
          </Box>
        </Box>
      )}
      <Box height={1}>
        <Text color={busy ? 'yellow' : muted}>
          {fit(busy ? '◷ Working…' : notice || state.notice, columns - 2)}
        </Text>
      </Box>
      {reply && (
        <Text color={accent}>
          {fit(
            `↳ Replying to ${store.senderName(reply)}: ${reply.text.replace(/\n/g, ' ')} · Esc cancel`,
            columns - 2,
          )}
        </Text>
      )}
      {pastedImage && !modal && !loginVisible && (
        <Text color={accent}>
          {fit(
            `▧ Clipboard image · ${pastedImage.width}×${pastedImage.height} · Ctrl+P preview · Esc discard · Enter send`,
            columns - 2,
          )}
        </Text>
      )}
      {picker && (
        <EmojiSuggestions
          items={picker.items}
          index={picker.index}
          count={emojiRows}
          width={columns - 2}
          accent={accent}
          muted={muted}
          highlight={highlight}
        />
      )}
      {!loginVisible &&
        !modal &&
        (section === 'channels' ? (
          <Box borderStyle="round" borderColor={border} width={columns - 2} paddingX={1}>
            <Text color={muted}>
              {fit(
                'Channel updates · read-only · ↑ ↓ browse · Ctrl+P preview · Ctrl+G actions',
                columns - 6,
              )}
            </Text>
          </Box>
        ) : (
          <Composer
            value={value}
            cursor={cursor}
            active={focus === 'composer'}
            busy={busy}
            width={columns - 2}
            accent={accent}
            muted={muted}
            border={border}
            text={colors.text}
          />
        ))}
      <Box height={1}>
        <Text color={muted}>
          {fit(
            modal
              ? 'Dialog open · Esc close · Ctrl+Q quit'
              : loginVisible
                ? state.connection === 'logged-out'
                  ? state.signedOut
                    ? 'Q fresh QR → P phone pairing · Ctrl+Q quit'
                    : 'Q relink with QR · Ctrl+Q quit'
                  : state.linked
                    ? 'Finishing login · Ctrl+Q quit'
                    : 'Q QR login · P phone pairing · Ctrl+Q quit'
                : columns >= 110
                  ? 'Ctrl+G actions · Ctrl+K chats · Ctrl+F search · Ctrl+N pages · Ctrl+P preview · Ctrl+V paste · Ctrl+Q quit'
                  : columns >= 80
                    ? 'Ctrl+G actions · Ctrl+K chats · Ctrl+P preview · Ctrl+V paste · Ctrl+Q quit'
                    : 'Ctrl+G actions · Ctrl+Q quit',
            columns - 2,
          )}
        </Text>
      </Box>
    </Box>
  );
}
