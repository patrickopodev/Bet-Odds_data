import test from 'node:test';
import assert from 'node:assert/strict';
import { listMarkets, getMarket, registerMarket } from '../../engine/markets.mjs';

// Review action #3: the engine must model exactly five DISTINCT logical
// markets. 1X2 and O/U stay separate even though the scraper fetches them from
// one combined "1X2 / O/U" feed section.
test('five logical markets are modeled distinctly', () => {
  const markets = listMarkets();
  assert.equal(markets.length, 5);

  const ids = markets.map((m) => m.id).sort();
  assert.deepEqual(ids, ['1', '18', '41', '548', '551']);

  const names = new Set(markets.map((m) => m.name));
  assert.ok(names.has('1X2'), '1X2 present');
  assert.ok(names.has('O/U'), 'O/U present');

  const oneXtwo = getMarket('1');
  const ou = getMarket('18');
  assert.notEqual(oneXtwo.id, ou.id);
  assert.equal(oneXtwo.name, '1X2');
  assert.equal(ou.name, 'O/U');
});

test('a 6th market can only be added via registerMarket (no silent merge of 1X2/O/U)', () => {
  const before = listMarkets().length;
  const m = registerMarket({ id: '777', name: 'Corners', kind: 'totals', needsSpecifier: true });
  assert.equal(m.id, '777');
  assert.equal(listMarkets().length, before + 1);
  // The original five logical markets are untouched.
  assert.equal(getMarket('1').name, '1X2');
  assert.equal(getMarket('18').name, 'O/U');
});
