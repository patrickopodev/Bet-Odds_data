import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegex, verifySlipLoaded, stakeRegistered, isPlacementSuccess, isPlacementFailure, parseOddsChanges, oddsChangesAcceptable } from '../stake-autoplace.mjs';

test('escapeRegex escapes RegExp metacharacters', () => {
  assert.equal(escapeRegex('AC Milan'), 'AC Milan');
  assert.equal(escapeRegex('Nykoebing FC'), 'Nykoebing FC');
  assert.equal(escapeRegex('A.B+C (U19)'), 'A\\.B\\+C \\(U19\\)');
  // Unescaped, '.' matches any char (AXB passes); escaped, only the literal.
  assert.equal(new RegExp('A.B').test('AXB'), true);
  assert.equal(new RegExp(escapeRegex('A.B')).test('AXB'), false);
  assert.equal(new RegExp(escapeRegex('A.B')).test('A.B'), true);
});

test('verifySlipLoaded passes when every leg appears on the page', () => {
  const legs = [
    { homeTeam: 'Hearts', awayTeam: 'Benfica' },
    { homeTeam: 'Real Madrid', awayTeam: 'Atletico Madrid' },
  ];
  const pageText = 'Hearts vs Benfica - 18:45\nReal Madrid vs Atletico Madrid - 20:00';
  assert.equal(verifySlipLoaded(pageText, legs), true);
});

test('verifySlipLoaded is case-insensitive and whitespace-tolerant', () => {
  const legs = [{ homeTeam: 'AC Milan', awayTeam: 'Inter' }];
  assert.equal(verifySlipLoaded('ac milan  vs  inter', legs), true);
});

test('verifySlipLoaded fails when a team is missing', () => {
  const legs = [{ homeTeam: 'Hearts', awayTeam: 'Benfica' }];
  assert.equal(verifySlipLoaded('Benfica only on this page', legs), false);
  assert.equal(verifySlipLoaded(null, legs), false);
});

test('verifySlipLoaded matches substring team names (loose)', () => {
  const legs = [{ homeTeam: 'Real', awayTeam: 'Betis' }];
  assert.equal(verifySlipLoaded('Real Sociedad vs Betis', legs), true); // "Real" is contained
  const exact = [{ homeTeam: 'Atletico Madrid', awayTeam: 'Real Betis' }];
  assert.equal(verifySlipLoaded('Atletico Madrid vs Real Betis', exact), true);
});

test('stakeRegistered matches the normalized field text', () => {
  assert.equal(stakeRegistered('GHS 12.50', '12.50'), true);
  assert.equal(stakeRegistered('12.50', '12.50'), true);
  assert.equal(stakeRegistered('12.5', '12.5'), true);
  assert.equal(stakeRegistered('GHS 12.50', '12.4'), false);
  assert.equal(stakeRegistered('', '12.50'), false);
  assert.equal(stakeRegistered(null, '12.50'), false);
});

test('isPlacementSuccess only accepts the success toast', () => {
  assert.equal(isPlacementSuccess('Bet Successful'), true);
  assert.equal(isPlacementSuccess('Your bet was placed: Bet Successful'), true);
  assert.equal(isPlacementSuccess('bet successful'), true);
  assert.equal(isPlacementSuccess('Bet Failed'), false); // a failure, not a success toast
  assert.equal(isPlacementSuccess(''), false);
  assert.equal(isPlacementSuccess(null), false);
});

test('isPlacementFailure detects definite failure signals only', () => {
  assert.equal(isPlacementFailure('Insufficient balance'), true);
  assert.equal(isPlacementFailure('Bet Failed'), true);
  assert.equal(isPlacementFailure('place bet failed, please retry'), true);
  assert.equal(isPlacementFailure('An error occurred'), true);
  // No failure message on the page -> NOT a definite failure (money may have moved).
  assert.equal(isPlacementFailure(''), false);
  assert.equal(isPlacementFailure(null), false);
  // A success toast is not a failure.
  assert.equal(isPlacementFailure('Bet Successful'), false);
});

test('parseOddsChanges extracts old->new pairs from dialog text', () => {
  assert.deepEqual(parseOddsChanges('Over 2.5 1.85 → 1.60'), [{ from: 1.85, to: 1.6 }]);
  assert.deepEqual(parseOddsChanges('Home 2.10 -> 1.95'), [{ from: 2.1, to: 1.95 }]);
  assert.deepEqual(parseOddsChanges('Away 3.20 => 3.00'), [{ from: 3.2, to: 3 }]);
  // Multiple changes in one dialog.
  assert.deepEqual(parseOddsChanges('Over 2.5 1.85 → 1.60\nUnder 2.5 2.05 → 2.30'), [
    { from: 1.85, to: 1.6 },
    { from: 2.05, to: 2.3 },
  ]);
  // No arrow pair -> nothing parsed.
  assert.deepEqual(parseOddsChanges('Odds have changed for this selection'), []);
  assert.deepEqual(parseOddsChanges(''), []);
  assert.deepEqual(parseOddsChanges(null), []);
});

test('oddsChangesAcceptable refuses any leg drifting below its minOdds', () => {
  const legs = [
    { odds: 1.85, minOdds: 1.7 },
    { odds: 2.05, minOdds: 1.9 },
  ];
  // Both changes still at/above their floors.
  assert.equal(oddsChangesAcceptable(legs, [{ from: 1.85, to: 1.75 }, { from: 2.05, to: 2.0 }]), true);
  // One leg drops below its floor -> refuse.
  assert.equal(oddsChangesAcceptable(legs, [{ from: 1.85, to: 1.6 }, { from: 2.05, to: 2.0 }]), false);
});

test('oddsChangesAcceptable refuses unmatched and unparseable changes', () => {
  const legs = [{ odds: 1.85, minOdds: 1.7 }];
  // Change whose previous odds matches no leg -> refuse (can't verify the floor).
  assert.equal(oddsChangesAcceptable(legs, [{ from: 9.99, to: 9.5 }]), false);
  // Dialog present but no pairs parsed -> refuse rather than accept blind.
  assert.equal(oddsChangesAcceptable(legs, []), false);
  // Leg without minOdds accepts any rise but refuses a drop to zero-ish? No:
  // missing floor means floor 0, so any positive new odds is acceptable.
  assert.equal(oddsChangesAcceptable([{ odds: 1.85 }], [{ from: 1.85, to: 1.6 }]), true);
});