// Runs only in a disposable process: npm ci may replace every imported dependency.
import { checkGatewayUpdate } from './self-update.js';

const controller = new AbortController();
process.on('message', (message) => {
  if (message === 'abort') controller.abort(new Error('Gateway startup cancelled'));
});
process.on('disconnect', () => controller.abort(new Error('Gateway loader disconnected')));
process.send!('ready');
try {
  await new Promise<void>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(), { once: true });
    process.on('message', (message) => { if (message === 'start') resolve(); });
  });
  controller.signal.throwIfAborted();
  await checkGatewayUpdate(process.argv[2], true, controller.signal,
    (stage) => process.send?.({ stage }),
    (text, level) => process.send?.({ text, level }));
} catch (error) {
  process.send?.({ error: String(error) });
  process.exitCode = 1;
} finally {
  process.disconnect();
}
