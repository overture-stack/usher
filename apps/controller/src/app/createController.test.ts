import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect, createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { suite, test } from 'node:test';

import {
  type ControllerConfiguration,
  ENVIRONMENT_VARIABLES,
  readConfiguration,
} from '../configuration/index.js';
import { createController } from './createController.js';

const LOOPBACK = '127.0.0.1';

// A port nothing listens on at the moment of asking.
const unusedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

const acceptsConnection = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: LOOPBACK, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });

// A configuration whose store nothing answers for: every start fails at its first connection.
const unreachableStore = async (): Promise<ControllerConfiguration> =>
  readConfiguration({
    [ENVIRONMENT_VARIABLES.backChannelLogoutAudiences]: 'portal-test',
    [ENVIRONMENT_VARIABLES.cachePassword]: randomBytes(12).toString('hex'),
    [ENVIRONMENT_VARIABLES.cacheUrl]: 'redis://127.0.0.1:6379',
    [ENVIRONMENT_VARIABLES.cursorKey]: randomBytes(32).toString('base64url'),
    [ENVIRONMENT_VARIABLES.databasePassword]: randomBytes(12).toString('hex'),
    [ENVIRONMENT_VARIABLES.databaseSchema]: 'usher',
    [ENVIRONMENT_VARIABLES.databaseUrl]: `postgres://usher_controller@${LOOPBACK}:${await unusedPort()}/usher`,
    [ENVIRONMENT_VARIABLES.eventSource]: 'https://usher.example.org/controller',
    [ENVIRONMENT_VARIABLES.grantRateThreshold]:
      '{"operationCount":100,"windowSeconds":60}',
    [ENVIRONMENT_VARIABLES.host]: LOOPBACK,
    [ENVIRONMENT_VARIABLES.identityProviderIssuer]:
      'http://127.0.0.1:8080/realms/usher-test',
    [ENVIRONMENT_VARIABLES.instanceName]: 'usher-test-1',
    [ENVIRONMENT_VARIABLES.issuer]: 'https://usher.example.org',
    [ENVIRONMENT_VARIABLES.keyEncryptionKey]:
      randomBytes(32).toString('base64url'),
    [ENVIRONMENT_VARIABLES.managementAudience]: 'usher-management-test',
    [ENVIRONMENT_VARIABLES.managementClients]: 'usher-ui-test',
    [ENVIRONMENT_VARIABLES.port]: String(await unusedPort()),
    [ENVIRONMENT_VARIABLES.signInTokenMaximumLifetimeSeconds]: '3600',
  });

suite('a controller', () => {
  test('settles a stop when it never started, and settles it again', async () => {
    const controller = createController(await unreachableStore());

    await controller.stop();
    await controller.stop();
  });

  test('refuses a start once stopped', async () => {
    const controller = createController(await unreachableStore());
    await controller.stop();

    await assert.rejects(controller.start(), {
      message: 'a controller starts once, and never once stopped',
    });
  });

  test('fails a start on a store it cannot reach before anything listens, and stops after it', async () => {
    const configuration = await unreachableStore();
    const controller = createController(configuration);

    await assert.rejects(controller.start());
    const listening = await acceptsConnection(configuration.port);
    await controller.stop();

    assert.equal(listening, false);
  });
});
