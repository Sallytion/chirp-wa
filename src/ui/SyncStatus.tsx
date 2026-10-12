import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { ClientState } from '../types.js';
import { fit } from './layout.js';

export function syncLabel(state: ClientState): string {
  const sync = state.sync;
  if (!sync) return '';
  if (state.connection !== 'open') return 'Connecting · checking for chat updates…';
  const chats = sync.chats === 'waiting' || sync.chats === 'syncing';
  const contacts = sync.contacts === 'syncing' || sync.contacts === 'waiting';
  const progress =
    state.historyProgress != null && state.historyProgress < 100
      ? ` · ${Math.max(0, Math.min(100, state.historyProgress))}%`
      : '';
  if (chats && contacts) return `Syncing chats & contacts…${progress}`;
  if (chats)
    return `${sync.chats === 'waiting' ? 'Catching up on chats…' : 'Syncing chats…'}${progress}`;
  if (contacts) return 'Syncing contact names…';
  if (sync.chats === 'paused') return 'Chat sync paused · cached conversations are available';
  if (sync.contacts === 'error') return 'Contact sync failed · try /sync-contacts';
  return sync.contacts === 'synced' ? 'Sync complete' : 'Chats up to date';
}

export function SyncStatus({
  state,
  messages,
  width,
  accent,
  muted,
}: {
  state: ClientState;
  messages: number;
  width: number;
  accent: string;
  muted: string;
}) {
  const label = syncLabel(state);
  const active =
    state.connection !== 'open' ||
    ['waiting', 'syncing'].includes(state.sync?.chats || '') ||
    ['waiting', 'syncing'].includes(state.sync?.contacts || '');
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % 4), 180);
    return () => clearInterval(timer);
  }, [active]);
  const warning = state.sync?.chats === 'paused' || state.sync?.contacts === 'error';
  return (
    <Box height={1} flexShrink={0}>
      <Text color={warning ? 'yellow' : active ? accent : muted}>
        {active ? ['◐', '◓', '◑', '◒'][frame] : warning ? '!' : '✓'}{' '}
      </Text>
      <Text color={active ? accent : muted}>
        {fit(
          `${label} · ${messages.toLocaleString()} cached messages${active && state.connection === 'open' ? ' · keep chatting' : ''}`,
          width - 2,
        )}
      </Text>
    </Box>
  );
}
