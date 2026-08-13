import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFeedBlock, normTeam, sameTeam, queryTeam } from '../lib/common.mjs';

test('decodeFeedBlock parses key/value feed blocks', () => {
  assert.deepEqual(decodeFeedBlock('AA÷123¬CX÷Hearts¬AF÷Benfica'), {
    AA: '123',
    CX: 'Hearts',
    AF: 'Benfica',
  });
  assert.deepEqual(decodeFeedBlock(''), {});
});

test('normTeam strips club tokens, particles, paren tags, and aliases', () => {
  assert.equal(normTeam('FC Barcelona'), 'barcelona');
  assert.equal(normTeam('Real Madrid CF'), 'realmadrid');
  assert.equal(normTeam('Benfica (Por)'), 'benfica');
  assert.equal(normTeam('Hearts (Sco)'), 'hearts');
  assert.equal(normTeam('Heart of Midlothian FC'), 'hearts');
  assert.equal(normTeam('Manchester United'), 'manchesterunited');
  assert.equal(normTeam('Man Utd'), 'manchesterunited');
  assert.equal(normTeam(null), '');
});

test('sameTeam accepts exact and containment matches, rejects short overlaps', () => {
  assert.equal(sameTeam('hearts', 'hearts'), true);
  assert.equal(sameTeam('inter', 'intermilan'), true);
  assert.equal(sameTeam('barcelona', 'barcelonafc'), true);
  assert.equal(sameTeam('ac', 'milanc'), false);
  assert.equal(sameTeam(null, 'barcelona'), false);
});

test('queryTeam returns spaced core tokens for the search API', () => {
  assert.equal(queryTeam('FC Dynamo Kyiv'), 'dynamo kyiv');
  assert.equal(queryTeam('Real Madrid CF'), 'real madrid');
});