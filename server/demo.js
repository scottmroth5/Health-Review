// Starts the demo instance: npm run demo, then open http://localhost:5189. Made-up data only (data/demo/demo.db, built
// from demo/generate.js when missing); loads no .env, so no Google or Anthropic keys are in reach.
process.env.HEALTH_INSTANCE = 'demo';
await import('./index.js');
