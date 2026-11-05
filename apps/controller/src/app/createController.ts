import type { AddressInfo } from 'node:net';

import type { ControllerConfiguration } from '../configuration/index.js';
import { createEventLog } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { openStore, prepareStore } from '../store/index.js';
import type { Controller } from './types.js';

interface Lifecycle {
  ready: boolean;
  started: Promise<{ url: URL }> | undefined;
  stopped: Promise<void> | undefined;
}

const isAddress = (address: unknown): address is AddressInfo =>
  typeof address === 'object' && address !== null && 'port' in address;

const urlOf = (address: unknown): URL => {
  if (isAddress(address)) {
    const host =
      address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return new URL(`http://${host}:${address.port}/`);
  }
  throw new Error('the controller listens on no TCP address');
};

/**
 * Creates a controller from its configuration, connecting to nothing until it starts. Its start
 * checks the store before anything listens, so a refused start never accepts a connection; its stop
 * closes the server, letting requests in flight finish, then the store's connections, and lets go of
 * the log stream. It reports itself ready while it is started and its log stream takes its lines.
 *
 * @param configuration the controller's configuration.
 */
export const createController = (
  configuration: ControllerConfiguration,
): Controller => {
  const lifecycle: Lifecycle = {
    ready: false,
    started: undefined,
    stopped: undefined,
  };
  const eventLog = createEventLog(configuration);
  const store = openStore(configuration, eventLog);
  const server = createServer({
    isReady: () => lifecycle.ready && eventLog.isWritable(),
  });

  const startOnce = async (): Promise<{ url: URL }> => {
    await prepareStore(store, configuration, eventLog);
    await server.listen({ host: configuration.host, port: configuration.port });
    lifecycle.ready = lifecycle.stopped === undefined;
    return { url: urlOf(server.server.address()) };
  };

  const stopOnce = async (): Promise<void> => {
    lifecycle.ready = false;
    await lifecycle.started?.catch(() => undefined);
    try {
      await server.close();
    } finally {
      try {
        await store.end();
      } finally {
        eventLog.close();
      }
    }
  };

  return {
    start: () => {
      if (lifecycle.started === undefined && lifecycle.stopped === undefined) {
        lifecycle.started = startOnce();
        return lifecycle.started;
      }
      return Promise.reject(
        new Error('a controller starts once, and never once stopped'),
      );
    },
    stop: () => {
      lifecycle.stopped ??= stopOnce();
      return lifecycle.stopped;
    },
  };
};
