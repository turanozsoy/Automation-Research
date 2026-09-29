/** Starts the service against the local fake Website B config (dev only). Run `npm run fake-b` first. */
process.env.SITE_B_CONFIG ??= 'config/site-b.fake.json';
await import('../src/service/main.js');
