// Frozen experiment choices. This describes the test, not model credentials.
export const OBSERVATION_SPEC = Object.freeze({
  version: 'shop-observation-v2',
  agents: Object.freeze({
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
    session: 'fresh-per-task',
    inheritConversation: false,
    useMemory: false,
    generateMemory: false,
    allowModelFallback: false,
    allowAdditionalAgents: false,
  }),
  isolation: Object.freeze({
    filesystem: 'container-per-task',
    visibleRepositories: 'own-task-checkout',
    collaboration: 'within-group-only',
    ownerCredentials: 'outside-agent-container',
    network: 'group-scoped-gateway',
    privateEvaluation: 'outside-agent-container',
  }),
  promises: [
    { id: 'pay-shown', statement: 'For a page request followed by a purchase of that product, with no intervening purchase, the buyer pays the displayed price.' },
    { id: 'demand-pricing', statement: 'Each successful purchase raises only that product’s next price by 5%, compounded and rounded to cents. A reset restores base prices.' },
    { id: 'cache-reuse', statement: 'Reuse a rendered page for repeated requests within 60 seconds while its product and price are unchanged. Refresh when the price changes or the cached page reaches 60 seconds.' },
    { id: 'order-record', statement: 'A successful purchase returns and records the product and the price actually paid. Unknown products return 404 and cannot create orders.' },
    { id: 'catalog-home', statement: 'The home page lists every catalog product, in catalog order, with a working product link and its current price. Each product page shows its name and price.' },
    { id: 'http-server', statement: 'createServer() returns an HTTP server which serves the shop; importing the module starts no server.' },
  ],
  arms: ['ordinary-git', 'matched-git', 'superpose'],
  codingSlots: 3,
  discoveryTasks: 6,
  pilotBlocks: 1,
  orderSeed: 14010,
  limits: { maxTurnsPerTask: 50, maxTaskAttempts: 1, taskMinutes: 15, runMinutes: 30, perTaskUsd: 0.50, pilotModelUsd: 9 },
  owner: { responseWindowSeconds: 30, requestsPerTask: 2, retryInfrastructureOnce: true, coaching: false },
  observation: { pollSeconds: 10, suspectedStallSeconds: 180, repeatedFailureCount: 3, updateSeconds: 60 },
});

export function productBrief() {
  return '# Product promises\n\n' + OBSERVATION_SPEC.promises.map((p) => `- **${p.id}:** ${p.statement}`).join('\n') +
    '\n\nThis small shop tests sequential purchases. Quotes held across another buyer’s purchase, payment providers, sessions and concurrent checkout are outside this experiment. Preserve the catalog, routes, five-percent price change and useful page caching.\n';
}

export function discoveryPlan(original) {
  const plan = structuredClone(original);
  plan.name = 'tiny-shop-observation';
  plan.description = 'Build the same shop with clear product promises and no pre-supplied executable pay-shown article.';
  plan.constitution = plan.constitution.filter((a) => a.key !== 'see-is-pay');
  const pages = plan.claims.find((c) => c.key === 'fast-pages');
  if (!pages) throw new Error('The shop plan must contain fast-pages');
  pages.statement = 'Product pages load fast and show a current price: cache a rendered product page for repeated requests while its product and price are unchanged and it is younger than 60 seconds; refresh it when its price changes or it reaches 60 seconds. Use src/cache.js. Export PAGE_TTL_MS = 60000, createProductPages({ ttlMs = PAGE_TTL_MS, now = Date.now, render = renderProduct }) returning { productPage, clear }, the shop’s productPage(id), and clearProductPages(). The clock and render function can be supplied to count renders and test expiry. Unknown products return null. test/pages.test.js covers these promises. The implementation is your choice.';
  return plan;
}

export function armOrder(seed = OBSERVATION_SPEC.orderSeed) {
  const arms = [...OBSERVATION_SPEC.arms];
  let state = seed >>> 0;
  for (let i = arms.length - 1; i > 0; i--) {
    state = (1664525 * state + 1013904223) >>> 0;
    const j = state % (i + 1);
    [arms[i], arms[j]] = [arms[j], arms[i]];
  }
  return arms;
}
