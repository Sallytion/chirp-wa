import React from 'react';
import { Box, Text } from 'ink';
import { fit } from './layout.js';

export interface Suggestion {
  key: string;
  label: string;
}
// Composer completions (emoji shortcodes and group mentions) above the input.
export function Suggestions({
  title,
  items,
  index,
  count,
  width,
  accent,
  muted,
  highlight,
}: {
  title: string;
  items: Suggestion[];
  index: number;
  count: number;
  width: number;
  accent: string;
  muted: string;
  highlight: string;
}) {
  const start = Math.max(0, Math.min(index - count + 1, items.length - count));
  return (
    <Box
      flexDirection="column"
      paddingX={2}
      height={Math.min(count, items.length) + 1}
      flexShrink={0}
    >
      <Text color={muted}>
        {fit(
          `${title} · ↑ ↓ select · Tab / Enter insert · Esc dismiss · ${index + 1}/${items.length}`,
          width - 4,
        )}
      </Text>
      {items.slice(start, start + count).map((item, i) => (
        <Text
          key={item.key}
          color={start + i === index ? accent : muted}
          backgroundColor={start + i === index ? highlight : undefined}
        >
          {fit(`${start + i === index ? '›' : ' '} ${item.label}`, width - 4)}
        </Text>
      ))}
    </Box>
  );
}
