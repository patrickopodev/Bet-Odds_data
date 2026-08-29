import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCompetition, competitionMix } from '../dist/competition.js';
import { buildPredictionQueries } from '../dist/research.js';

test('classifyCompetition maps names to the right match type', () => {
  assert.equal(classifyCompetition('Premier League'), 'league');
  assert.equal(classifyCompetition('LaLiga'), 'league');
  assert.equal(classifyCompetition('Serie A'), 'league');
  assert.equal(classifyCompetition('UEFA Champions League'), 'cup');
  assert.equal(classifyCompetition('FA Cup'), 'cup');
  assert.equal(classifyCompetition('Europa League'), 'cup'); // not caught by the "euro\b" international rule
  assert.equal(classifyCompetition('Copa del Rey'), 'cup');
  assert.equal(classifyCompetition('FIFA World Cup'), 'international');
  assert.equal(classifyCompetition('UEFA Euro'), 'international');
  assert.equal(classifyCompetition('Copa América'), 'international');
  assert.equal(classifyCompetition('Afcon'), 'international');
  assert.equal(classifyCompetition('Club Friendly'), 'friendly');
  assert.equal(classifyCompetition('Friendly'), 'friendly');
  assert.equal(classifyCompetition('Some Invitational Trophy'), 'cup'); // "trophy" is a cup/knockout
  assert.equal(classifyCompetition('Mystery Event'), 'other');
  assert.equal(classifyCompetition(null), 'other');
  assert.equal(classifyCompetition(''), 'other');
});

test('competitionMix summarises recent-result types', () => {
  const mix = competitionMix(['league', 'league', 'cup', 'friendly', 'international']);
  assert.equal(mix, 'Last 5: 2 league, 1 cup, 1 international, 1 friendly');
  assert.equal(competitionMix([]), 'no recent results');
});

test('buildPredictionQueries returns distinct prediction-focused queries', () => {
  const q = buildPredictionQueries('Arsenal', 'Chelsea', 'Premier League');
  assert.equal(q.length, 4);
  assert.ok(q.every((s) => s.includes('Arsenal') && s.includes('Chelsea')));
  assert.ok(q[0].includes('prediction'));
  assert.ok(q[1].includes('predicted score'));
  assert.ok(q[2].includes('betting tips'));
});
