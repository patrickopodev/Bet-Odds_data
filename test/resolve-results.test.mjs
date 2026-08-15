import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFeedEvents } from '../resolve-results.mjs';

const htmlWith = (feed) =>
  `<!doctype html><script>cjs.initialFeeds["summary-results"] = { data: \`${feed}\` }</script>`;

test('extractFeedEvents pulls the embedded summary-results feed', () => {
  const feed = 'AA÷123¬CX÷Hearts¬AF÷Benfica¬AB÷3~AA÷456¬CX÷X¬AF÷Y';
  const events = extractFeedEvents(htmlWith(feed), 'summary-results');
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { AA: '123', CX: 'Hearts', AF: 'Benfica', AB: '3' });
});

test('extractFeedEvents returns [] when feed is absent', () => {
  assert.equal(extractFeedEvents('<html>no feed here</html>', 'summary-results').length, 0);
});

test('extractFeedEvents only keeps blocks with an AA field', () => {
  const feed = 'CX÷Hearts¬AF÷Benfica~AA÷789';
  const events = extractFeedEvents(htmlWith(feed), 'summary-results');
  assert.equal(events.length, 1);
  assert.equal(events[0].AA, '789');
});