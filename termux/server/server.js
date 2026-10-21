// Command-line entry point: `npm start`. The Windows tray app (desktop/) runs app.js directly.
import { startServer } from './app.js';

try {
  const server = await startServer();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => { await server.close(); process.exit(0); });
  }
} catch (e) {
  if (e.code === 'no-token') console.error('JARVIS_TOKEN is missing or still the example value. Run scripts/setup-windows.bat or edit server/.env.');
  else console.error('Could not start Jarvis:', e.message);
  process.exit(1);
}
