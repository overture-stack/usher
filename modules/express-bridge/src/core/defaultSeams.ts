import { Agent, fetch as undiciFetch } from 'undici';

import { createChannel } from './channel.js';
import { createChannelAssertion } from './channelAssertion.js';
import { createChannelReader } from './channelReader.js';
import {
  type ControllerFetch,
  createFetchControllerClient,
} from './controllerClient.js';
import type { CoreSeams, SeamContext } from './core.js';
import { createTokenReader } from './tokenReader.js';

const assertionFor = ({
  configuration,
  keys,
}: SeamContext): (() => Promise<string>) =>
  createChannelAssertion({
    application: configuration.audience,
    assertionKey: keys.channelAssertionKey,
    wallClock: configuration.clocks.wall,
  });

/**
 * Supplies the controller client, token reader and revocation channel. The client and the channel
 * share one fetch: the one given, or undici's through an Agent owned here, created on first use
 * and released by `close`. Owning the Agent keeps a global dispatcher set by the host, or one
 * routing through a proxy, from carrying the credentials sent to the controller.
 *
 * @param options `fetch` reaches the controller in place of the owned Agent.
 */
export const defaultSeams = ({
  fetch,
}: { fetch?: ControllerFetch } = {}): CoreSeams => {
  const owned: { agent: Agent | undefined } = { agent: undefined };
  const bridgeFetch: ControllerFetch =
    fetch ??
    ((url, init) => {
      owned.agent ??= new Agent();
      return undiciFetch(url, { ...init, dispatcher: owned.agent });
    });

  return {
    close: async () => {
      const { agent } = owned;
      owned.agent = undefined;
      await agent?.close();
    },
    createChannel: (context) =>
      createChannel({
        assertion: assertionFor(context),
        controllerUrl: context.configuration.controllerUrl,
        core: context.core,
        deadlineMs: context.configuration.pollDeadlineMs,
        events: context.events,
        fetch: bridgeFetch,
        idleMs: context.configuration.pushIdleMs,
        intervalMs: context.configuration.pollIntervalMs,
        monotonicClock: context.configuration.clocks.monotonic,
        random: Math.random,
        reader: createChannelReader({
          noticeKey: context.keys.noticeKey,
          pollAnswerKey: context.keys.pollAnswerKey,
        }),
        recoveryIntervalMs: context.configuration.pollRecoveryIntervalMs,
        responseCapBytes: context.configuration.responseCapBytes,
      }),
    createControllerClient: (context) =>
      createFetchControllerClient({
        assertion: assertionFor(context),
        controllerUrl: context.configuration.controllerUrl,
        fetch: bridgeFetch,
        payloadVersions: context.configuration.payloadVersions,
        responseCapBytes: context.configuration.responseCapBytes,
      }),
    createTokenReader: ({ configuration, keys }) =>
      createTokenReader({
        audience: configuration.audience,
        issuer: configuration.issuer,
        payloadVersions: configuration.payloadVersions,
        tokenKey: keys.tokenKey,
        wallClock: configuration.clocks.wall,
      }),
  };
};
