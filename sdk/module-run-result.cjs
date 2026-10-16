// Electron invoke reports rejected handlers as errors, including intentional
// cancellation. Transport that expected outcome as worker-protocol data instead.
async function moduleRunResult(task) {
  try { return await task; }
  catch (error) {
    if (error?.code === 'ERR_MODULE_CANCELLED') return { type: 'stopped' };
    throw error;
  }
}
module.exports = { moduleRunResult };
