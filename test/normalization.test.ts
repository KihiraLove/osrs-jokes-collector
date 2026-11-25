import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError } from '../src/domain.ts';
import { normalizeJoke, normalizeName, normalizeThemes } from '../src/normalization.ts';

test('name normalization handles Unicode compatibility, whitespace and case consistently', () => {
  assert.deepEqual(normalizeName(' \uFEFFＳｌａｙｅｒ\u00a0 \t Jokes\u0085', 80), { name: 'Slayer Jokes', key: 'slayer jokes' });
  assert.deepEqual(normalizeThemes(['Slayer Jokes', ' slayer\tJOKES ', 'Élf']), [
    { name: 'Slayer Jokes', key: 'slayer jokes' }, { name: 'Élf', key: 'élf' },
  ]);
  assert.throws(() => normalizeName('\u0085\uFEFF', 80), ValidationError);
  assert.throws(() => normalizeName('a\0b', 80), ValidationError);
});

test('joke normalization keeps internal text and Unicode while rejecting invalid parts', () => {
  assert.deepEqual(normalizeJoke({ kind: 'two_part', text: '  A\n\n setup  ', punchline: '  🦀 Punchline!\n' }),
    { kind: 'two_part', text: 'A\n\n setup', punchline: '🦀 Punchline!' });
  assert.equal(normalizeJoke({ kind: 'single', text: '🦀'.repeat(4_000) }).text.length, 8_000);
  assert.throws(() => normalizeJoke({ kind: 'single', text: 'one', punchline: '' }), ValidationError);
  assert.throws(() => normalizeJoke({ kind: 'two_part', text: 'setup', punchline: '\u00a0\uFEFF' }), ValidationError);
  assert.throws(() => normalizeJoke({ kind: 'single', text: 'a'.repeat(4_001) }), ValidationError);
});
