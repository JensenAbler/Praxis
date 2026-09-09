import test from 'node:test';
import assert from 'node:assert/strict';
import { EVALUATION_PROJECTS, selectValidationProjectIds } from '../eval/project-selection.js';

function fixture() {
  return {
    release: 'coding-a41abbbbb51e', evaluationProjects: [...EVALUATION_PROJECTS],
    projects: EVALUATION_PROJECTS.map(id => ({ id, validationCommands: [['npm', 'test']] })),
    evaluationDependencyBundles: {
      'discord-replay-buffer-settling': 'discord',
      'discord-replay-provider-stream-errors': 'discord-replay-speech-first',
      'discord-replay-vad-flap': 'discord-replay-speech-first'
    },
    evaluationDependencyAdaptations: Object.fromEntries(EVALUATION_PROJECTS.map(id => [id, 'Explicit fixture adaptation.']))
  };
}

test('fixture selection retains the legacy project set when no evaluation batch is configured', () => {
  assert.deepEqual(selectValidationProjectIds({}), ['discord', 'production', 'praxis', 'discord-replay-speech-first']);
  assert.deepEqual(selectValidationProjectIds(fixture()), EVALUATION_PROJECTS);
});

test('fixture selection rejects missing, repeated, and unrelated batch projects', () => {
  for (const ids of [[], EVALUATION_PROJECTS.slice(1), [...EVALUATION_PROJECTS.slice(1), EVALUATION_PROJECTS[1]], [...EVALUATION_PROJECTS, 'production']]) {
    assert.throws(() => selectValidationProjectIds({ ...fixture(), evaluationProjects: ids }), /exactly once/);
  }
});

test('fixture selection rejects ambiguous registration and unreviewed dependency maps', () => {
  const duplicate = fixture(); duplicate.projects.push(duplicate.projects[0]);
  assert.throws(() => selectValidationProjectIds(duplicate), /exactly one registration/);
  const wrongBundle = fixture(); wrongBundle.evaluationDependencyBundles[EVALUATION_PROJECTS[0]] = 'praxis';
  assert.throws(() => selectValidationProjectIds(wrongBundle), /reviewed batch/);
  const missingNote = fixture(); delete missingNote.evaluationDependencyAdaptations[EVALUATION_PROJECTS[2]];
  assert.throws(() => selectValidationProjectIds(missingNote), /exactly the fixed batch/);
  const noCommands = fixture(); noCommands.projects[0].validationCommands = [];
  assert.throws(() => selectValidationProjectIds(noCommands), /validation commands/);
});
