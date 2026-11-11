import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

test('shared canonical source bytes run in a real browser without Node APIs', async ({ page }) => {
  await page.goto('/');
  const modulePath = '/@fs' + fileURLToPath(new URL('../../../packages/contracts/src/index.ts', import.meta.url));
  const result = await page.evaluate(async (modulePath) => {
    // Vite serves the workspace package as browser ESM; no crypto/Buffer polyfill.
    const contracts = await import(/* @vite-ignore */ modulePath);
    const bytes = contracts.canonicalBytes({z:-0,a:1.0});
    const source = contracts.assetSourceBytes({schemaVersion:'1.0',workspaceId:'test',engineVersion:'0.1.0',entryCaseVersionIds:[],assets:[],validationTarget:{revision:1}});
    return {canonical:new TextDecoder().decode(bytes), source:new TextDecoder().decode(source)};
  }, modulePath);
  expect(result.canonical).toBe('{"a":1,"z":0}');
  expect(JSON.parse(result.source)).not.toHaveProperty('validationTarget');
});
