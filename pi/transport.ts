import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** SDK connect failures close fire-and-forget; all callers must join that teardown and child exit. */
export function awaitTransportExit(transport: StdioClientTransport): void {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  const onclose = transport.onclose;
  transport.onclose = () => { exit(); onclose?.(); };
  const close = transport.close.bind(transport);
  let closing: Promise<void> | undefined;
  transport.close = () => {
    closing ??= (async () => {
      const spawned = transport.pid !== null;
      await close();
      // The SDK's final SIGKILL does not itself await exit. Its close event does.
      if (spawned) await exited;
    })();
    return closing;
  };
}
