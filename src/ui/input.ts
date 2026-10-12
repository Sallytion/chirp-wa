import { useCallback, useEffect, useRef } from 'react';
import { useInput, useStdin } from 'ink';

export function isTerminalBackspace(sequence: string): boolean {
  return /^(?:\x1b)?[\x08\x7f]$/.test(sequence) || /^\x1b\[(?:8|127)(?=[:;u])/.test(sequence);
}

export function useTerminalInput(handler: Parameters<typeof useInput>[0]) {
  const { internal_eventEmitter } = useStdin();
  const sequence = useRef('');
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  // Ink removes the original sequence before calling useInput. Observe its parsed
  // input events first so legacy DEL Backspace stays distinct from CSI Delete.
  useEffect(() => {
    const capture = (data: string) => {
      sequence.current = data;
    };
    internal_eventEmitter.on('input', capture);
    return () => {
      internal_eventEmitter.off('input', capture);
    };
  }, [internal_eventEmitter]);
  const onInput = useCallback<Parameters<typeof useInput>[0]>((input, key) => {
    if (key.eventType === 'release') return;
    // Terminals can coalesce typed text and Backspace into one input chunk.
    if (!key.meta && !key.ctrl && /[\x08\x7f]/.test(input)) {
      for (const part of input.split(/([\x08\x7f])/).filter(Boolean)) {
        const backspace = isTerminalBackspace(part);
        handlerRef.current(backspace ? '' : part, { ...key, backspace, delete: false });
      }
      return;
    }
    const backspace = isTerminalBackspace(sequence.current);
    handlerRef.current(input, backspace ? { ...key, backspace: true, delete: false } : key);
  }, []);
  useInput(onInput);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// The composer stores its cursor in code points; boundaries keep emoji clusters
// (skin tones, flags, and joined families) intact when moving or deleting.
export function boundaries(value: string): number[] {
  const result = [0];
  for (const { segment } of segmenter.segment(value))
    result.push(result.at(-1)! + Array.from(segment).length);
  return result;
}
export function moveCursor(value: string, cursor: number, direction: -1 | 1): number {
  const points = boundaries(value);
  return direction < 0
    ? (points.findLast((point) => point < cursor) ?? 0)
    : (points.find((point) => point > cursor) ?? points.at(-1)!);
}
export function deleteAtCursor(
  value: string,
  cursor: number,
  backwards: boolean,
): { value: string; cursor: number } {
  const points = boundaries(value);
  const start = backwards
    ? moveCursor(value, cursor, -1)
    : (points.findLast((point) => point <= cursor) ?? 0);
  const end = backwards
    ? (points.find((point) => point >= cursor) ?? cursor)
    : moveCursor(value, cursor, 1);
  const chars = Array.from(value);
  chars.splice(start, end - start);
  return { value: chars.join(''), cursor: start };
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
export function moveWordCursor(value: string, cursor: number, direction: -1 | 1): number {
  const chars = Array.from(value);
  if (direction < 0) {
    const prefix = chars.slice(0, cursor).join('');
    const part = [...wordSegmenter.segment(prefix)].findLast((segment) => segment.segment.trim());
    return part ? Array.from(prefix.slice(0, part.index)).length : 0;
  }
  const suffix = chars.slice(cursor).join('');
  const part = [...wordSegmenter.segment(suffix)].find((segment) => segment.segment.trim());
  return part
    ? cursor + Array.from(suffix.slice(0, part.index + part.segment.length)).length
    : chars.length;
}
export function deleteWordAtCursor(
  value: string,
  cursor: number,
  backwards: boolean,
): { value: string; cursor: number } {
  const boundary = moveWordCursor(value, cursor, backwards ? -1 : 1);
  const chars = Array.from(value);
  const start = backwards ? boundary : cursor;
  const end = backwards ? cursor : boundary;
  chars.splice(start, end - start);
  return { value: chars.join(''), cursor: start };
}
