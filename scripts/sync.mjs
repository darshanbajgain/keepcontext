// Run one GitHub sync from the command line (or a cron job): npm run sync
import { syncGithub } from '../src/github.js';
try {
  const r = await syncGithub();
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
} catch (e) {
  console.error('Sync failed:', e.message);
  process.exit(1);
}
