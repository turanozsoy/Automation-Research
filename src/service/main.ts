import { launchBrowser } from './browser.js';
import { loadConfig } from './config.js';
import { Timeline } from './timeline.js';
import { Workflow } from './workflow.js';
import { startServer } from './ws.js';

const port = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const tl = new Timeline();
  tl.mark('service starting', `target=${cfg.targetUrl}`);

  const bundle = await launchBrowser();
  tl.mark('Chromium launched', process.env.HEADLESS === '1' ? 'headless (test mode)' : 'visible');

  const wf = new Workflow(bundle, cfg, tl);
  await startServer(port, cfg, wf, tl);
  tl.mark('test page available', `http://localhost:${port}`);

  await wf.boot();

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`  Test page:  http://localhost:${port}`);
  console.log('  1. Log in / reach the target page in the Chromium window if needed.');
  console.log('  2. Press "Start automation" on the test page, or press Enter here.');
  console.log('────────────────────────────────────────────────────────────\n');

  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      if (chunk.includes('\n') || chunk.includes('\r')) void wf.start();
    });
  }

  const shutdown = async () => {
    tl.mark('shutting down');
    await bundle.browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
