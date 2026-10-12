import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { compactYoga } from '../../scripts/yoga-memory.mjs';

const result = compactYoga(
  readFileSync('node_modules/yoga-layout/dist/binaries/yoga-wasm-base64-esm.js', 'utf8'),
);
writeFileSync('benchmarks/yoga-compact-validation.mjs', result.code);
const { default: load } = await import('../yoga-compact-validation.mjs');
const yoga = await load();
assert.equal(yoga.HEAPU8.length, 1048576);
const allocations = [];
for (const size of [3 * 1048576, 20 * 1048576]) {
  const ptr = yoga._malloc(size);
  assert.ok(ptr > 0);
  assert.ok(yoga.HEAPU8.length >= ptr + size);
  yoga.HEAPU8[ptr] = 7;
  yoga.HEAPU8[ptr + size - 1] = 9;
  assert.equal(yoga.HEAPU8[ptr], 7);
  assert.equal(yoga.HEAPU8[ptr + size - 1], 9);
  allocations.push({ bytes: size, heap_bytes: yoga.HEAPU8.length });
  yoga._free(ptr);
}
const validation = {
  initial_bytes: result.initial_bytes,
  previous_initial_bytes: result.original_bytes,
  maximum_bytes: result.maximum_bytes,
  allocations,
};
writeFileSync('benchmarks/yoga-validation.json', JSON.stringify(validation, null, 2));
console.log(JSON.stringify(validation));
