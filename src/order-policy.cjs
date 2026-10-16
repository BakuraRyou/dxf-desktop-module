// Small CPU neural ranking policy. This is an Animatus prototype, not RL4CO or Nester.
const INPUTS = 10, HIDDEN = 16, PARAMETERS = HIDDEN * (INPUTS + 2);
function random(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function create(seed = 42) {
  const rng = random(seed);
  return { schemaVersion: 1, kind: 'animatus-order-policy-v1', weights: Array.from({ length: PARAMETERS }, () => (rng() - .5) * .2), trainedSteps: 0 };
}
function validate(model) {
  if (model?.schemaVersion !== 1 || model.kind !== 'animatus-order-policy-v1'
    || !Array.isArray(model.weights) || model.weights.length !== PARAMETERS
    || model.weights.some(x => !Number.isFinite(x) || Math.abs(x) > 100)
    || !Number.isInteger(model.trainedSteps) || model.trainedSteps < 0) throw new Error('Ungültiger Reihenfolge-Checkpoint');
  return model;
}
function features(blocks, width) {
  const local = blocks.map(b => {
    const w = Math.max(0, b.width) / width, h = Math.max(0, b.height) / width;
    const area = Math.max(0, b.area) / (width * width);
    return [Math.min(8, w), Math.min(8, h), Math.min(8, area), Math.min(1, area / Math.max(1e-9, w * h)),
      Math.tanh(Math.log(Math.max(1e-9, w) / Math.max(1e-9, h))), Math.min(8, w + h)];
  });
  const meanW = local.reduce((s, f) => s + f[0], 0) / Math.max(1, local.length);
  const meanH = local.reduce((s, f) => s + f[1], 0) / Math.max(1, local.length);
  return local.map(f => [...f, meanW, meanH, Math.min(8, blocks.length / 100), 1]);
}
function forward(model, input) {
  let score = 0;
  const gradient = new Array(PARAMETERS).fill(0);
  for (let h = 0; h < HIDDEN; h++) {
    const base = h * (INPUTS + 2);
    let z = model.weights[base + INPUTS];
    for (let i = 0; i < INPUTS; i++) z += model.weights[base + i] * input[i];
    const activation = Math.tanh(z), v = model.weights[base + INPUTS + 1];
    score += v * activation;
    const dz = v * (1 - activation * activation);
    for (let i = 0; i < INPUTS; i++) gradient[base + i] = dz * input[i];
    gradient[base + INPUTS] = dz;
    gradient[base + INPUTS + 1] = activation;
  }
  return { score, gradient };
}
function order(model, inputs, rng = null, withGradient = false) {
  const values = inputs.map(f => forward(model, f));
  if (!rng) return { order: values.map((_, i) => i).sort((a, b) => values[b].score - values[a].score || a - b) };
  const remaining = values.map((_, i) => i), result = [], gradient = new Array(PARAMETERS).fill(0);
  while (remaining.length) {
    const max = Math.max(...remaining.map(i => values[i].score));
    const probs = remaining.map(i => Math.exp(values[i].score - max));
    const sum = probs.reduce((a, b) => a + b, 0);
    let r = rng() * sum, choice = probs.length - 1;
    for (let j = 0; j < probs.length; j++) { r -= probs[j]; if (r < 0) { choice = j; break; } }
    const selected = remaining[choice];
    if (withGradient) for (let p = 0; p < PARAMETERS; p++) {
      gradient[p] += values[selected].gradient[p] - remaining.reduce((s, i, j) => s + probs[j] / sum * values[i].gradient[p], 0);
    }
    result.push(selected); remaining.splice(choice, 1);
  }
  return { order: result, gradient };
}
// REINFORCE with a leave-one-out baseline: reward is negative physical strip length.
function update(model, samples, learningRate = .01) {
  if (samples.length < 2 || samples.some(s => !(s.height > 0) || !Number.isFinite(s.height))) throw new Error('Mindestens zwei gültige Packversuche erforderlich');
  const mean = samples.reduce((s, v) => s + v.height, 0) / samples.length;
  const gradient = new Array(PARAMETERS).fill(0);
  for (const sample of samples) {
    const other = (mean * samples.length - sample.height) / (samples.length - 1);
    const advantage = Math.max(-1, Math.min(1, (other - sample.height) / mean));
    for (let p = 0; p < PARAMETERS; p++) gradient[p] += advantage * sample.gradient[p] / samples.length;
  }
  const norm = Math.hypot(...gradient), scale = Math.min(1, 1 / Math.max(1e-12, norm));
  model.weights = model.weights.map((v, p) => Math.max(-20, Math.min(20, v + learningRate * scale * gradient[p])));
  model.trainedSteps++;
  return model;
}
function candidates(model, inputs, count = 5, seed = 42) {
  const rng = random(seed), orders = [order(model, inputs).order];
  while (orders.length < count) orders.push(order(model, inputs, rng).order);
  return orders;
}
function validateDeployment(model) {
  validate(model);
  if (!model.trainedSteps || !(model.config?.width > 0) || model.config.rotation !== 180 || model.config.mirror !== false
    || !Number.isInteger(model.maxPieces) || model.maxPieces < 2 || model.maxPieces > 2000
    || !Number.isFinite(model.validation?.learnedMm) || !Number.isFinite(model.validation?.baselineMm)
    || model.validation.comparison !== 'five-heuristic-orders-v1') throw new Error('Checkpoint wurde noch nicht trainiert und bewertet');
  return model;
}
module.exports = { create, validate, validateDeployment, features, forward, order, update, candidates, random, PARAMETERS };
