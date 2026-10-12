import React from 'react';
import { Box, Text } from 'ink';
import type { EmojiSuggestion } from '../emoji.js';
import { fit } from './layout.js';

export function EmojiSuggestions({
  items,
  index,
  count,
  width,
  accent,
  muted,
  highlight,
}: {
  items: EmojiSuggestion[];
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
          `Emoji · ↑ ↓ select · Tab / Enter insert · Esc dismiss · ${index + 1}/${items.length}`,
          width - 4,
        )}
      </Text>
      {items.slice(start, start + count).map((item, i) => (
        <Text
          key={item.emoji}
          color={start + i === index ? accent : muted}
          backgroundColor={start + i === index ? highlight : undefined}
        >
          {fit(
            `${start + i === index ? '›' : ' '} ${item.emoji}  :${item.shortcode}:  ${item.label}`,
            width - 4,
          )}
        </Text>
      ))}
    </Box>
  );
}
