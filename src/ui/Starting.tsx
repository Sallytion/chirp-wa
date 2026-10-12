import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { useTerminalInput } from './input.js';
import { palette } from './theme.js';

export function Starting({
  profile,
  theme,
  onQuit,
}: {
  profile: string;
  theme: 'dark' | 'light';
  onQuit: () => void;
}) {
  const { stdout } = useStdout();
  const colors = palette(theme);
  useTerminalInput((input, key) => {
    if (key.ctrl && ['c', 'q'].includes(input)) onQuit();
  });
  return (
    <Box
      width={stdout.columns || 120}
      height={stdout.rows || 36}
      flexDirection="column"
      paddingX={1}
    >
      <Box height={2}>
        <Text bold color={colors.accent}>
          ◉ CHIRP <Text color={colors.muted}> / {profile}</Text>
        </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
        <Text bold color={colors.accent}>
          ◷ Opening your conversations…
        </Text>
        <Text color={colors.muted}>Loading cached chats · checking for updates</Text>
      </Box>
      <Text color={colors.muted}>Ctrl+Q quit</Text>
    </Box>
  );
}
