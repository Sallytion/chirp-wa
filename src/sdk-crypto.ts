import { createHash, hkdfSync } from 'node:crypto';

// Same SHA-256 HKDF, MD5 and 16-bit LT-hash algorithms used by Baileys' JS
// implementation. Node's built-in crypto avoids loading the broad Rust WASM
// utility module for these four functions. Signal/AES/MAC verification stays
// in the SDK. See test/sdk-crypto.test.ts for parity checks against the bridge.
export function md5(buffer: Uint8Array): Uint8Array {
  return createHash('md5').update(buffer).digest();
}
export function hkdf(
  buffer: Uint8Array,
  length: number,
  options: { salt?: Uint8Array; info?: string } = {},
): Uint8Array {
  return new Uint8Array(
    hkdfSync('sha256', buffer, options.salt || new Uint8Array(), options.info || '', length),
  );
}
export function expandAppStateKeys(data: Uint8Array) {
  const expanded = hkdf(data, 160, { info: 'WhatsApp Mutation Keys' });
  return {
    indexKey: expanded.slice(0, 32),
    valueEncryptionKey: expanded.slice(32, 64),
    valueMacKey: expanded.slice(64, 96),
    snapshotMacKey: expanded.slice(96, 128),
    patchMacKey: expanded.slice(128, 160),
  };
}
export class LTHashAntiTampering {
  subtractThenAdd(base: Uint8Array, subtract: Uint8Array[], add: Uint8Array[]): Uint8Array {
    if (base.byteLength !== 128) throw new RangeError('LT hash must contain 128 bytes');
    const out = Uint8Array.from(base);
    const target = new DataView(out.buffer);
    for (const [items, sign] of [
      [subtract, -1],
      [add, 1],
    ] as const)
      for (const value of items) {
        const derived = hkdf(value, 128, { info: 'WhatsApp Patch Integrity' });
        const source = new DataView(derived.buffer, derived.byteOffset, derived.byteLength);
        for (let offset = 0; offset < 128; offset += 2)
          target.setUint16(
            offset,
            (target.getUint16(offset, true) + sign * source.getUint16(offset, true)) & 65535,
            true,
          );
      }
    return out;
  }
}
