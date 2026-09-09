// Fixture-only admission gate. This does not change the live coding server.
import assert from 'node:assert/strict';

export const EVALUATION_PROJECTS = Object.freeze([
  'discord-replay-buffer-settling',
  'discord-replay-provider-stream-errors',
  'discord-replay-vad-flap'
]);
const BUNDLES = Object.freeze({
  'discord-replay-buffer-settling': 'discord',
  'discord-replay-provider-stream-errors': 'discord-replay-speech-first',
  'discord-replay-vad-flap': 'discord-replay-speech-first'
});

export function selectValidationProjectIds(config) {
  if (config.evaluationProjects === undefined) return ['discord', 'production', 'praxis', 'discord-replay-speech-first'];
  assert.equal(config.release, 'coding-a41abbbbb51e', 'Batch validation requires the frozen release.');
  assert.ok(Array.isArray(config.evaluationProjects), 'Evaluation projects must be the fixed batch array.');
  assert.deepEqual([...config.evaluationProjects].sort(), [...EVALUATION_PROJECTS].sort(), 'Evaluation projects must contain each fixed batch project exactly once.');
  assert.ok(Array.isArray(config.projects), 'Registered projects are required.');
  for (const field of ['evaluationDependencyBundles', 'evaluationDependencyAdaptations']) {
    assert.ok(config[field] && typeof config[field] === 'object' && !Array.isArray(config[field]), 'Explicit evaluation dependency maps are required.');
    assert.deepEqual(Object.keys(config[field]).sort(), [...EVALUATION_PROJECTS].sort(), 'Dependency maps must describe exactly the fixed batch.');
  }
  for (const id of EVALUATION_PROJECTS) {
    assert.equal(config.projects.filter(project => project.id === id).length, 1, 'Each evaluation project must have exactly one registration.');
    const project = config.projects.find(value => value.id === id);
    assert.ok(Array.isArray(project.validationCommands) && project.validationCommands.length > 0 && project.validationCommands.length <= 4, 'Evaluation projects require bounded validation commands.');
    assert.equal(config.evaluationDependencyBundles[id], BUNDLES[id], 'Evaluation dependency bundle differs from the reviewed batch.');
    const description = config.evaluationDependencyAdaptations[id];
    assert.ok(typeof description === 'string' && description.trim().length > 0 && description.length <= 512, 'Dependency adaptation must be explicitly described.');
  }
  return [...config.evaluationProjects];
}
