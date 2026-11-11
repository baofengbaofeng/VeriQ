import { describe, it, expect } from 'vitest';
import { canonicalBytes, assetSourceBytes } from '../src/index.js';
import source from '../fixtures/asset-source.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import vectors from '../fixtures/canonical.json' with { type: 'json' };

describe('RFC8785 cross-language known vectors', () => {
  for (const [i, vector] of vectors.entries()) it(`vector ${i}`, () => {
    expect(new TextDecoder().decode(canonicalBytes(vector.value))).toBe(vector.canonical);
  });
  it('rejects lone surrogates', () => expect(() => canonicalBytes('\ud800')).toThrow());
});

it('source identity is stable across validation and publication adoption', () => {
  expect(createHash('sha256').update(assetSourceBytes(source.snapshot)).digest('hex')).toBe(source.sha256);
  const { validationTarget: _, ...published } = source.snapshot;
  expect(assetSourceBytes(published)).toEqual(assetSourceBytes(source.snapshot));
  expect(assetSourceBytes({...source.snapshot, sourceHash:'f'.repeat(64)})).toEqual(assetSourceBytes(source.snapshot));
  expect(assetSourceBytes({...source.snapshot, engineVersion:'9.0.0'})).not.toEqual(assetSourceBytes(source.snapshot));
});
