import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

test('workspace classic scripts have no conflicting global declarations', async () => {
  const root = new URL('../public/', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)]
    .map(match => match[1])
    .filter(src => !src.startsWith('/') && !src.includes('://'));
  assert.ok(sources.includes('runtime.js'));
  const scripts = await Promise.all(sources.map(src => readFile(new URL(src, root), 'utf8')));
  // Classic scripts share a lexical scope, so checking each file alone misses
  // collisions between declarations in different script tags.
  assert.doesNotThrow(() => new Script(scripts.join('\n;\n')));
});
