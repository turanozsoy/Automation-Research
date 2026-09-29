/** Profile CLI against the fake Website B data dir (dev only): npm run profile:fake -- <command> */
process.env.SITE_B_CONFIG ??= 'config/site-b.fake.json';
process.env.DATA_DIR ??= 'data/fake';
await import('../scripts/profile.js');
