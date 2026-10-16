const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DXF_SEARCH_MS = 24 * 60 * 60 * 1000;

function moduleRunTimeout(moduleId, operation, input) {
  const budget = input?.extreme?.timeBudgetMs;
  if (moduleId !== 'dxf-packing' || !/^(pack|poly)(-[a-z]+)?-v2$/.test(operation)
      || input?.useRealBounding !== true || !Number.isFinite(budget)
      || budget < 100 || budget > MAX_DXF_SEARCH_MS) return DEFAULT_TIMEOUT_MS;
  // Allow preparation and final validation without cutting off the chosen search.
  return Math.max(DEFAULT_TIMEOUT_MS, Math.ceil(budget) + 60 * 1000);
}

module.exports = { moduleRunTimeout };
