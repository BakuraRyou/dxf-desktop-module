const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/order-policy.cjs');

test('neural score derivatives match finite differences', () => {
  const model = policy.create(42);
  const input = policy.features([{ width: 300, height: 600, area: 140000 }], 1400)[0];
  const { gradient } = policy.forward(model, input);
  for (let p = 0; p < policy.PARAMETERS; p++) {
    const old = model.weights[p], epsilon = 1e-5;
    model.weights[p] = old + epsilon; const plus = policy.forward(model, input).score;
    model.weights[p] = old - epsilon; const minus = policy.forward(model, input).score;
    model.weights[p] = old;
    assert.ok(Math.abs(gradient[p] - (plus - minus) / (2 * epsilon)) < 1e-7);
  }
});

test('shorter strips increase the probability of their sampled ordering', () => {
  const model = policy.create(7);
  const inputs = policy.features([{ width: 100, height: 800, area: 80000 }, { width: 600, height: 200, area: 120000 }], 1400);
  const rng = policy.random(4);
  const samples = Array.from({ length: 64 }, () => policy.order(model, inputs, rng, true));
  assert.ok(samples.some(s => s.order[0] === 0) && samples.some(s => s.order[0] === 1));
  const difference = () => policy.forward(model, inputs[0]).score - policy.forward(model, inputs[1]).score;
  const before = difference();
  policy.update(model, samples.map(s => ({ gradient: s.gradient, height: s.order[0] === 0 ? 1000 : 2000 })), .1);
  assert.ok(difference() > before, 'the rewarded order must become more probable');
  assert.equal(model.trainedSteps, 1);
});

test('seeded proposals retain every piece exactly once and are reproducible', () => {
  const model = policy.create(2);
  const inputs = policy.features(Array.from({ length: 105 }, (_, i) => ({ width: i + 1, height: 400, area: (i + 1) * 300 })), 1400);
  const proposals = policy.candidates(model, inputs, 5, 8);
  assert.deepEqual(proposals, policy.candidates(model, inputs, 5, 8));
  for (const order of proposals) assert.deepEqual(order.slice().sort((a, b) => a - b), Array.from({ length: 105 }, (_, i) => i));
});

test('untrained and malformed checkpoints cannot be deployed', () => {
  const model = policy.create();
  assert.throws(() => policy.validateDeployment(model));
  model.weights[0] = NaN;
  assert.throws(() => policy.validate(model));
  assert.throws(() => policy.update(policy.create(), [{ height: 0, gradient: [] }]));
});
