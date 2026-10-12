// Reduce initial linear memory, preserving the original maximum and the
// engine's existing Emscripten memory.grow implementation.
const encode = (value) => {
  const bytes = [];
  do {
    const part = value & 127;
    value >>>= 7;
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
};
function number(bytes, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  do {
    const byte = bytes[cursor++];
    value |= (byte & 127) << shift;
    if (!(byte & 128)) break;
    shift += 7;
  } while (shift < 35);
  return { value: value >>> 0, next: cursor };
}
export function compactYoga(source) {
  const match = /data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/.exec(source);
  if (!match) throw new Error('Yoga no longer embeds its WASM binary');
  const wasm = Buffer.from(match[1], 'base64');
  if (!wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
    throw new Error('Invalid WASM header');
  for (let offset = 8; offset < wasm.length;) {
    const id = wasm[offset];
    const size = number(wasm, offset + 1);
    const end = size.next + size.value;
    if (id === 5) {
      const count = number(wasm, size.next);
      const flags = number(wasm, count.next);
      const initial = number(wasm, flags.next);
      if (count.value !== 1 || flags.value !== 1 || initial.value < 16)
        throw new Error('Unexpected Yoga memory declaration');
      const maximum = number(wasm, initial.next);
      if (maximum.value <= 16) throw new Error('Yoga must allow memory growth');
      const payload = Buffer.concat([
        wasm.subarray(size.next, flags.next),
        encode(16),
        wasm.subarray(initial.next, end),
      ]);
      const patched = Buffer.concat([
        wasm.subarray(0, offset + 1),
        encode(payload.length),
        payload,
        wasm.subarray(end),
      ]);
      if (!WebAssembly.validate(patched)) throw new Error('Invalid compact Yoga WASM');
      return {
        code: source.replace(match[1], patched.toString('base64')),
        original_bytes: initial.value * 65536,
        initial_bytes: 1048576,
        maximum_bytes: maximum.value * 65536,
      };
    }
    offset = end;
  }
  throw new Error('Yoga memory section missing');
}
