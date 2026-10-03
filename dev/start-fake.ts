/** Starts the service against the local fake Website B config (dev only). Run `npm run fake-b` first. */
process.env.SITE_B_CONFIG ??= 'config/site-b.fake.json';
process.env.DATA_DIR ??= 'data/fake';
process.env.STRICT_ACCOUNT_EGRESS ??= '0'; // the fake stack runs accounts without a proxy directly; set STRICT_ACCOUNT_EGRESS=1 to test strict mode
await import('../src/service/main.js');
