import React from 'react';
import { Box, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { fit } from './layout.js';

export function composerLines(value: string, cursor: number, width: number): string[] {
  const chars = Array.from(value);
  const before = chars.slice(0, cursor).join('');
  const marked = before + '▌' + chars.slice(cursor).join('');
  const lines = wrapAnsi(marked, Math.max(10, width - 7), { hard: true, trim: false }).split('\n');
  const cursorLine =
    wrapAnsi(before, Math.max(10, width - 7), { hard: true, trim: false }).split('\n').length - 1;
  const visible = lines.slice(Math.max(0, cursorLine - 2), Math.max(3, cursorLine + 1));
  return visible;
}
export function Composer({
  value,
  cursor,
  active,
  busy,
  width,
  accent,
  muted = '#8499a9',
  border = '#304551',
  text = '#e5edf3',
}: {
  value: string;
  cursor: number;
  active: boolean;
  busy: boolean;
  width: number;
  accent: string;
  muted?: string;
  border?: string;
  text?: string;
}) {
  const visible = composerLines(value, cursor, width);
  return (
    <Box
      borderStyle="round"
      borderColor={active ? accent : border}
      paddingX={1}
      flexDirection="column"
      width={width}
    >
      <Text color={active ? accent : muted}>
        {busy ? '◷ ' : '› '}
        <Text color={value ? text : muted}>
          {value
            ? visible.join('\n')
            : fit(
                active
                  ? width >= 80
                    ? '▌ Message…  : emoji · / commands · Enter send'
                    : '▌ Message…  Enter send'
                  : 'Message…  Tab to compose',
                Math.max(10, width - 6),
              )}
        </Text>
      </Text>
    </Box>
  );
}
