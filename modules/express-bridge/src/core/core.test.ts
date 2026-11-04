import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { suite, test, type TestContext } from 'node:test';

import {
  type CategoryCondition,
  type CategoryName,
  type Enforcement,
  type KeyRegistration,
  type ParsedRecordNarrowing,
  type PermissionsPayload,
  REGISTRATION_RULES,
  type RecordKeyRegistration,
  UsherContractError,
  type UsherPrincipal,
  type UsherRequestAccess,
  parseRecordNarrowing,
  resultFor,
  validatePayload,
} from '@overture-stack/usher-types';

import type { BridgeConfiguration } from './configuration.js';
import {
  CONFIGURATION_DEFAULTS,
  START_REFUSAL_RULES,
} from './configuration.js';
import type { ChannelCore } from './channel.js';
import {
  type BridgeCore,
  type ChannelContext,
  CORE_RULES,
  type CoreSeams,
  createBridgeCoreWithSeams,
  type ExchangeAnswer,
  type TokenReading,
} from './core.js';
import { defaultSeams } from './defaultSeams.js';
import { importApplicationKey, subjectTag } from './keys.js';
import { compileKey, renderKey } from './rendering.js';
import { mintUsherToken } from './testTokens.js';

/** The subject of a principal whose grants hold, or `undefined` for a principal in any other state. */
const subjectInForce = (principal: UsherPrincipal): string | undefined =>
  principal.credential === 'confirmed' && !principal.suspended
    ? principal.subject
    : undefined;

const corpus = JSON.parse(
  readFileSync(
    new URL(
      '../../../../.dev/design/conformance/principals.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { principals: readonly { case: string; payload: unknown }[] };

const payloadFor = (caseNumber: string): PermissionsPayload => {
  const entry = corpus.principals.find(
    (principal) => principal.case === caseNumber,
  );
  const result = validatePayload(entry?.payload);
  assert.ok(result.success, `case ${caseNumber} is a valid payload`);
  return result.payload;
};

/** A corpus payload stamped with a subject of its own, since the signed-in cases share one. */
const signedIn = (caseNumber: string, sub: string): PermissionsPayload => ({
  ...payloadFor(caseNumber),
  sub,
});

const ANONYMOUS = payloadFor('02');
const ISSUED_AT_MS = ANONYMOUS.iat * 1000;
const LIFETIME_MS = (ANONYMOUS.exp - ANONYMOUS.iat) * 1000;

/** The principal of a request presenting no credential. */
const NO_CREDENTIAL = Object.freeze({
  credential: 'none',
  openTierOnly: true,
  suspended: false,
});

/** The principal served for an unconfirmed credential: suspended, and naming no subject. */
const UNCONFIRMED = Object.freeze({
  credential: 'unconfirmed',
  openTierOnly: true,
  suspended: true,
});

/**
 * The principal served for `subject-ana`'s confirmed credential while suspended, naming that
 * subject for attribution alone.
 */
const ANA_SUSPENDED = Object.freeze({
  attributionOnlySubject: 'subject-ana',
  credential: 'confirmed',
  openTierOnly: true,
  suspended: true,
});

const KEY = Buffer.alloc(32, 7).toString('base64url');

/** A subject's tag, computed apart from the core, as the controller computes it for a notice. */
const tagFor = async (subject: string): Promise<string> =>
  subjectTag(await importApplicationKey(KEY), subject);

const inCondition = (
  fieldName: string,
  value: readonly string[],
): CategoryCondition => ({
  content: { fieldName, value: [...value] },
  op: 'in',
});

const COMMUNITY_GOVERNED = inCondition('data_category', ['community-governed']);
const CONTROLLED = inCondition('data_category', ['controlled']);

const catalogue: RecordKeyRegistration = {
  categories: {
    global: {
      'global.community-governed': COMMUNITY_GOVERNED,
      'global.controlled': CONTROLLED,
    },
  },
  kind: 'record',
  resourceFieldName: 'study_id',
};

/** What a record key's narrowing says, read back, or a failure when the result is not one. */
const narrowingIn = (
  enforcement: Enforcement | undefined,
): ParsedRecordNarrowing => {
  const parsed =
    enforcement?.kind === 'narrow'
      ? parseRecordNarrowing(enforcement.sqon)
      : undefined;

  if (parsed?.success) {
    return parsed.narrowing;
  }

  return assert.fail('expected a narrowing that reads back');
};

/** A corpus payload in which HEART_STUDY offers `resource.pilot`, a category of its own. */
const offeringPilot = (payload: PermissionsPayload): PermissionsPayload => ({
  ...payload,
  resourceCategories: {
    ...payload.resourceCategories,
    HEART_STUDY: ['resource.pilot'],
  },
});

const segment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A three-part signed sign-in token with a placeholder signature, since only the controller checks
 * signatures.
 */
const signInToken = (claims: { exp?: number; sub?: string }): string =>
  `${segment({ alg: 'RS256' })}.${segment(claims)}.c2lnbmF0dXJl`;

interface LoggedEvent {
  data: Record<string, unknown>;
  severity: string;
  type: string;
}

type Scripted =
  ExchangeAnswer | ((signal: AbortSignal) => Promise<ExchangeAnswer>);

const harnessParts = () => {
  const clocks = { monotonic: 0, wall: ISSUED_AT_MS };
  const logged: LoggedEvent[] = [];
  const record = (object: object): void => {
    const { data, severity, type } = object as LoggedEvent;
    logged.push({ data, severity, type: type.replace('bio.overture.', '') });
  };
  const answers = new Map<string | null, Scripted>([
    [null, { kind: 'token', token: 'token:anonymous' }],
  ]);
  const exchanges: (string | null)[] = [];
  const readings = new Map<string, TokenReading>([
    ['token:anonymous', { kind: 'payload', payload: ANONYMOUS }],
  ]);

  const configuration: BridgeConfiguration = {
    audience: `audience-${Math.random()}`,
    controllerUrl: 'https://usher.example.org/',
    eventSource: 'https://search.example.org/usher-bridge',
    issuer: 'https://usher.example.org',
    key: KEY,
    logger: { error: record, info: record, warn: record },
    monotonicClock: { now: () => clocks.monotonic },
    payloadVersions: [1],
    wallClock: { now: () => clocks.wall },
  };

  /** The core's channel-facing members, captured from the channel seam's context. */
  const channel: { core: ChannelCore | undefined } = { core: undefined };

  const seams = {
    createChannel: (context: ChannelContext) => {
      channel.core = context.core;
      return { start: () => undefined, stop: () => Promise.resolve() };
    },
    createControllerClient: () => ({
      exchange: ({
        credential,
        signal,
      }: {
        credential: string | null;
        signal: AbortSignal;
      }): Promise<ExchangeAnswer> => {
        exchanges.push(credential);
        const answer = answers.get(credential) ?? { kind: 'refused' };
        return typeof answer === 'function'
          ? answer(signal)
          : Promise.resolve(answer);
      },
    }),
    createTokenReader: () => ({
      read: (token: string): Promise<TokenReading> =>
        Promise.resolve(
          readings.get(token) ?? { kind: 'rejected', reason: 'unexpected' },
        ),
    }),
    random: () => 0,
  };

  /** Scripts the controller to answer a credential with a token carrying the payload. */
  const issue = (credential: string, payload: PermissionsPayload): void => {
    const token = `token:${credential}`;
    answers.set(credential, { kind: 'token', token });
    readings.set(token, { kind: 'payload', payload });
  };

  return {
    advanceMonotonic: (ms: number) => {
      clocks.monotonic += ms;
    },
    advanceWall: (ms: number) => {
      clocks.wall += ms;
    },
    answers,
    configuration,

    /** Confirms a check as the channel does, through the core's channel-facing members. */
    confirm: (checkStartedAt: number): void => {
      channel.core?.confirmChannel(checkStartedAt);
    },

    events: (type: string) => logged.filter((event) => event.type === type),
    exchanges,
    issue,
    readings,
    seams,
  };
};

type Harness = ReturnType<typeof harnessParts> & { core: BridgeCore };

/** A harness with its core in normal mode. */
const running = async (
  registrations: Readonly<Record<string, KeyRegistration>> = {
    files: catalogue,
  },
  configure: (configuration: BridgeConfiguration) => BridgeConfiguration = (
    configuration,
  ) => configuration,
): Promise<Harness> => {
  const parts = harnessParts();
  const core = createBridgeCoreWithSeams(
    configure(parts.configuration),
    parts.seams,
  );
  core.register(registrations);
  await core.start();
  parts.confirm(0);
  await core.refreshAnonymous();
  assert.equal(core.mode(), 'normal');
  return { ...parts, core };
};

const exchangesOf = (harness: Harness, credential: string): number =>
  harness.exchanges.filter((sent) => sent === credential).length;

const accessOf = async (
  core: BridgeCore,
  credential: string | null,
): Promise<UsherRequestAccess> => {
  const outcome = await core.resolve(credential);
  assert.equal(outcome.kind, 'access', `expected access, got ${outcome.kind}`);
  return outcome.kind === 'access'
    ? outcome.access
    : assert.fail('unreachable');
};

const resultsFor = (payload: PermissionsPayload) => ({
  files: renderKey(
    payload,
    compileKey(catalogue),
    CONFIGURATION_DEFAULTS.filterClauseLimit,
  ).enforcement,
});

suite('createBridgeCoreWithSeams', () => {
  suite('register', () => {
    test('refuses a second call, since cached results were rendered from the first', () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });

      assert.throws(
        () => core.register({ files: catalogue }),
        UsherContractError,
      );
    });

    test("positions each refusal under its catalogue's key, across every catalogue registered", () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);

      const refusal = (() => {
        try {
          core.register({
            files: { ...catalogue, resourceFieldName: '' },
            notes: 'not a registration' as never,
            samples: catalogue,
          });
          return undefined;
        } catch (error: unknown) {
          return error;
        }
      })();

      assert.ok(refusal instanceof UsherContractError);
      assert.deepEqual(
        refusal.problems?.map(({ position }) => position),
        ['files.resourceFieldName', 'notes'],
      );
      assert.equal(
        JSON.stringify(refusal.problems).includes('data_category'),
        false,
      );
    });

    test('brackets a catalogue key holding a dot, for a problem inside its registration and for one at its root', () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);

      const refusal = (() => {
        try {
          core.register({
            'files.v2': { ...catalogue, resourceFieldName: '' },
            'notes.v2': 'not a registration' as never,
          });
          return undefined;
        } catch (error: unknown) {
          return error;
        }
      })();

      assert.ok(refusal instanceof UsherContractError);
      assert.deepEqual(
        refusal.problems.map(({ position }) => position),
        ['["files.v2"].resourceFieldName', '["notes.v2"]'],
      );
    });

    test("refuses an artifact key with the artifact rule, positioned at its kind under its catalogue's key", () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);

      const refusal = (() => {
        try {
          core.register({
            files: catalogue,
            sets: {
              kind: 'artifact',
              provenanceFieldName: 'provenance',
              resources: ['HEART_STUDY'],
            } as never,
          });
          return undefined;
        } catch (error: unknown) {
          return error;
        }
      })();

      assert.ok(refusal instanceof UsherContractError);
      assert.deepEqual(refusal.problems, [
        { position: 'sets.kind', rule: REGISTRATION_RULES.artifactKind },
      ]);
    });

    test('refuses a registration whose condition breaks its grammar, naming its category but no field or value', () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);

      const refusal = (() => {
        try {
          core.register({
            files: {
              ...catalogue,
              categories: {
                global: {
                  'global.controlled': {
                    content: {
                      fieldName: 'data_category',
                      value: ['set_id:secret-cohort'],
                    },
                    op: 'in',
                  },
                },
              },
            },
          });
          return undefined;
        } catch (error: unknown) {
          return error;
        }
      })();

      assert.ok(refusal instanceof UsherContractError);
      assert.ok(
        refusal.problems.every(({ position }) =>
          position.startsWith('files.categories.global["global.controlled"]'),
        ),
        JSON.stringify(refusal.problems),
      );
      assert.equal(
        ['data_category', 'secret-cohort'].some((content) =>
          JSON.stringify(refusal.problems).includes(content),
        ),
        false,
      );
    });

    for (const [description, registrations] of [
      ['no key at all', {}],
      ['an empty key', { '': catalogue }],
      ['a key named __proto__', JSON.parse('{"__proto__": {"kind": "open"}}')],
    ] as const) {
      test(`refuses ${description}`, () => {
        const parts = harnessParts();
        const core = createBridgeCoreWithSeams(
          parts.configuration,
          parts.seams,
        );

        assert.throws(
          () => core.register(registrations as never),
          UsherContractError,
        );
      });
    }

    test("keeps its own copy, leaving the adapter's object unfrozen and untouched by later changes", async () => {
      const handedValues = ['controlled'];
      const handed = {
        files: {
          ...catalogue,
          categories: {
            global: {
              ...catalogue.categories.global,
              'global.controlled': {
                content: { fieldName: 'data_category', value: handedValues },
                op: 'in',
              },
            },
          },
        } satisfies RecordKeyRegistration,
      };
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register(handed);
      await core.start();
      parts.confirm(0);
      await core.refreshAnonymous();

      handedValues[0] = 'mutated';
      const access = await accessOf(core, null);

      assert.equal(Object.isFrozen(handed.files), false);
      assert.deepEqual(access.results, resultsFor(ANONYMOUS));
      await core.stop();
    });
  });

  suite('start', () => {
    test('refuses to start before register, with fixed text, and stays cold', async () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);

      await assert.rejects(core.start(), {
        message: START_REFUSAL_RULES.notRegistered,
      });

      assert.equal(core.mode(), 'cold');
      assert.deepEqual(parts.events('bridge.startRefusal')[0]?.data, {
        actorId: null,
        actorType: 'system',
        reason: 'notRegistered',
      });
    });

    test('refuses a configuration by the rule it breaks, never by its value', async () => {
      const parts = harnessParts();
      const badKey = `${KEY.slice(0, 42)}B`;
      const core = createBridgeCoreWithSeams(
        { ...parts.configuration, key: badKey },
        parts.seams,
      );
      core.register({ files: catalogue });

      const error = await core.start().then(
        () => assert.fail('expected a refusal'),
        (thrown: unknown) => thrown,
      );

      assert.ok(error instanceof UsherContractError);
      assert.equal(error.message, START_REFUSAL_RULES.keyUnusable);
      assert.equal(
        JSON.stringify(parts.events('bridge.startRefusal')).includes(badKey),
        false,
      );
    });

    test('refuses a numeric setting out of range by a problem positioned at its name, never by its value, and stays cold', async () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(
        { ...parts.configuration, pollIntervalMs: 999, pushIdleMs: 999 },
        parts.seams,
      );
      core.register({ files: catalogue });

      const error = await core.start().then(
        () => assert.fail('expected a refusal'),
        (thrown: unknown) => thrown,
      );

      assert.ok(error instanceof UsherContractError);
      assert.equal(error.message, START_REFUSAL_RULES.numberOutOfRange);
      assert.deepEqual(error.problems, [
        {
          position: 'pollIntervalMs',
          rule: START_REFUSAL_RULES.numberOutOfRange,
        },
      ]);
      assert.equal(JSON.stringify(error.problems).includes('999'), false);
      assert.deepEqual(
        parts.events('bridge.startRefusal').map(({ data }) => data),
        [{ actorId: null, actorType: 'system', reason: 'numberOutOfRange' }],
      );
      assert.equal(core.mode(), 'cold');
    });

    test('refuses every payload version listed that the token reader cannot read, positioning each by its index, and stays cold', async () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(
        { ...parts.configuration, payloadVersions: [2, 1, 3] },
        parts.seams,
      );
      core.register({ files: catalogue });

      const error = await core.start().then(
        () => assert.fail('expected a refusal'),
        (thrown: unknown) => thrown,
      );

      assert.ok(error instanceof UsherContractError);
      assert.equal(error.message, START_REFUSAL_RULES.payloadVersionUnreadable);
      assert.deepEqual(error.problems, [
        {
          position: 'payloadVersions[0]',
          rule: START_REFUSAL_RULES.payloadVersionUnreadable,
        },
        {
          position: 'payloadVersions[2]',
          rule: START_REFUSAL_RULES.payloadVersionUnreadable,
        },
      ]);
      assert.deepEqual(
        parts.events('bridge.startRefusal').map(({ data }) => data),
        [
          {
            actorId: null,
            actorType: 'system',
            reason: 'payloadVersionUnreadable',
          },
        ],
      );
      assert.equal(core.mode(), 'cold');
      assert.deepEqual(parts.exchanges, []);
      await core.stop();
    });

    const SEAM_DEFECT = 'a defect in a seam';
    const throwsDefect = (): never => {
      throw new Error(SEAM_DEFECT);
    };

    for (const [description, failing] of [
      [
        'the controller client',
        (seams: CoreSeams): CoreSeams => ({
          ...seams,
          createControllerClient: throwsDefect,
        }),
      ],
      [
        'the token reader',
        (seams: CoreSeams): CoreSeams => ({
          ...seams,
          createTokenReader: throwsDefect,
        }),
      ],
      [
        'the revocation channel',
        (seams: CoreSeams): CoreSeams => ({
          ...seams,
          createChannel: throwsDefect,
        }),
      ],
    ] as const) {
      test(`refuses to start when building ${description} throws, by the rule alone, and stays cold`, async () => {
        const parts = harnessParts();
        const core = createBridgeCoreWithSeams(
          parts.configuration,
          failing(parts.seams),
        );
        core.register({ files: catalogue });

        const error = await core.start().then(
          () => assert.fail('expected a refusal'),
          (thrown: unknown) => thrown,
        );

        assert.ok(error instanceof UsherContractError);
        assert.equal(error.message, START_REFUSAL_RULES.startDefect);
        assert.deepEqual(error.problems, []);
        assert.deepEqual(
          parts.events('bridge.startRefusal').map(({ data }) => data),
          [{ actorId: null, actorType: 'system', reason: 'startDefect' }],
        );
        assert.equal(core.mode(), 'cold');
        assert.deepEqual(parts.exchanges, []);
        await core.stop();
      });
    }

    test('refuses to start when the revocation channel throws as it starts, stopping the part it started before the refusal settles', async () => {
      const parts = harnessParts();
      const order: string[] = [];
      const core = createBridgeCoreWithSeams(parts.configuration, {
        ...parts.seams,
        createChannel: () => ({
          start: () => {
            order.push('channel started in part');
            throw new Error(SEAM_DEFECT);
          },
          stop: async () => {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            order.push('channel stopped');
          },
        }),
      });
      core.register({ files: catalogue });

      const error = await core.start().then(
        () => assert.fail('expected a refusal'),
        (thrown: unknown) => {
          order.push('start refused');
          return thrown;
        },
      );

      assert.ok(error instanceof UsherContractError);
      assert.equal(error.message, START_REFUSAL_RULES.startDefect);
      assert.deepEqual(order, [
        'channel started in part',
        'channel stopped',
        'start refused',
      ]);
      assert.deepEqual(
        parts.events('bridge.startRefusal').map(({ data }) => data),
        [{ actorId: null, actorType: 'system', reason: 'startDefect' }],
      );
      assert.equal(core.mode(), 'cold');
      assert.deepEqual(parts.exchanges, []);
      await core.stop();
    });

    test('frees the audience once a start refused for a seam that throws has settled, so a successor starts', async () => {
      const parts = harnessParts();
      const failed = createBridgeCoreWithSeams(parts.configuration, {
        ...parts.seams,
        createTokenReader: throwsDefect,
      });
      failed.register({ files: catalogue });
      const successor = createBridgeCoreWithSeams(
        parts.configuration,
        parts.seams,
      );
      successor.register({ files: catalogue });

      await assert.rejects(failed.start(), {
        message: START_REFUSAL_RULES.startDefect,
      });
      await successor.start();

      await Promise.all([failed.stop(), successor.stop()]);
    });

    test('refuses a second bridge for one audience while the first runs, and starts one once it stops', async () => {
      const first = await running();
      const second = createBridgeCoreWithSeams(
        first.configuration,
        first.seams,
      );
      second.register({ files: catalogue });

      await assert.rejects(second.start(), {
        message: START_REFUSAL_RULES.audienceInUse,
      });
      await first.core.stop();
      const third = createBridgeCoreWithSeams(first.configuration, first.seams);
      third.register({ files: catalogue });
      await third.start();

      await third.stop();
    });

    test('logs catalogue.resourceListMissing at start for each record key registering an empty resource list', async () => {
      const harness = await running({
        empty: { ...catalogue, resources: [] },
        files: catalogue,
        listed: { ...catalogue, resources: ['HEART_STUDY'] },
        open: { kind: 'open' },
      });

      assert.deepEqual(
        harness
          .events('catalogue.resourceListMissing')
          .map(({ data }) => data['catalogue'])
          .toSorted(),
        ['empty'],
      );
      await harness.core.stop();
    });

    test('names a probable key mismatch when the startup token fails decryption, and stays cold', async () => {
      const parts = harnessParts();
      parts.readings.set('token:anonymous', {
        kind: 'rejected',
        reason: 'decryptionFailed',
      });
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });

      await core.start();

      assert.equal(core.mode(), 'cold');
      assert.deepEqual(
        parts.events('token.rejection').map(({ data }) => data['reason']),
        ['decryptionFailed'],
      );
      assert.deepEqual(
        parts
          .events('revocationChannel.modeChange')
          .map(({ data }) => data['reason']),
        ['probableKeyMismatch'],
      );
      await core.stop();
    });

    test('names a probable key mismatch when the controller refuses the startup assertion', async () => {
      const parts = harnessParts();
      parts.answers.set(null, {
        cause: 'assertionRefused',
        kind: 'unavailable',
      });
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });

      await core.start();

      assert.deepEqual(
        parts.events('token.exchangeFailure').map(({ data }) => data['cause']),
        ['assertionRefused'],
      );
      assert.deepEqual(
        parts
          .events('revocationChannel.modeChange')
          .map(({ data }) => data['reason']),
        ['probableKeyMismatch'],
      );
      await core.stop();
    });

    test('uses an anonymous payload fetched before the first check only as the self-test, and fetches it again once checked', async () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });

      await core.start();
      const afterStart = core.mode();
      parts.confirm(0);
      const beforeRefetch = core.mode();
      await core.refreshAnonymous();

      assert.equal(afterStart, 'cold');
      assert.equal(beforeRefetch, 'cold');
      assert.deepEqual(parts.exchanges, [null, null]);
      assert.equal(core.mode(), 'normal');
      await core.stop();
    });
  });

  suite('the startup order, and failures around it', () => {
    /** Lets every callback already queued run. */
    const settled = (): Promise<void> =>
      new Promise((resolve) => {
        setImmediate(resolve);
      });

    const withoutHeartStudy: PermissionsPayload = {
      ...ANONYMOUS,
      permissions: Object.fromEntries(
        Object.entries(ANONYMOUS.permissions).filter(
          ([resource]) => resource !== 'HEART_STUDY',
        ),
      ),
      resourceCategories: Object.fromEntries(
        Object.entries(ANONYMOUS.resourceCategories).filter(
          ([resource]) => resource !== 'HEART_STUDY',
        ),
      ),
    };

    test('never keeps a payload whose fetch began before the first check, even when the check lands mid-fetch', async () => {
      const parts = harnessParts();
      const held = { release: (): void => undefined };
      const sent = { count: 0 };
      parts.answers.set(null, () => {
        sent.count += 1;
        return sent.count === 1
          ? new Promise((resolve) => {
              held.release = () =>
                resolve({ kind: 'token', token: 'token:early' });
            })
          : Promise.resolve({ kind: 'token', token: 'token:anonymous' });
      });
      parts.readings.set('token:early', {
        kind: 'payload',
        payload: withoutHeartStudy,
      });
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });

      const starting = core.start();
      for (const _ of Array.from({ length: 100 })) {
        if (sent.count === 0) {
          await settled();
        }
      }
      parts.confirm(0);
      held.release();
      await starting;
      await settled();
      await settled();

      const access = await accessOf(core, null);
      assert.equal(sent.count, 2);
      assert.deepEqual(access.results, resultsFor(ANONYMOUS));
      await core.stop();
    });

    test('starts, logs the failure and retries when the controller client throws on the anonymous fetch', async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const parts = harnessParts();
      parts.answers.set(null, () => Promise.reject(new Error('a defect')));
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });

      await core.start();
      parts.confirm(0);
      await settled();
      parts.answers.set(null, { kind: 'token', token: 'token:anonymous' });
      context.mock.timers.tick(30_000);
      await settled();

      assert.deepEqual(
        parts.events('bridge.internalError').map(({ data }) => data['stage']),
        ['refreshAnonymous', 'refreshAnonymous'],
      );
      assert.equal(core.mode(), 'normal');
      await core.stop();
    });

    test("starts, keeps retrying and raises no unhandled rejection when the host's logger throws as each failed anonymous fetch is logged", async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      context.after(() => {
        process.off('unhandledRejection', onUnhandled);
      });
      const parts = harnessParts();
      const log = (): void => {
        throw new Error('a defect in the host logger');
      };
      parts.answers.set(null, () => Promise.reject(new Error('a defect')));
      const core = createBridgeCoreWithSeams(
        {
          ...parts.configuration,
          logger: { error: log, info: log, warn: log },
        },
        parts.seams,
      );
      core.register({ files: catalogue });

      const started = await core.start().then(
        () => 'started',
        (error: unknown) => error,
      );
      parts.confirm(0);
      await settled();
      context.mock.timers.tick(30_000);
      await settled();
      parts.answers.set(null, { kind: 'token', token: 'token:anonymous' });
      context.mock.timers.tick(30_000);
      await settled();

      assert.equal(started, 'started');
      assert.deepEqual(unhandled, []);
      assert.equal(parts.exchanges.filter((sent) => sent === null).length, 4);
      assert.equal(core.mode(), 'normal');
      await core.stop();
    });

    test('schedules nothing once stopped, even for a fetch still running when it stopped', async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const harness = await running();
      const held = { release: (): void => undefined };
      harness.answers.set(
        null,
        () =>
          new Promise((resolve) => {
            held.release = () =>
              resolve({ kind: 'token', token: 'token:anonymous' });
          }),
      );
      const refreshing = harness.core.refreshAnonymous();
      await settled();

      const stopping = harness.core.stop();
      held.release();
      await refreshing;
      await stopping;
      const afterStop = harness.exchanges.length;
      context.mock.timers.tick(LIFETIME_MS * 10);
      await settled();

      assert.equal(harness.exchanges.length, afterStop);
    });

    test('refuses a second start', async () => {
      const harness = await running();

      await assert.rejects(harness.core.start(), {
        message: CORE_RULES.startOnce,
      });
      await harness.core.stop();
    });

    test('refuses a start after a stop that came before any start', async () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });

      await core.stop();

      await assert.rejects(core.start(), { message: CORE_RULES.startOnce });
    });
  });

  suite('the reviewed edges', () => {
    const settled = (): Promise<void> =>
      new Promise((resolve) => {
        setImmediate(resolve);
      });

    test('stays stopped when stopped during start, starting no fetch and leaving the audience free', async () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });

      const starting = core.start();
      await core.stop();
      await starting;
      parts.confirm(0);
      await settled();
      const next = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      next.register({ files: catalogue });
      await next.start();

      assert.equal(core.mode(), 'cold');
      assert.deepEqual(await core.resolve(null), { kind: 'unavailable' });
      assert.deepEqual(parts.exchanges, [null]);
      await next.stop();
    });

    test('sends no further anonymous exchange once stopped, even after a self-test that was still running', async () => {
      const parts = harnessParts();
      const held = { release: (): void => undefined };
      parts.answers.set(
        null,
        () =>
          new Promise((resolve) => {
            held.release = () =>
              resolve({ kind: 'token', token: 'token:anonymous' });
          }),
      );
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });

      const starting = core.start();
      for (const _ of Array.from({ length: 100 })) {
        if (parts.exchanges.length === 0) {
          await settled();
        }
      }
      parts.confirm(0);
      const stopping = core.stop();
      held.release();
      await starting;
      await stopping;
      await settled();

      assert.deepEqual(parts.exchanges, [null]);
    });

    test('serves a grant answered after the grace period lapsed as the suspended open tier, naming its subject for attribution alone', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      const held = { release: (): void => undefined };
      harness.readings.set('token:ana', {
        kind: 'payload',
        payload: signedIn('05', 'subject-ana'),
      });
      harness.answers.set(
        credential,
        () =>
          new Promise((resolve) => {
            held.release = () => resolve({ kind: 'token', token: 'token:ana' });
          }),
      );
      harness.advanceMonotonic(59_000);

      const resolving = harness.core.resolve(credential);
      await settled();
      harness.advanceMonotonic(3_000);
      held.release();
      const outcome = await resolving;

      assert.equal(outcome.kind, 'access');
      assert.deepEqual(
        outcome.kind === 'access' ? outcome.access.principal : undefined,
        ANA_SUSPENDED,
      );
      await harness.core.stop();
    });

    test('answers unavailable to a grant answered after the bridge turned cold', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      const held = { release: (): void => undefined };
      harness.readings.set('token:ana', {
        kind: 'payload',
        payload: signedIn('05', 'subject-ana'),
      });
      harness.answers.set(
        credential,
        () =>
          new Promise((resolve) => {
            held.release = () => resolve({ kind: 'token', token: 'token:ana' });
          }),
      );
      harness.answers.set(null, { cause: 'network', kind: 'failed' });
      harness.core.applyNotice({ cursor: 'c-1', kind: 'baseline', v: 1 });
      harness.advanceMonotonic(59_000);

      const resolving = harness.core.resolve(credential);
      await settled();
      harness.advanceMonotonic(3_000);
      held.release();

      assert.deepEqual(await resolving, { kind: 'unavailable' });
      assert.equal(harness.core.mode(), 'cold');
      await harness.core.stop();
    });

    test('logs an anonymous exchange the controller refuses, as a failure by status', async () => {
      const harness = await running();
      harness.answers.set(null, { kind: 'refused' });

      const refreshed = await harness.core.refreshAnonymous();

      assert.equal(refreshed, false);
      assert.deepEqual(
        harness
          .events('token.exchangeFailure')
          .map(({ data }) => data['cause']),
        ['status'],
      );
      await harness.core.stop();
    });

    test('hands neither seam the application key, which it holds only as imported keys', async () => {
      const parts = harnessParts();
      const contexts: unknown[] = [];
      const core = createBridgeCoreWithSeams(parts.configuration, {
        ...parts.seams,
        createControllerClient: (context) => {
          contexts.push(context);
          return parts.seams.createControllerClient();
        },
        createTokenReader: (context) => {
          contexts.push(context);
          return parts.seams.createTokenReader();
        },
      });
      core.register({ files: catalogue });
      await core.start();

      assert.equal(contexts.length, 2);
      assert.equal(JSON.stringify(contexts).includes(KEY), false);
      await core.stop();
    });

    test(
      'ends an exchange at its timeout even when the client never answers, serving the suspended open tier',
      { timeout: 10_000 },
      async (context) => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        const harness = await running();
        const credential = signInToken({ sub: 'subject-ana' });
        harness.answers.set(credential, () => new Promise(() => undefined));

        const resolving = harness.core.resolve(credential);
        await settled();
        context.mock.timers.tick(5_000);
        const outcome = await resolving;

        assert.deepEqual(
          outcome.kind === 'access' ? outcome.access.principal : outcome,
          UNCONFIRMED,
        );
        assert.deepEqual(
          harness
            .events('token.exchangeFailure')
            .map(({ data }) => data['cause']),
          ['timeout'],
        );
        await harness.core.stop();
      },
    );

    for (const [description, key] of [
      ['started', KEY],
      ['refused for its key', 'not-a-key'],
    ] as const) {
      test(`reads the host's configuration no more once start has taken it, ${description}`, async () => {
        const parts = harnessParts();
        const reads: { afterStart: string[]; started: boolean } = {
          afterStart: [],
          started: false,
        };
        const watched = new Proxy(
          { ...parts.configuration, key },
          {
            get: (target, member, receiver) => {
              if (reads.started) {
                reads.afterStart.push(String(member));
              }
              return Reflect.get(target, member, receiver) as unknown;
            },
          },
        );
        const core = createBridgeCoreWithSeams(watched, parts.seams);
        core.register({ files: catalogue });

        await core.start().catch(() => undefined);
        reads.started = true;
        core.report('credential.malformed', { reason: 'multiple' });
        await core.resolve(null);
        await core.stop();

        assert.deepEqual(reads.afterStart, []);
        assert.equal(parts.events('credential.malformed').length, 1);
      });
    }

    test('offers a host no way to record a check, which only the channel may do', async () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });
      await core.start();

      const members = Object.keys(core).toSorted();
      await core.stop();

      assert.equal(members.includes('confirmChannel'), false);
      assert.deepEqual(members, [
        'applyNotice',
        'mode',
        'refreshAnonymous',
        'register',
        'report',
        'reset',
        'resolve',
        'start',
        'stop',
      ]);
    });

    test("builds the revocation channel once at start, driving the core's own members, and stops it with the core", async () => {
      const parts = harnessParts();
      const built: {
        contexts: ChannelContext[];
        started: number;
        stopped: number;
      } = { contexts: [], started: 0, stopped: 0 };
      const core = createBridgeCoreWithSeams(parts.configuration, {
        ...parts.seams,
        createChannel: (context) => {
          built.contexts.push(context);
          return {
            start: () => {
              built.started += 1;
            },
            stop: async () => {
              built.stopped += 1;
            },
          };
        },
      });
      core.register({ files: catalogue });

      await core.start();
      const before = core.mode();
      built.contexts[0]?.core.confirmChannel(0);
      await core.refreshAnonymous();
      const after = core.mode();
      await core.stop();

      assert.equal(built.contexts.length, 1);
      assert.deepEqual([built.started, built.stopped], [1, 1]);
      assert.deepEqual([before, after], ['cold', 'normal']);
    });

    test("logs the layer's own events through the core, before start as well as after", async () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);

      core.report('credential.malformed', { reason: 'multiple' });
      core.register({ files: catalogue });
      await core.start();
      core.report('bridge.internalError', { stage: 'attach' });

      assert.deepEqual(
        [
          ...parts.events('credential.malformed'),
          ...parts.events('bridge.internalError'),
        ].map(({ data }) => data),
        [
          { actorId: null, actorType: 'anonymous', reason: 'multiple' },
          { actorId: null, actorType: 'system', stage: 'attach' },
        ],
      );
      await core.stop();
    });
  });

  suite('stop', () => {
    const settled = (): Promise<void> =>
      new Promise((resolve) => {
        setImmediate(resolve);
      });

    /** Records a promise settling as it happens, so a test can ask whether it has yet. */
    const watch = (promise: Promise<unknown>): { settled: boolean } => {
      const watched = { settled: false };
      const mark = (): void => {
        watched.settled = true;
      };
      void promise.then(mark, mark);
      return watched;
    };

    /**
     * A signed-in credential with an exchange held by the controller until the test releases it.
     */
    const holdExchange = (
      parts: Pick<Harness, 'answers' | 'issue'>,
    ): { credential: string; release: () => void; signals: AbortSignal[] } => {
      const credential = signInToken({ sub: 'subject-ana' });
      const held = { release: (): void => undefined };
      const signals: AbortSignal[] = [];
      parts.issue(credential, signedIn('05', 'subject-ana'));
      parts.answers.set(credential, (signal) => {
        signals.push(signal);
        return new Promise((resolve) => {
          held.release = () =>
            resolve({ kind: 'token', token: `token:${credential}` });
        });
      });
      return { credential, release: () => held.release(), signals };
    };

    /**
     * Counts the timers set through the global `setTimeout` from now on that have neither been
     * cleared nor fired, calling through to the real timers.
     */
    const liveTimers = (context: TestContext): (() => number) => {
      const live = new Set<unknown>();
      const { clearTimeout: clear, setTimeout: set } = globalThis;
      context.mock.method(
        globalThis,
        'setTimeout',
        (callback: () => void, delayMs?: number) => {
          const timer = set(() => {
            live.delete(timer);
            callback();
          }, delayMs);
          live.add(timer);
          return timer;
        },
      );
      context.mock.method(
        globalThis,
        'clearTimeout',
        (timer: Parameters<typeof clearTimeout>[0]) => {
          live.delete(timer);
          clear(timer);
        },
      );
      return () => live.size;
    };

    test('settles only once an exchange in flight has ended, leaving it to finish rather than aborting it', async () => {
      const harness = await running();
      const exchange = holdExchange(harness);
      const resolving = harness.core.resolve(exchange.credential);
      await settled();

      const stopping = harness.core.stop();
      const stop = watch(stopping);
      await settled();
      const settledWhileHeld = stop.settled;
      exchange.release();
      await stopping;
      await resolving;

      assert.equal(settledWhileHeld, false);
      assert.equal(exchange.signals[0]?.aborted, false);
    });

    test('settles only once an anonymous fetch in flight has ended, and leaves no refresh timer behind it', async (context) => {
      const harness = await running();
      const held = { release: (): void => undefined };
      harness.answers.set(
        null,
        () =>
          new Promise((resolve) => {
            held.release = () =>
              resolve({ kind: 'token', token: 'token:anonymous' });
          }),
      );
      const timersLeft = liveTimers(context);
      const refreshing = harness.core.refreshAnonymous();
      await settled();

      const stopping = harness.core.stop();
      const stop = watch(stopping);
      await settled();
      const settledWhileHeld = stop.settled;
      held.release();
      await stopping;
      await refreshing;

      assert.equal(settledWhileHeld, false);
      assert.equal(timersLeft(), 0);
    });

    test('starts no exchange once stopped, ending an answer overtaken after the stop as a second discard ends', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      const tag = await tagFor('subject-ana');
      const token: ExchangeAnswer = {
        kind: 'token',
        token: `token:${credential}`,
      };
      const held = { release: (): void => undefined };
      const calls = { count: 0 };
      harness.issue(credential, signedIn('05', 'subject-ana'));
      harness.answers.set(credential, () => {
        calls.count += 1;
        return calls.count === 1
          ? new Promise((resolve) => {
              held.release = () => resolve(token);
            })
          : Promise.resolve(token);
      });
      const resolving = harness.core.resolve(credential);
      await settled();

      harness.core.applyNotice({
        cursor: 'c-1',
        kind: 'principal',
        subjectTag: tag,
        v: 1,
      });
      const stopping = harness.core.stop();
      held.release();
      const outcome = await resolving;
      await stopping;

      assert.equal(calls.count, 1);
      assert.deepEqual(
        outcome.kind === 'access' ? outcome.access.principal : outcome,
        ANA_SUSPENDED,
      );
      assert.deepEqual(
        harness.events('token.overtaken').map(({ data }) => data['outcome']),
        ['servedOpenTier'],
      );
    });

    test('starts no anonymous fetch once stopped, abandoning an anonymous answer overtaken after the stop', async () => {
      const harness = await running();
      const token: ExchangeAnswer = { kind: 'token', token: 'token:anonymous' };
      const held = { release: (): void => undefined };
      const calls = { count: 0 };
      harness.answers.set(null, () => {
        calls.count += 1;
        return calls.count === 1
          ? new Promise((resolve) => {
              held.release = () => resolve(token);
            })
          : Promise.resolve(token);
      });
      const refreshing = harness.core.refreshAnonymous();
      await settled();

      harness.core.applyNotice({ cursor: 'c-1', kind: 'global', v: 1 });
      const stopping = harness.core.stop();
      held.release();
      const refreshed = await refreshing;
      await stopping;

      assert.equal(calls.count, 1);
      assert.equal(refreshed, false);
      assert.deepEqual(
        harness.events('token.overtaken').map(({ data }) => data['outcome']),
        ['abandoned'],
      );
    });

    for (const [first, last] of [
      ['channel', 'exchange'],
      ['exchange', 'channel'],
    ] as const) {
      test(`closes the seams only once the channel has stopped and no flight is held, the ${last} ending last`, async () => {
        const parts = harnessParts();
        const channelStop = { release: (): void => undefined };
        const closes = { count: 0 };
        const core = createBridgeCoreWithSeams(parts.configuration, {
          ...parts.seams,
          close: async () => {
            closes.count += 1;
          },
          createChannel: (context) => ({
            ...parts.seams.createChannel(context),
            stop: () =>
              new Promise<void>((resolve) => {
                channelStop.release = resolve;
              }),
          }),
        });
        core.register({ files: catalogue });
        await core.start();
        parts.confirm(0);
        await core.refreshAnonymous();
        const exchange = holdExchange(parts);
        const resolving = core.resolve(exchange.credential);
        await settled();
        const end = {
          channel: async () => {
            channelStop.release();
          },
          exchange: async () => {
            exchange.release();
            await resolving;
          },
        };

        const stopping = core.stop();
        const stop = watch(stopping);
        await end[first]();
        await settled();
        const beforeLast = { closes: closes.count, settled: stop.settled };
        await end[last]();
        await stopping;

        assert.deepEqual(beforeLast, { closes: 0, settled: false });
        assert.equal(closes.count, 1);
      });
    }

    test('frees its audience only once it settles, so a successor started before then is refused and one started after runs', async () => {
      const harness = await running();
      const exchange = holdExchange(harness);
      const resolving = harness.core.resolve(exchange.credential);
      await settled();
      const early = createBridgeCoreWithSeams(
        harness.configuration,
        harness.seams,
      );
      early.register({ files: catalogue });
      const later = createBridgeCoreWithSeams(
        harness.configuration,
        harness.seams,
      );
      later.register({ files: catalogue });

      const stopping = harness.core.stop();
      await settled();
      await assert.rejects(early.start(), {
        message: START_REFUSAL_RULES.audienceInUse,
      });
      exchange.release();
      await stopping;
      await resolving;
      await later.start();

      await Promise.all([early.stop(), later.stop()]);
    });

    test('settles for every caller only once a start still importing the key has settled', async (context) => {
      const parts = harnessParts();
      const importing = { release: (): void => undefined };
      const imported = new Promise<void>((resolve) => {
        importing.release = resolve;
      });
      const importKey = webcrypto.subtle.importKey;
      context.mock.method(webcrypto.subtle, 'importKey', (...args: unknown[]) =>
        imported.then(() => Reflect.apply(importKey, webcrypto.subtle, args)),
      );
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });
      const order: string[] = [];

      const starting = core.start();
      const stops = [core.stop(), core.stop()];
      void starting.then(() => order.push('start'));
      stops.forEach(
        (stopping, index) =>
          void stopping.then(() => order.push(`stop ${index + 1}`)),
      );
      await settled();
      const settledWhileImporting = [...order];
      importing.release();
      await Promise.all([starting, ...stops]);

      assert.deepEqual(settledWhileImporting, []);
      assert.deepEqual(order, ['start', 'stop 1', 'stop 2']);
    });

    test("resolves once every flight has ended, closing the seams once, when the channel's stop and the seams' close both reject", async () => {
      const parts = harnessParts();
      const closes = { count: 0 };
      const core = createBridgeCoreWithSeams(parts.configuration, {
        ...parts.seams,
        close: () => {
          closes.count += 1;
          return Promise.reject(new Error('a defect in close'));
        },
        createChannel: (context) => ({
          ...parts.seams.createChannel(context),
          stop: () => Promise.reject(new Error('a defect in the channel')),
        }),
      });
      core.register({ files: catalogue });
      await core.start();
      parts.confirm(0);
      await core.refreshAnonymous();
      const exchange = holdExchange(parts);
      const resolving = core.resolve(exchange.credential);
      await settled();

      const stopping = core.stop();
      const stop = watch(stopping);
      await settled();
      const whileHeld = { closes: closes.count, settled: stop.settled };
      exchange.release();
      await assert.doesNotReject(stopping);
      await resolving;

      assert.deepEqual(whileHeld, { closes: 0, settled: false });
      assert.equal(closes.count, 1);
    });

    test("resolves when the host's logger throws as it stops, waiting for a held exchange, closing the seams once and freeing the audience", async () => {
      const parts = harnessParts();
      const logging = { throws: false };
      const log = (): void => {
        if (logging.throws) {
          throw new Error('a defect in the host logger');
        }
      };
      const closes = { count: 0 };
      const core = createBridgeCoreWithSeams(
        {
          ...parts.configuration,
          inFlightMax: 1,
          logger: { error: log, info: log, warn: log },
        },
        {
          ...parts.seams,
          close: async () => {
            closes.count += 1;
          },
        },
      );
      core.register({ files: catalogue });
      await core.start();
      parts.confirm(0);
      await core.refreshAnonymous();
      const exchange = holdExchange(parts);
      const resolving = core.resolve(exchange.credential);
      await settled();
      const shed = await core.resolve(signInToken({ sub: 'subject-ben' }));
      logging.throws = true;

      const stopping = core.stop();
      const stop = watch(stopping);
      await settled();
      const whileHeld = { closes: closes.count, settled: stop.settled };
      exchange.release();
      await assert.doesNotReject(stopping);
      await Promise.allSettled([resolving]);
      const successor = createBridgeCoreWithSeams(
        parts.configuration,
        parts.seams,
      );
      successor.register({ files: catalogue });
      await successor.start();

      assert.deepEqual(shed, { kind: 'unavailable' });
      assert.deepEqual(whileHeld, { closes: 0, settled: false });
      assert.equal(closes.count, 1);
      await successor.stop();
    });

    test("keeps a successor's claim on the audience when a core whose key import failed stops after the successor started", async (context) => {
      const parts = harnessParts();
      const importing = { fails: true };
      const importKey = webcrypto.subtle.importKey;
      context.mock.method(
        webcrypto.subtle,
        'importKey',
        (...args: unknown[]) =>
          importing.fails
            ? Promise.reject(new Error('a key WebCrypto refuses'))
            : Reflect.apply(importKey, webcrypto.subtle, args),
      );
      const closing = { release: (): void => undefined };
      const failed = createBridgeCoreWithSeams(parts.configuration, {
        ...parts.seams,
        close: () =>
          new Promise<void>((resolve) => {
            closing.release = resolve;
          }),
      });
      failed.register({ files: catalogue });
      const successor = createBridgeCoreWithSeams(
        parts.configuration,
        parts.seams,
      );
      successor.register({ files: catalogue });
      const third = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      third.register({ files: catalogue });

      const starting = failed.start();
      importing.fails = false;
      const stopping = failed.stop();
      await assert.rejects(starting, {
        message: START_REFUSAL_RULES.keyUnusable,
      });
      await successor.start();
      closing.release();
      await stopping;

      await assert.rejects(third.start(), {
        message: START_REFUSAL_RULES.audienceInUse,
      });
      await Promise.all([successor.stop(), third.stop()]);
    });
  });

  suite('cold and anonymous', () => {
    test('answers every request unavailable while cold, the anonymous one included', async () => {
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, parts.seams);
      core.register({ files: catalogue });
      await core.start();

      const outcomes = await Promise.all([
        core.resolve(null),
        core.resolve(signInToken({ sub: 'subject-ana' })),
      ]);

      assert.deepEqual(outcomes, [
        { kind: 'unavailable' },
        { kind: 'unavailable' },
      ]);
      assert.deepEqual(parts.exchanges, [null]);
      await core.stop();
    });

    test('serves an anonymous request the anonymous results, presenting no credential and never suspended', async () => {
      const harness = await running();

      const access = await accessOf(harness.core, null);

      assert.deepEqual(access, {
        principal: NO_CREDENTIAL,
        results: resultsFor(ANONYMOUS),
        version: 1,
      });
      assert.ok(Object.isFrozen(access) && Object.isFrozen(access.principal));
      await harness.core.stop();
    });

    test('answers anonymous requests unavailable in normal mode once the anonymous payload expires and its refetch fails', async () => {
      const harness = await running();
      harness.answers.set(null, { cause: 'network', kind: 'failed' });
      harness.advanceWall(LIFETIME_MS);

      const outcome = await harness.core.resolve(null);

      assert.deepEqual(outcome, { kind: 'unavailable' });
      await harness.core.stop();
    });

    test('ends the anonymous entry at its TTL on the monotonic clock, well before its own exp, and not a millisecond sooner', async () => {
      const harness = await running(undefined, (configuration) => ({
        ...configuration,
        tokenTtlMs: 120_000,
      }));

      harness.confirm(119_999);
      harness.advanceMonotonic(119_999);
      const beforeTtl = await harness.core.resolve(null);
      harness.confirm(120_000);
      harness.advanceMonotonic(1);
      const atTtl = await harness.core.resolve(null);

      assert.equal(beforeTtl.kind, 'access');
      assert.deepEqual(atTtl, { kind: 'unavailable' });
      assert.equal(harness.core.mode(), 'normal');
      await harness.core.stop();
    });
  });

  suite('exchange', () => {
    test('exchanges a credential once, attaching its subject and results, and serves the next request from the cache', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));

      const first = await accessOf(harness.core, credential);
      const second = await accessOf(harness.core, credential);

      assert.deepEqual(first, {
        principal: {
          credential: 'confirmed',
          openTierOnly: false,
          subject: 'subject-ana',
          suspended: false,
        },
        results: resultsFor(payloadFor('05')),
        version: 1,
      });
      assert.equal(second, first);
      assert.deepEqual(harness.exchanges.slice(2), [credential]);
      await harness.core.stop();
    });

    test('shares one exchange among ten concurrent requests on one credential', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));

      await Promise.all(
        Array.from({ length: 10 }, () => harness.core.resolve(credential)),
      );

      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        1,
      );
      await harness.core.stop();
    });

    test('refuses an identity the controller refuses, and refuses it again from the refusal store with no exchange', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-revoked' });

      const first = await harness.core.resolve(credential);
      const second = await harness.core.resolve(credential);

      assert.deepEqual(
        [first, second],
        [{ kind: 'refused' }, { kind: 'refused' }],
      );
      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        1,
      );
      assert.deepEqual(
        harness.events('credential.refusal').map(({ data }) => data['origin']),
        ['controller', 'cachedRefusal'],
      );
      await harness.core.stop();
    });

    test('refuses locally a signed token past its exp by the tolerance, and exchanges one a second short of it', async () => {
      const harness = await running();
      const expSeconds = ANONYMOUS.iat - 60;
      const expired = signInToken({ exp: expSeconds, sub: 'subject-ana' });
      const live = signInToken({ exp: expSeconds + 1, sub: 'subject-ana' });
      harness.issue(live, signedIn('05', 'subject-ana'));

      const refused = await harness.core.resolve(expired);
      const exchanged = await harness.core.resolve(live);

      assert.deepEqual(refused, { kind: 'refused' });
      assert.equal(exchanged.kind, 'access');
      assert.equal(harness.exchanges.includes(expired), false);
      assert.deepEqual(
        harness.events('credential.refusal').map(({ data }) => data['origin']),
        ['localExpiry'],
      );
      await harness.core.stop();
    });

    test('exchanges an opaque credential, never refusing it locally', async () => {
      const harness = await running();
      harness.issue('uak_3f9d2c7b1e8a4f6d', signedIn('05', 'service-account'));

      const access = await accessOf(harness.core, 'uak_3f9d2c7b1e8a4f6d');

      assert.equal(subjectInForce(access.principal), 'service-account');
      await harness.core.stop();
    });

    test('treats a rejected token as not received, holding the rejection until the failure hold ends', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.answers.set(credential, { kind: 'token', token: 'token:broken' });
      harness.readings.set('token:broken', {
        kind: 'rejected',
        reason: 'payloadMalformed',
      });

      const first = await harness.core.resolve(credential);
      const held = await harness.core.resolve(credential);
      harness.advanceMonotonic(10_000);
      const afterHold = await harness.core.resolve(credential);

      assert.deepEqual(
        [first, held, afterHold].map(({ kind }) => kind),
        ['unavailable', 'unavailable', 'unavailable'],
      );
      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        2,
      );
      assert.deepEqual(
        harness.events('token.rejection').map(({ data }) => data['reason']),
        ['payloadMalformed', 'payloadMalformed'],
      );
      await harness.core.stop();
    });

    test('rejects an Usher token with a null subject answering an exchange that carried a credential', async () => {
      const harness = await running();
      const credential = 'uak_3f9d2c7b1e8a4f6d';
      harness.issue(credential, ANONYMOUS);

      const outcome = await harness.core.resolve(credential);

      assert.deepEqual(outcome, { kind: 'unavailable' });
      assert.deepEqual(
        harness.events('token.rejection').map(({ data }) => data['reason']),
        ['subjectMismatch'],
      );
      await harness.core.stop();
    });

    test("rejects an Usher token whose subject differs from the signed sign-in token's own", async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ben'));

      const outcome = await harness.core.resolve(credential);

      assert.deepEqual(outcome, { kind: 'unavailable' });
      await harness.core.stop();
    });

    test('rejects an anonymous refresh answered with a subject', async () => {
      const harness = await running();
      harness.readings.set('token:anonymous', {
        kind: 'payload',
        payload: signedIn('03', 'subject-ana'),
      });

      const refreshed = await harness.core.refreshAnonymous();

      assert.equal(refreshed, false);
      assert.deepEqual(
        harness.events('token.rejection').map(({ data }) => data['reason']),
        ['subjectMismatch'],
      );
      await harness.core.stop();
    });

    test('serves a principal whose exchange failed the open tier, suspended and unconfirmed, and holds the failure', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.answers.set(credential, { cause: 'timeout', kind: 'failed' });

      const first = await accessOf(harness.core, credential);
      const second = await accessOf(harness.core, credential);

      assert.deepEqual(first, {
        principal: UNCONFIRMED,
        results: resultsFor(ANONYMOUS),
        version: 1,
      });
      assert.deepEqual(second, first);
      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        1,
      );
      assert.deepEqual(
        harness
          .events('token.exchangeFailure')
          .map(({ data }) => data['cause']),
        ['timeout'],
      );
      await harness.core.stop();
    });

    test('answers unavailable when an exchange fails and no usable anonymous payload is held', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.answers.set(credential, { cause: 'status', kind: 'failed' });
      harness.answers.set(null, { cause: 'network', kind: 'failed' });
      harness.advanceWall(LIFETIME_MS);

      const outcome = await harness.core.resolve(credential);

      assert.deepEqual(outcome, { kind: 'unavailable' });
      await harness.core.stop();
    });

    test('answers an unavailable exchange 503 without holding it, so the next request asks again', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.answers.set(credential, { cause: 'status', kind: 'unavailable' });

      await harness.core.resolve(credential);
      const second = await harness.core.resolve(credential);

      assert.deepEqual(second, { kind: 'unavailable' });
      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        2,
      );
      await harness.core.stop();
    });

    test('answers unavailable to a new credential beyond the in-flight bound', async () => {
      const harness = await running(undefined, (configuration) => ({
        ...configuration,
        inFlightMax: 1,
      }));
      const held = { release: (): void => undefined };
      harness.answers.set(
        'uak_first',
        () =>
          new Promise((resolve) => {
            held.release = () => resolve({ kind: 'refused' });
          }),
      );

      const first = harness.core.resolve('uak_first');
      const second = await harness.core.resolve('uak_second');
      held.release();
      await first;

      assert.deepEqual(second, { kind: 'unavailable' });
      assert.equal(harness.exchanges.includes('uak_second'), false);
      await harness.core.stop();
    });

    test('keeps two principals apart, each request seeing only its own access', async () => {
      const harness = await running();
      const ana = signInToken({ sub: 'subject-ana' });
      const ben = signInToken({ sub: 'subject-ben' });
      harness.issue(ana, signedIn('05', 'subject-ana'));
      harness.issue(ben, signedIn('09', 'subject-ben'));

      const [forAna, forBen] = await Promise.all([
        accessOf(harness.core, ana),
        accessOf(harness.core, ben),
      ]);

      assert.equal(subjectInForce(forAna.principal), 'subject-ana');
      assert.equal(subjectInForce(forBen.principal), 'subject-ben');
      assert.deepEqual(forBen.results, resultsFor(payloadFor('09')));
      await harness.core.stop();
    });

    test("exchanges a token forged to carry a cached principal's subject, never serving it from the cache", async () => {
      const harness = await running();
      const genuine = signInToken({ sub: 'subject-ana' });
      harness.issue(genuine, signedIn('05', 'subject-ana'));
      await accessOf(harness.core, genuine);
      const forged = `${genuine.slice(0, genuine.lastIndexOf('.'))}.Zm9yZ2Vk`;

      const outcome = await harness.core.resolve(forged);

      assert.deepEqual(outcome, { kind: 'refused' });
      assert.equal(harness.exchanges.includes(forged), true);
      await harness.core.stop();
    });

    for (const [description, advance] of [
      [
        "the Usher token's exp",
        (harness: Harness) => harness.advanceWall(LIFETIME_MS),
      ],
      [
        'its receipt plus the TTL, on the monotonic clock',
        (harness: Harness) => {
          harness.confirm(300_000);
          harness.advanceMonotonic(300_000);
        },
      ],
    ] as const) {
      test(`ends an entry at ${description}, so the next request exchanges again`, async () => {
        const harness = await running();
        const credential = signInToken({ sub: 'subject-ana' });
        harness.issue(credential, signedIn('05', 'subject-ana'));
        await accessOf(harness.core, credential);

        advance(harness);
        await harness.core.resolve(credential);

        assert.equal(
          harness.exchanges.filter((sent) => sent === credential).length,
          2,
        );
        await harness.core.stop();
      });
    }

    test("ends an entry at its sign-in token's own exp", async () => {
      const harness = await running();
      const credential = signInToken({
        exp: ANONYMOUS.iat + 100,
        sub: 'subject-ana',
      });
      harness.issue(credential, signedIn('05', 'subject-ana'));
      await accessOf(harness.core, credential);

      harness.advanceWall(100_000);
      const outcome = await harness.core.resolve(credential);

      assert.equal(outcome.kind, 'access');
      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        2,
      );
      await harness.core.stop();
    });

    test('marks a principal holding nothing beyond the anonymous payload openTierOnly', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('03', 'subject-ana'));

      const access = await accessOf(harness.core, credential);

      assert.equal(access.principal.openTierOnly, true);
      assert.equal(access.principal.suspended, false);
      await harness.core.stop();
    });

    test('records category.unenforced once per payload received, never per request', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('24', 'subject-ana'));

      await accessOf(harness.core, credential);
      await accessOf(harness.core, credential);

      assert.deepEqual(
        harness
          .events('category.unenforced')
          .map(({ data }) => [
            data['userId'],
            data['resourceId'],
            data['entry'],
          ]),
        [['subject-ana', 'HEART_STUDY', 'fieldPartition']],
      );
      await harness.core.stop();
    });

    test('denies a catalogue leaving a global category unmapped, and records category.unmapped once per catalogue and category, critical and naming no resource', async () => {
      const harness = await running({
        files: {
          ...catalogue,
          categories: { global: { 'global.controlled': CONTROLLED } },
        },
      });
      const ana = signInToken({ sub: 'subject-ana' });
      const ben = signInToken({ sub: 'subject-ben' });
      harness.issue(ana, signedIn('05', 'subject-ana'));
      harness.issue(ben, signedIn('09', 'subject-ben'));

      const forAna = await accessOf(harness.core, ana);
      await accessOf(harness.core, ben);

      assert.deepEqual(resultFor(forAna, 'files'), {
        kind: 'deny',
        reason: 'unmapped-category',
      });
      assert.deepEqual(
        harness
          .events('category.unmapped')
          .map(({ data, severity }) => ({ data, severity })),
        [
          {
            data: {
              actorId: null,
              actorType: 'system',
              catalogue: 'files',
              category: 'global.community-governed',
            },
            severity: 'critical',
          },
        ],
      );
      await harness.core.stop();
    });

    test('withholds a resource offering a resource category its catalogue does not define, and records category.unmapped once per catalogue, category and resource, at error severity', async () => {
      const harness = await running({ files: catalogue, samples: catalogue });
      const ana = signInToken({ sub: 'subject-ana' });
      const ben = signInToken({ sub: 'subject-ben' });
      harness.issue(ana, offeringPilot(signedIn('05', 'subject-ana')));
      harness.issue(ben, offeringPilot(signedIn('09', 'subject-ben')));

      const forAna = await accessOf(harness.core, ana);
      await accessOf(harness.core, ben);

      assert.deepEqual(
        ['files', 'samples'].map((catalogueKey) => {
          const { complement, held } = narrowingIn(
            resultFor(forAna, catalogueKey),
          );
          return { complement, held };
        }),
        ['files', 'samples'].map(() => ({
          complement: ['HEART_STUDY', 'VOID_INDEX'],
          held: ['LUNG_COHORT', 'REEF_ARCHIVE'],
        })),
      );
      assert.deepEqual(
        harness
          .events('category.unmapped')
          .map(({ data, severity }) => ({ data, severity })),
        ['files', 'samples'].map((catalogueKey) => ({
          data: {
            actorId: null,
            actorType: 'system',
            catalogue: catalogueKey,
            category: 'resource.pilot',
            resourceId: 'HEART_STUDY',
          },
          severity: 'error',
        })),
      );
      await harness.core.stop();
    });

    test('records category.unknown once per catalogue, category and resource, as a warning, for a resource category the catalogue defines and the payload does not list there', async () => {
      const harness = await running({
        files: {
          ...catalogue,
          categories: {
            ...catalogue.categories,
            resource: {
              HEART_STUDY: {
                'resource.pilot': inCondition('cohort', ['pilot']),
              },
            },
          },
        },
      });
      const ana = signInToken({ sub: 'subject-ana' });
      harness.issue(ana, signedIn('05', 'subject-ana'));

      await accessOf(harness.core, ana);
      await accessOf(harness.core, ana);

      assert.deepEqual(
        harness
          .events('category.unknown')
          .map(({ data, severity }) => ({ data, severity })),
        [
          {
            data: {
              actorId: null,
              actorType: 'system',
              catalogue: 'files',
              category: 'resource.pilot',
              resourceId: 'HEART_STUDY',
            },
            severity: 'warning',
          },
        ],
      );
      await harness.core.stop();
    });

    test('records category.unknown once per catalogue and category, as a warning, for a global category the catalogue defines and the payloads never list', async () => {
      const harness = await running({
        files: {
          ...catalogue,
          categories: {
            global: {
              ...catalogue.categories.global,
              'global.embargoed': inCondition('embargo_status', ['embargoed']),
            },
          },
        },
      });
      const ana = signInToken({ sub: 'subject-ana' });
      harness.issue(ana, signedIn('05', 'subject-ana'));

      await accessOf(harness.core, ana);

      assert.deepEqual(
        harness
          .events('category.unknown')
          .map(({ data, severity }) => ({ data, severity })),
        [
          {
            data: {
              actorId: null,
              actorType: 'system',
              catalogue: 'files',
              category: 'global.embargoed',
            },
            severity: 'warning',
          },
        ],
      );
      await harness.core.stop();
    });

    test('denies a catalogue whose narrowing passes the clause limit, and records catalogue.filterLimit once per catalogue and payload rendered, as an error naming the limit and no count', async () => {
      const harness = await running(
        { files: catalogue, samples: catalogue },
        (configuration) => ({ ...configuration, filterClauseLimit: 13 }),
      );
      /**
       * Case 5 with HEART_STUDY held through its controlled records alone, which adds the unmarked
       * clause, so it counts 20 where the anonymous payload counts 13.
       */
      const controlledOnly = (sub: string): PermissionsPayload => {
        const payload = signedIn('05', sub);
        return {
          ...payload,
          permissions: {
            ...payload.permissions,
            HEART_STUDY: { 'global.controlled': { record: ['view'] } },
          },
        };
      };
      const ana = signInToken({ sub: 'subject-ana' });
      const ben = signInToken({ sub: 'subject-ben' });
      harness.issue(ana, controlledOnly('subject-ana'));
      harness.issue(ben, controlledOnly('subject-ben'));

      const anonymous = await accessOf(harness.core, null);
      const forAna = await accessOf(harness.core, ana);
      await accessOf(harness.core, ana);
      await accessOf(harness.core, ben);

      assert.deepEqual(narrowingIn(resultFor(anonymous, 'files')).held, [
        'HEART_STUDY',
        'LUNG_COHORT',
        'REEF_ARCHIVE',
      ]);
      assert.deepEqual(
        ['files', 'samples'].map((catalogueKey) =>
          resultFor(forAna, catalogueKey),
        ),
        ['files', 'samples'].map(() => ({
          kind: 'deny',
          reason: 'filter-limit',
        })),
      );
      assert.deepEqual(
        harness
          .events('catalogue.filterLimit')
          .map(({ data, severity }) => ({ data, severity })),
        ['files', 'samples', 'files', 'samples'].map((catalogueKey) => ({
          data: {
            actorId: null,
            actorType: 'system',
            catalogue: catalogueKey,
            filterClauseLimit: 13,
          },
          severity: 'error',
        })),
      );
      assert.deepEqual(harness.events('catalogue.renderingMismatch'), []);
      await harness.core.stop();
    });

    test('renders each catalogue from its own conditions when two catalogues define one category name differently', async () => {
      const restricted = inCondition('consent', ['restricted']);
      const harness = await running({
        files: catalogue,
        samples: {
          ...catalogue,
          categories: {
            global: {
              ...catalogue.categories.global,
              'global.controlled': restricted,
            },
          },
        },
      });
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));

      const access = await accessOf(harness.core, credential);

      assert.deepEqual(narrowingIn(resultFor(access, 'files')).exclusions, [
        {
          condition: COMMUNITY_GOVERNED,
          lacking: ['HEART_STUDY', 'LUNG_COHORT', 'REEF_ARCHIVE'],
        },
        { condition: CONTROLLED, lacking: ['LUNG_COHORT', 'REEF_ARCHIVE'] },
      ]);
      assert.deepEqual(narrowingIn(resultFor(access, 'samples')).exclusions, [
        {
          condition: COMMUNITY_GOVERNED,
          lacking: ['HEART_STUDY', 'LUNG_COHORT', 'REEF_ARCHIVE'],
        },
        { condition: restricted, lacking: ['LUNG_COHORT', 'REEF_ARCHIVE'] },
      ]);
      assert.notDeepEqual(
        resultFor(access, 'files'),
        resultFor(access, 'samples'),
      );
      await harness.core.stop();
    });
  });

  suite('notices', () => {
    test('drops every entry of the principal a notice names, so their next request exchanges again', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));
      await accessOf(harness.core, credential);

      harness.core.applyNotice({
        cursor: 'c-1',
        kind: 'principal',
        subjectTag: await tagFor('subject-ana'),
        v: 1,
      });
      await accessOf(harness.core, credential);

      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        2,
      );
      assert.deepEqual(harness.events('notice.applied').at(-1)?.data, {
        actorId: null,
        actorType: 'system',
        entriesDropped: 1,
        kind: 'principal',
      });
      await harness.core.stop();
    });

    test('drops every entry naming a resource, and the anonymous entry too when it names it, fetching that again', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));
      await accessOf(harness.core, credential);

      harness.core.applyNotice({
        cursor: 'c-1',
        kind: 'category',
        resource: 'HEART_STUDY',
        v: 1,
      });
      await harness.core.refreshAnonymous();

      assert.deepEqual(harness.events('notice.applied').at(-1)?.data, {
        actorId: null,
        actorType: 'system',
        entriesDropped: 2,
        kind: 'category',
      });
      assert.equal(harness.exchanges.filter((sent) => sent === null).length, 3);
      await harness.core.stop();
    });

    for (const kind of ['baseline', 'servedResources'] as const) {
      test(`drops every positive entry and the anonymous one on a ${kind} notice, fetching that again, and keeps the refusals`, async () => {
        const harness = await running();
        const credential = signInToken({ sub: 'subject-ana' });
        const refused = signInToken({ sub: 'subject-revoked' });
        harness.issue(credential, signedIn('05', 'subject-ana'));
        await accessOf(harness.core, credential);
        await harness.core.resolve(refused);
        const anonymousBefore = harness.exchanges.filter(
          (sent) => sent === null,
        ).length;

        harness.core.applyNotice({ cursor: 'c-1', kind, v: 1 });
        await accessOf(harness.core, credential);
        await harness.core.resolve(refused);

        assert.deepEqual(harness.events('notice.applied').at(-1)?.data, {
          actorId: null,
          actorType: 'system',
          entriesDropped: 2,
          kind,
        });
        assert.equal(
          harness.exchanges.filter((sent) => sent === null).length -
            anonymousBefore,
          1,
        );
        assert.equal(exchangesOf(harness, credential), 2);
        assert.equal(exchangesOf(harness, refused), 1);
        await harness.core.stop();
      });
    }

    test('fetches the anonymous payload first after a global drop, and answers 503 beyond the in-flight bound', async () => {
      const harness = await running(undefined, (configuration) => ({
        ...configuration,
        inFlightMax: 1,
      }));
      const held = { release: (): void => undefined };
      harness.answers.set(
        'uak_first',
        () =>
          new Promise((resolve) => {
            held.release = () => resolve({ kind: 'refused' });
          }),
      );
      const before = harness.exchanges.length;

      harness.core.applyNotice({ cursor: 'c-1', kind: 'global', v: 1 });
      const first = harness.core.resolve('uak_first');
      const second = await harness.core.resolve('uak_second');
      held.release();
      await first;

      assert.deepEqual(harness.exchanges.slice(before), [null, 'uak_first']);
      assert.deepEqual(second, { kind: 'unavailable' });
      await harness.core.stop();
    });

    test('answers 503 to anonymous and open-tier requests after a baseline notice while the refetch fails, and serves again once it succeeds', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.answers.set(null, { cause: 'status', kind: 'failed' });
      harness.answers.set(credential, { cause: 'status', kind: 'failed' });

      harness.core.applyNotice({ cursor: 'c-1', kind: 'baseline', v: 1 });
      const anonymous = await harness.core.resolve(null);
      const openTier = await harness.core.resolve(credential);
      harness.answers.set(null, { kind: 'token', token: 'token:anonymous' });
      await harness.core.refreshAnonymous();
      const served = await harness.core.resolve(null);

      assert.deepEqual(
        [anonymous, openTier],
        [{ kind: 'unavailable' }, { kind: 'unavailable' }],
      );
      assert.equal(harness.core.mode(), 'normal');
      assert.equal(served.kind, 'access');
      await harness.core.stop();
    });

    test('drops refusals too on a global notice, so a refused credential is exchanged again', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-revoked' });
      await harness.core.resolve(credential);

      harness.core.applyNotice({ cursor: 'c-1', kind: 'global', v: 1 });
      await harness.core.resolve(credential);

      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        2,
      );
      await harness.core.stop();
    });

    test('discards an answer overtaken by a notice naming its principal, for every waiter, and exchanges once more', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      const tag = await tagFor('subject-ana');
      const sent = { count: 0 };
      harness.readings.set('token:ana', {
        kind: 'payload',
        payload: signedIn('05', 'subject-ana'),
      });
      harness.answers.set(credential, () => {
        sent.count += 1;
        if (sent.count === 1) {
          harness.core.applyNotice({
            cursor: 'c-1',
            kind: 'principal',
            subjectTag: tag,
            v: 1,
          });
        }
        return Promise.resolve({ kind: 'token', token: 'token:ana' });
      });

      const [first, joined] = await Promise.all([
        accessOf(harness.core, credential),
        accessOf(harness.core, credential),
      ]);

      assert.equal(sent.count, 2);
      assert.equal(first, joined);
      assert.equal(subjectInForce(first.principal), 'subject-ana');
      assert.deepEqual(
        harness.events('token.overtaken').map(({ data }) => data['outcome']),
        ['exchangedAgain'],
      );
      await harness.core.stop();
    });

    for (const kind of ['baseline', 'servedResources'] as const) {
      test(`discards an answer overtaken by a ${kind} notice, and exchanges once more`, async () => {
        const harness = await running();
        const credential = signInToken({ sub: 'subject-ana' });
        const sent = { count: 0 };
        harness.readings.set('token:ana', {
          kind: 'payload',
          payload: signedIn('05', 'subject-ana'),
        });
        harness.answers.set(credential, () => {
          sent.count += 1;
          if (sent.count === 1) {
            harness.core.applyNotice({ cursor: 'c-1', kind, v: 1 });
          }
          return Promise.resolve({ kind: 'token', token: 'token:ana' });
        });

        await accessOf(harness.core, credential);

        assert.equal(sent.count, 2);
        assert.deepEqual(
          harness.events('token.overtaken').map(({ data }) => data['outcome']),
          ['exchangedAgain'],
        );
        await harness.core.stop();
      });
    }

    test('keeps an answer when the notice in flight names somebody else', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      const otherTag = await tagFor('subject-ben');
      harness.readings.set('token:ana', {
        kind: 'payload',
        payload: signedIn('05', 'subject-ana'),
      });
      harness.answers.set(credential, () => {
        harness.core.applyNotice({
          cursor: 'c-1',
          kind: 'principal',
          subjectTag: otherTag,
          v: 1,
        });
        return Promise.resolve({ kind: 'token', token: 'token:ana' });
      });

      await accessOf(harness.core, credential);

      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        1,
      );
      await harness.core.stop();
    });

    test('serves the open tier, suspended and naming the subject its verified token carried for attribution alone, when the answer is overtaken a second time', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      const tag = await tagFor('subject-ana');
      harness.readings.set('token:ana', {
        kind: 'payload',
        payload: signedIn('05', 'subject-ana'),
      });
      harness.answers.set(credential, () => {
        harness.core.applyNotice({
          cursor: 'c',
          kind: 'principal',
          subjectTag: tag,
          v: 1,
        });
        return Promise.resolve({ kind: 'token', token: 'token:ana' });
      });

      const access = await accessOf(harness.core, credential);

      assert.deepEqual(access.principal, ANA_SUSPENDED);
      assert.deepEqual(
        harness.events('token.overtaken').map(({ data }) => data['outcome']),
        ['exchangedAgain', 'servedOpenTier'],
      );
      await harness.core.stop();
    });
  });

  suite('reset', () => {
    test('drops every positive entry and the anonymous one, keeps refusals, and logs the reset', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      const revoked = signInToken({ sub: 'subject-revoked' });
      harness.issue(credential, signedIn('05', 'subject-ana'));
      await accessOf(harness.core, credential);
      await harness.core.resolve(revoked);

      harness.core.reset();
      const anonymous = await harness.core.resolve(null);
      const refused = await harness.core.resolve(revoked);
      await harness.core.resolve(credential);

      assert.deepEqual(anonymous, { kind: 'unavailable' });
      assert.deepEqual(refused, { kind: 'refused' });
      assert.equal(
        harness.exchanges.filter((sent) => sent === revoked).length,
        1,
      );
      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        2,
      );
      assert.deepEqual(
        harness.events('revocationChannel.reset').map(({ data }) => data),
        [{ actorId: null, actorType: 'system' }],
      );
      await harness.core.stop();
    });

    test('serves an exchange completing before the next check without caching it, and caches again after that check', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));

      harness.core.reset();
      const beforeCheck = await harness.core.resolve(credential);
      await harness.core.resolve(credential);
      const exchangedBeforeCheck = harness.exchanges.filter(
        (sent) => sent === credential,
      ).length;
      harness.confirm(0);
      await harness.core.refreshAnonymous();
      await harness.core.resolve(credential);
      await harness.core.resolve(credential);

      assert.equal(beforeCheck.kind, 'access');
      assert.equal(exchangedBeforeCheck, 2);
      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        3,
      );
      await harness.core.stop();
    });

    test('fetches the anonymous payload again only once the next check confirms, never keeping one fetched before it', async () => {
      const harness = await running();
      const anonymousBefore = harness.exchanges.filter(
        (sent) => sent === null,
      ).length;

      harness.core.reset();
      const fetchedBySelf = await harness.core.refreshAnonymous();
      const stillUnavailable = await harness.core.resolve(null);
      harness.confirm(0);
      await harness.core.refreshAnonymous();
      const served = await harness.core.resolve(null);

      assert.equal(fetchedBySelf, true);
      assert.deepEqual(stillUnavailable, { kind: 'unavailable' });
      assert.equal(served.kind, 'access');
      assert.equal(
        harness.exchanges.filter((sent) => sent === null).length,
        anonymousBefore + 2,
      );
      await harness.core.stop();
    });

    test('forgets every category gap it has logged, so the next payload meeting one logs category.unmapped and category.unknown again', async () => {
      const harness = await running({
        files: {
          ...catalogue,
          categories: {
            ...catalogue.categories,
            resource: {
              HEART_STUDY: {
                'resource.pilot': inCondition('cohort', ['pilot']),
              },
            },
          },
        },
      });
      /**
       * A payload in which LUNG_COHORT offers `resource.extra`, a category not defined there by the
       * catalogue.
       */
      const offeringExtra = (sub: string): PermissionsPayload => {
        const payload = signedIn('05', sub);
        return {
          ...payload,
          resourceCategories: {
            ...payload.resourceCategories,
            LUNG_COHORT: ['resource.extra'],
          },
        };
      };
      const issued = (name: string): string => {
        const credential = signInToken({ sub: `subject-${name}` });
        harness.issue(credential, offeringExtra(`subject-${name}`));
        return credential;
      };
      const logged = (): number[] =>
        ['category.unmapped', 'category.unknown'].map(
          (type) => harness.events(type).length,
        );

      await accessOf(harness.core, issued('ana'));
      await accessOf(harness.core, issued('ben'));
      const beforeReset = logged();
      harness.core.reset();
      await accessOf(harness.core, issued('cai'));

      assert.deepEqual(beforeReset, [1, 1]);
      assert.deepEqual(logged(), [2, 2]);
      await harness.core.stop();
    });
  });

  suite('a flight that spans a reset', () => {
    /** An answer released by the test itself, so the flight can span a reset. */
    const held = () => {
      const release: { answer: (answer: ExchangeAnswer) => void } = {
        answer: () => undefined,
      };
      const answer = new Promise<ExchangeAnswer>((resolve) => {
        release.answer = resolve;
      });
      return {
        answer,
        release: (value: ExchangeAnswer) => release.answer(value),
      };
    };
    const ANONYMOUS_TOKEN: ExchangeAnswer = {
      kind: 'token',
      token: 'token:anonymous',
    };

    /** Lets queued work run until `condition` holds, or its rounds run out. */
    const until = async (
      condition: () => boolean,
      rounds = 1_000,
    ): Promise<void> => {
      if (condition() || rounds === 0) {
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
      return until(condition, rounds - 1);
    };

    test('installs no anonymous payload whose fetch spans a reset, so the bridge goes cold rather than uncertain', async () => {
      const harness = await running();
      const pending = held();
      harness.answers.set(null, () => pending.answer);

      const refreshed = harness.core.refreshAnonymous();
      harness.core.reset();
      pending.release(ANONYMOUS_TOKEN);
      const fetched = await refreshed;
      harness.advanceMonotonic(60_001);

      assert.equal(fetched, false);
      assert.equal(harness.core.mode(), 'cold');
      assert.deepEqual(await harness.core.resolve(null), {
        kind: 'unavailable',
      });
      assert.deepEqual(
        harness.events('token.overtaken').map(({ data }) => data['outcome']),
        ['abandoned'],
      );
      await harness.core.stop();
    });

    test('fetches afresh at the first check after a reset rather than joining a fetch started before it', async () => {
      const harness = await running();
      const pending = held();
      const calls = { count: 0 };
      harness.answers.set(null, () => {
        calls.count += 1;
        return calls.count === 1
          ? pending.answer
          : Promise.resolve(ANONYMOUS_TOKEN);
      });

      const stale = harness.core.refreshAnonymous();
      harness.core.reset();
      harness.confirm(0);
      const fresh = await harness.core.refreshAnonymous();
      pending.release(ANONYMOUS_TOKEN);
      await stale;

      assert.equal(fresh, true);
      assert.equal(calls.count, 2);
      assert.equal(harness.core.mode(), 'normal');
      assert.equal((await harness.core.resolve(null)).kind, 'access');
      await harness.core.stop();
    });

    test('retries an anonymous fetch turned away while two stale fetches still run', async (context) => {
      const harness = await running();
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const stale = [held(), held()];
      const calls = { count: 0 };
      harness.answers.set(null, () => {
        calls.count += 1;
        return (
          stale[calls.count - 1]?.answer ?? Promise.resolve(ANONYMOUS_TOKEN)
        );
      });

      const first = harness.core.refreshAnonymous();
      harness.core.reset();
      const second = harness.core.refreshAnonymous();
      harness.core.reset();
      harness.confirm(0);
      await new Promise((resolve) => setImmediate(resolve));
      const turnedAway = calls.count;
      stale.forEach((pending) => pending.release(ANONYMOUS_TOKEN));
      await Promise.all([first, second]);
      context.mock.timers.tick(1_000);
      await until(() => harness.core.mode() === 'normal');

      assert.equal(turnedAway, 2);
      assert.equal(calls.count, 3);
      assert.equal(harness.core.mode(), 'normal');
      await harness.core.stop();
    });

    test('exchanges again a credential whose exchange spans a reset and the check after it', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));
      const pending = held();
      const calls = { count: 0 };
      harness.answers.set(credential, () => {
        calls.count += 1;
        return calls.count === 1
          ? pending.answer
          : Promise.resolve({ kind: 'token', token: `token:${credential}` });
      });

      const resolved = harness.core.resolve(credential);
      await until(() => calls.count > 0);
      harness.core.reset();
      harness.confirm(0);
      await harness.core.refreshAnonymous();
      pending.release({ kind: 'token', token: `token:${credential}` });
      const outcome = await resolved;
      await harness.core.resolve(credential);

      assert.equal(outcome.kind, 'access');
      assert.equal(calls.count, 2);
      assert.deepEqual(
        harness.events('token.overtaken').map(({ data }) => data['outcome']),
        ['exchangedAgain'],
      );
      await harness.core.stop();
    });

    test('serves an exchange started after a reset but answered after the next check without caching it', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));
      const pending = held();
      const calls = { count: 0 };
      harness.answers.set(credential, () => {
        calls.count += 1;
        return calls.count === 1
          ? pending.answer
          : Promise.resolve({ kind: 'token', token: `token:${credential}` });
      });

      harness.core.reset();
      const resolved = harness.core.resolve(credential);
      await until(() => calls.count > 0);
      harness.confirm(0);
      await harness.core.refreshAnonymous();
      pending.release({ kind: 'token', token: `token:${credential}` });
      const outcome = await resolved;
      await harness.core.resolve(credential);
      await harness.core.resolve(credential);

      assert.equal(outcome.kind, 'access');
      assert.equal(calls.count, 2);
      assert.deepEqual(harness.events('token.overtaken'), []);
      await harness.core.stop();
    });
  });

  suite('an answer too large to read', () => {
    test('treats it as a rejected token: 503, held briefly, and logged by its reason', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.answers.set(credential, {
        kind: 'unreadable',
        reason: 'tokenTooLarge',
      });

      const first = await harness.core.resolve(credential);
      const held = await harness.core.resolve(credential);

      assert.deepEqual(
        [first, held],
        [{ kind: 'unavailable' }, { kind: 'unavailable' }],
      );
      assert.equal(
        harness.exchanges.filter((sent) => sent === credential).length,
        1,
      );
      assert.deepEqual(
        harness.events('token.rejection').map(({ data }) => data['reason']),
        ['tokenTooLarge'],
      );
      await harness.core.stop();
    });

    test('logs an anonymous answer too large to read, and retries it', async () => {
      const harness = await running();
      harness.answers.set(null, {
        kind: 'unreadable',
        reason: 'tokenTooLarge',
      });

      const refreshed = await harness.core.refreshAnonymous();

      assert.equal(refreshed, false);
      assert.deepEqual(
        harness.events('token.rejection').map(({ data }) => data['reason']),
        ['tokenTooLarge'],
      );
      await harness.core.stop();
    });
  });

  suite('abandoned discards', () => {
    test('logs abandoned when a second discard finds no usable anonymous payload, and answers 503', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      const tag = await tagFor('subject-ana');
      harness.answers.set(null, { cause: 'network', kind: 'failed' });
      harness.core.applyNotice({ cursor: 'c-0', kind: 'baseline', v: 1 });
      harness.readings.set('token:ana', {
        kind: 'payload',
        payload: signedIn('05', 'subject-ana'),
      });
      harness.answers.set(credential, () => {
        harness.core.applyNotice({
          cursor: 'c',
          kind: 'principal',
          subjectTag: tag,
          v: 1,
        });
        return Promise.resolve({ kind: 'token', token: 'token:ana' });
      });

      const outcome = await harness.core.resolve(credential);

      assert.deepEqual(outcome, { kind: 'unavailable' });
      assert.deepEqual(
        harness.events('token.overtaken').map(({ data }) => data['outcome']),
        ['exchangedAgain', 'abandoned'],
      );
      await harness.core.stop();
    });

    test('logs abandoned when an anonymous fetch is discarded a second time, installing nothing', async () => {
      const harness = await running();
      harness.answers.set(null, () => {
        harness.core.applyNotice({ cursor: 'c', kind: 'global', v: 1 });
        return Promise.resolve({ kind: 'token', token: 'token:anonymous' });
      });

      const refreshed = await harness.core.refreshAnonymous();

      assert.equal(refreshed, false);
      assert.deepEqual(
        harness.events('token.overtaken').map(({ data }) => data['outcome']),
        ['exchangedAgain', 'abandoned'],
      );
      await harness.core.stop();
    });
  });

  suite('uncertain', () => {
    const uncertain = async (): Promise<Harness> => {
      const harness = await running();
      harness.advanceMonotonic(60_001);
      assert.equal(harness.core.mode(), 'uncertain');
      return harness;
    };

    test('serves a signed-in principal with a cached entry the open tier, suspended, naming its subject for attribution alone', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));
      await accessOf(harness.core, credential);
      harness.advanceMonotonic(60_001);

      const access = await accessOf(harness.core, credential);

      assert.deepEqual(access.principal, ANA_SUSPENDED);
      assert.deepEqual(access.results, resultsFor(ANONYMOUS));
      await harness.core.stop();
    });

    test('serves a credential never exchanged the open tier, suspended and unconfirmed, naming no subject', async () => {
      const harness = await uncertain();

      const access = await accessOf(
        harness.core,
        signInToken({ sub: 'subject-new' }),
      );

      assert.deepEqual(access.principal, UNCONFIRMED);
      assert.deepEqual(access.results, resultsFor(ANONYMOUS));
      await harness.core.stop();
    });

    test('serves a credential whose cached entry a principal notice dropped as unconfirmed, since the notice ended the vouching', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));
      await accessOf(harness.core, credential);
      harness.core.applyNotice({
        cursor: 'c-1',
        kind: 'principal',
        subjectTag: await tagFor('subject-ana'),
        v: 1,
      });
      harness.advanceMonotonic(60_001);

      const access = await accessOf(harness.core, credential);

      assert.deepEqual(access.principal, UNCONFIRMED);
      await harness.core.stop();
    });

    test('serves a credential as unconfirmed once its cached entry reaches its TTL, which reading the entry while uncertain never extends', async () => {
      const harness = await running(undefined, (configuration) => ({
        ...configuration,
        tokenTtlMs: 120_000,
      }));
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));
      await accessOf(harness.core, credential);
      harness.advanceMonotonic(60_001);

      const beforeTtl = await accessOf(harness.core, credential);
      harness.advanceMonotonic(59_999);
      const atTtl = await accessOf(harness.core, credential);

      assert.equal(harness.core.mode(), 'uncertain');
      assert.deepEqual(
        [beforeTtl.principal, atTtl.principal],
        [ANA_SUSPENDED, UNCONFIRMED],
      );
      await harness.core.stop();
    });

    test('exchanges nothing, so it adds no load on the controller during an outage', async () => {
      const harness = await uncertain();
      const exchangesBefore = harness.exchanges.length;

      await accessOf(harness.core, signInToken({ sub: 'subject-new' }));

      assert.equal(harness.exchanges.length, exchangesBefore);
      await harness.core.stop();
    });

    test('still refuses a credential in the refusal store, and one past its own exp', async () => {
      const harness = await running();
      const revoked = signInToken({ sub: 'subject-revoked' });
      await harness.core.resolve(revoked);
      harness.advanceMonotonic(60_001);

      const outcomes = await Promise.all([
        harness.core.resolve(revoked),
        harness.core.resolve(
          signInToken({ exp: ANONYMOUS.iat - 120, sub: 'subject-ana' }),
        ),
      ]);

      assert.deepEqual(outcomes, [{ kind: 'refused' }, { kind: 'refused' }]);
      await harness.core.stop();
    });

    test('still answers unavailable for a credential whose rejected token the failure store holds', async () => {
      const harness = await running(undefined, (configuration) => ({
        ...configuration,
        stores: { failureHoldMs: 60_000 },
      }));
      const credential = signInToken({ sub: 'subject-ana' });
      harness.answers.set(credential, { kind: 'token', token: 'token:broken' });
      harness.advanceMonotonic(2);
      await harness.core.resolve(credential);
      harness.advanceMonotonic(59_999);

      const outcome = await harness.core.resolve(credential);

      assert.equal(harness.core.mode(), 'uncertain');
      assert.deepEqual(outcome, { kind: 'unavailable' });
      await harness.core.stop();
    });

    test("serves anonymous requests past the anonymous payload's own exp", async () => {
      const harness = await uncertain();
      harness.advanceWall(LIFETIME_MS * 2);

      const access = await accessOf(harness.core, null);

      assert.equal(access.principal.suspended, false);
      await harness.core.stop();
    });

    test('turns uncertain at the grace period on the monotonic clock, even when the wall clock steps back 30 s', async () => {
      const harness = await running();
      const elapse = (ms: number): void => {
        harness.advanceMonotonic(ms);
        harness.advanceWall(ms);
      };

      elapse(30_000);
      harness.advanceWall(-30_000);
      elapse(30_000);
      const atGrace = harness.core.mode();
      elapse(1);
      const pastGrace = harness.core.mode();

      assert.deepEqual([atGrace, pastGrace], ['normal', 'uncertain']);
      assert.deepEqual(
        harness.events('revocationChannel.modeChange').at(-1)?.data,
        {
          actorId: null,
          actorType: 'system',
          fromMode: 'normal',
          reason: 'gracePeriodLapsed',
          toMode: 'uncertain',
        },
      );
      await harness.core.stop();
    });

    test("keeps answering by mode while the host's logger throws as the mode changes, and throws nothing into the channel confirming a check", async () => {
      const logging = { throws: false };
      const log = (): void => {
        if (logging.throws) {
          throw new Error('a defect in the host logger');
        }
      };
      const harness = await running(undefined, (configuration) => ({
        ...configuration,
        logger: { error: log, info: log, warn: log },
      }));
      const credential = signInToken({ sub: 'subject-ana' });
      harness.issue(credential, signedIn('05', 'subject-ana'));
      logging.throws = true;

      harness.advanceMonotonic(60_001);
      const lapsedMode = harness.core.mode();
      const lapsed = await accessOf(harness.core, credential);
      assert.doesNotThrow(() => harness.confirm(60_001));
      const confirmedMode = harness.core.mode();
      const confirmed = await accessOf(harness.core, credential);

      assert.deepEqual([lapsedMode, confirmedMode], ['uncertain', 'normal']);
      assert.deepEqual(lapsed.principal, UNCONFIRMED);
      assert.deepEqual(confirmed.principal, {
        credential: 'confirmed',
        openTierOnly: false,
        subject: 'subject-ana',
        suspended: false,
      });
      await harness.core.stop();
    });
  });

  suite('the anonymous refresh', () => {
    /** Lets every callback already queued run, through setImmediate, which the mock timers leave alone. */
    const settled = (): Promise<void> =>
      new Promise((resolve) => {
        setImmediate(resolve);
      });

    const anonymousExchanges = (harness: Harness): number =>
      harness.exchanges.filter((sent) => sent === null).length;

    test('fetches the anonymous payload again at 80% of its lifetime', async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const harness = await running();

      context.mock.timers.tick(LIFETIME_MS * 0.8 - 1);
      await settled();
      const before = anonymousExchanges(harness);
      context.mock.timers.tick(1);
      await settled();

      assert.equal(before, 2);
      assert.equal(anonymousExchanges(harness), 3);
      await harness.core.stop();
    });

    test('retries a failed refresh after a backoff of at least 1 s', async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const harness = await running();
      harness.answers.set(null, { cause: 'network', kind: 'failed' });
      await harness.core.refreshAnonymous();
      const afterFailure = anonymousExchanges(harness);

      context.mock.timers.tick(999);
      await settled();
      const beforeBackoff = anonymousExchanges(harness);
      context.mock.timers.tick(1);
      await settled();

      assert.equal(beforeBackoff, afterFailure);
      assert.equal(anonymousExchanges(harness), afterFailure + 1);
      await harness.core.stop();
    });

    test('never waits longer than the poll interval between retries, however long the outage', async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const parts = harnessParts();
      const core = createBridgeCoreWithSeams(parts.configuration, {
        ...parts.seams,
        random: () => 0.999_999,
      });
      core.register({ files: catalogue });
      await core.start();
      parts.confirm(0);
      await core.refreshAnonymous();
      parts.answers.set(null, { cause: 'network', kind: 'failed' });
      await core.refreshAnonymous();
      const harness = { ...parts, core };

      const retriesPerInterval: number[] = [];
      for (const _ of Array.from({ length: 8 })) {
        const before = anonymousExchanges(harness);
        context.mock.timers.tick(30_000);
        await settled();
        retriesPerInterval.push(anonymousExchanges(harness) - before);
      }

      assert.deepEqual(retriesPerInterval, Array(8).fill(1));
      await core.stop();
    });
  });

  suite('the audience, through the real token reader', () => {
    /**
     * A running core reading tokens with the real token reader in place of the scripted one. The
     * anonymous exchange is answered with a token minted for `anonymousAudience`, or for the core's
     * own audience when it is omitted.
     */
    const readingTokens = async (
      anonymousAudience?: string,
    ): Promise<Harness> => {
      const parts = harnessParts();
      parts.answers.set(null, {
        kind: 'token',
        token: await mintUsherToken({
          ...ANONYMOUS,
          aud: anonymousAudience ?? parts.configuration.audience,
        }),
      });
      const core = createBridgeCoreWithSeams(parts.configuration, {
        ...parts.seams,
        createTokenReader: defaultSeams().createTokenReader,
      });
      core.register({ files: catalogue });
      await core.start();
      parts.confirm(0);
      await core.refreshAnonymous();
      return { ...parts, core };
    };

    test("rejects a principal's token minted for another audience as audienceRejected, and serves the same token minted for its own", async () => {
      const harness = await readingTokens();
      const payload = signedIn('05', 'subject-ana');
      harness.answers.set('uak_another_audience', {
        kind: 'token',
        token: await mintUsherToken({
          ...payload,
          aud: 'another-application',
        }),
      });
      harness.answers.set('uak_own_audience', {
        kind: 'token',
        token: await mintUsherToken({
          ...payload,
          aud: harness.configuration.audience,
        }),
      });

      const anotherAudience = await harness.core.resolve(
        'uak_another_audience',
      );
      const ownAudience = await accessOf(harness.core, 'uak_own_audience');

      assert.deepEqual(anotherAudience, { kind: 'unavailable' });
      assert.deepEqual(ownAudience.principal, {
        credential: 'confirmed',
        openTierOnly: false,
        subject: 'subject-ana',
        suspended: false,
      });
      assert.deepEqual(
        harness.events('token.rejection').map(({ data }) => data['reason']),
        ['audienceRejected'],
      );
      await harness.core.stop();
    });

    test('stays cold, naming a probable audience mismatch once however often it fetches, when the anonymous token is minted for another audience', async () => {
      const harness = await readingTokens('another-application');

      await harness.core.refreshAnonymous();
      const rejections = harness
        .events('token.rejection')
        .map(({ data }) => data['reason']);

      assert.equal(harness.core.mode(), 'cold');
      assert.ok(rejections.length > 1, `${rejections.length} rejections`);
      assert.deepEqual(new Set(rejections), new Set(['audienceRejected']));
      assert.deepEqual(
        harness
          .events('revocationChannel.modeChange')
          .map(({ data }) => data['reason']),
        ['probableAudienceMismatch'],
      );
      await harness.core.stop();
    });

    test('names no audience mismatch, and turns normal, when the anonymous token carries its own audience', async () => {
      const harness = await readingTokens();

      assert.equal(harness.core.mode(), 'normal');
      assert.deepEqual(harness.events('token.rejection'), []);
      assert.deepEqual(
        harness
          .events('revocationChannel.modeChange')
          .map(({ data }) => data['reason']),
        ['anonymousPayloadAccepted'],
      );
      await harness.core.stop();
    });
  });

  suite('the bounds on the stores', () => {
    const bounded = (): Promise<Harness> =>
      running(undefined, (configuration) => ({
        ...configuration,
        stores: { failureMax: 2, positiveMax: 2, refusalMax: 2 },
      }));

    test('evicts the least recently used principal, which is exchanged again, and keeps one used since', async () => {
      const harness = await bounded();
      const ana = signInToken({ sub: 'subject-ana' });
      const ben = signInToken({ sub: 'subject-ben' });
      const cai = signInToken({ sub: 'subject-cai' });
      harness.issue(ana, signedIn('05', 'subject-ana'));
      harness.issue(ben, signedIn('05', 'subject-ben'));
      harness.issue(cai, signedIn('05', 'subject-cai'));

      await accessOf(harness.core, ana);
      await accessOf(harness.core, ben);
      await accessOf(harness.core, ana);
      await accessOf(harness.core, cai);
      await accessOf(harness.core, ana);
      await accessOf(harness.core, ben);

      assert.deepEqual(
        [ana, ben, cai].map((credential) => exchangesOf(harness, credential)),
        [1, 2, 1],
      );
      await harness.core.stop();
    });

    test('evicts the least recently used refusal, which is asked again, and refuses one used since from the store', async () => {
      const harness = await bounded();
      const ana = signInToken({ sub: 'subject-revoked-ana' });
      const ben = signInToken({ sub: 'subject-revoked-ben' });
      const cai = signInToken({ sub: 'subject-revoked-cai' });

      await harness.core.resolve(ana);
      await harness.core.resolve(ben);
      await harness.core.resolve(ana);
      await harness.core.resolve(cai);
      const outcomes = [
        await harness.core.resolve(ana),
        await harness.core.resolve(ben),
      ];

      assert.deepEqual(outcomes, [{ kind: 'refused' }, { kind: 'refused' }]);
      assert.deepEqual(
        [ana, ben, cai].map((credential) => exchangesOf(harness, credential)),
        [1, 2, 1],
      );
      assert.deepEqual(
        harness.events('credential.refusal').map(({ data }) => data['origin']),
        [
          'controller',
          'controller',
          'cachedRefusal',
          'controller',
          'cachedRefusal',
          'controller',
        ],
      );
      await harness.core.stop();
    });

    test('keeps a controller refusal in the store however many tokens past their exp are refused locally', async () => {
      const harness = await bounded();
      const revoked = signInToken({ sub: 'subject-revoked-ana' });
      const expSeconds = ANONYMOUS.iat - 60;
      const expiredBen = signInToken({ exp: expSeconds, sub: 'subject-ben' });
      const expiredCai = signInToken({ exp: expSeconds, sub: 'subject-cai' });
      const expiredDee = signInToken({ exp: expSeconds, sub: 'subject-dee' });

      await harness.core.resolve(revoked);
      await harness.core.resolve(expiredBen);
      await harness.core.resolve(expiredCai);
      await harness.core.resolve(expiredDee);
      const again = await harness.core.resolve(revoked);

      assert.deepEqual(again, { kind: 'refused' });
      assert.equal(exchangesOf(harness, revoked), 1);
      assert.deepEqual(
        harness.events('credential.refusal').map(({ data }) => data['origin']),
        [
          'controller',
          'localExpiry',
          'localExpiry',
          'localExpiry',
          'cachedRefusal',
        ],
      );
      await harness.core.stop();
    });

    test('evicts the least recently used failure hold, so that credential is exchanged again, and keeps holding one used since', async () => {
      const harness = await bounded();
      const ana = signInToken({ sub: 'subject-ana' });
      const ben = signInToken({ sub: 'subject-ben' });
      const cai = signInToken({ sub: 'subject-cai' });
      [ana, ben, cai].forEach((credential) => {
        harness.answers.set(credential, { cause: 'timeout', kind: 'failed' });
      });

      await accessOf(harness.core, ana);
      await accessOf(harness.core, ben);
      await accessOf(harness.core, ana);
      await accessOf(harness.core, cai);
      await accessOf(harness.core, ana);
      await accessOf(harness.core, ben);

      assert.deepEqual(
        [ana, ben, cai].map((credential) => exchangesOf(harness, credential)),
        [1, 2, 1],
      );
      await harness.core.stop();
    });

    test('shares one interned result among equal results up to 4,096 distinct ones, then evicts the least recently used', async () => {
      const harness = await running();
      const anonymousResults = (await accessOf(harness.core, null)).results;
      const resultsOf = async (
        credential: string,
        payload: PermissionsPayload,
      ): Promise<UsherRequestAccess['results']> => {
        harness.issue(credential, payload);
        return (await accessOf(harness.core, credential)).results;
      };
      /** A payload holding one study of its own, so that each renders to a result of its own. */
      const distinct = (index: number): PermissionsPayload => ({
        ...signedIn('05', `subject-${index}`),
        permissions: {
          [`STUDY_${index}`]: { 'global.unmarked': { record: ['view'] } },
        },
        resourceCategories: { [`STUDY_${index}`]: [] },
        servedResources: [`STUDY_${index}`],
      });
      const openTier = (index: number): PermissionsPayload => ({
        ...ANONYMOUS,
        sub: `subject-open-${index}`,
      });

      // With the anonymous results, interned at install, 4,095 distinct results fill the pool.
      const firstDistinct = await resultsOf('uak_distinct_1', distinct(1));
      for (const index of Array.from(
        { length: 4_094 },
        (_, offset) => offset + 2,
      )) {
        await resultsOf(`uak_distinct_${index}`, distinct(index));
      }
      const openTierAtBound = await resultsOf('uak_open_1', openTier(1));
      // One more passes the bound, and the first distinct result is now the least recently used.
      await resultsOf('uak_distinct_4096', distinct(4_096));
      const openTierPastBound = await resultsOf('uak_open_2', openTier(2));
      const firstAgain = await resultsOf('uak_distinct_1_again', {
        ...distinct(1),
        sub: 'subject-1-again',
      });

      assert.equal(openTierAtBound, anonymousResults);
      assert.equal(openTierPastBound, anonymousResults);
      assert.notEqual(firstAgain, firstDistinct);
      assert.deepEqual(firstAgain, firstDistinct);
      await harness.core.stop();
    });

    /** 4,097 resource category names, one more than the gaps of each kind remembered as logged. */
    const pastTheBound: CategoryName[] = Array.from(
      { length: 4_097 },
      (_, index): CategoryName => `resource.c${index}`,
    );

    /** How many times each category was named by an event of the type, in the order asked. */
    const timesLogged = (
      harness: Harness,
      type: string,
      categories: readonly CategoryName[],
    ): number[] =>
      categories.map(
        (category) =>
          harness
            .events(type)
            .filter(({ data }) => data['category'] === category).length,
      );

    test('remembers 4,096 category.unmapped gaps as logged, logging one evicted past that bound again and never one still remembered', async () => {
      const harness = await running();
      /** A payload in which HEART_STUDY offers the categories, none defined by the catalogue. */
      const offering = (
        sub: string,
        offered: readonly CategoryName[],
      ): PermissionsPayload => {
        const payload = signedIn('05', sub);
        return {
          ...payload,
          resourceCategories: {
            ...payload.resourceCategories,
            HEART_STUDY: [...offered],
          },
        };
      };
      const ana = signInToken({ sub: 'subject-ana' });
      const ben = signInToken({ sub: 'subject-ben' });
      harness.issue(ana, offering('subject-ana', pastTheBound));
      harness.issue(
        ben,
        offering('subject-ben', ['resource.c0', 'resource.c4096']),
      );

      await accessOf(harness.core, ana);
      await accessOf(harness.core, ben);

      assert.deepEqual(
        timesLogged(harness, 'category.unmapped', [
          'resource.c0',
          'resource.c1',
          'resource.c4096',
        ]),
        [2, 1, 1],
      );
      await harness.core.stop();
    });

    test('remembers 4,096 category.unknown gaps as logged, logging one evicted past that bound again and never one still remembered', async () => {
      const harness = await running({
        files: {
          ...catalogue,
          categories: {
            ...catalogue.categories,
            resource: {
              PILOT_STUDY: Object.fromEntries(
                pastTheBound.map((category, index) => [
                  category,
                  inCondition('cohort', [`cohort-${index}`]),
                ]),
              ),
            },
          },
        },
      });
      /**
       * A payload naming PILOT_STUDY, offering there the categories and `resource.offered`, not
       * defined by the catalogue, so PILOT_STUDY is withheld rather than narrowed over every
       * category.
       */
      const offering = (
        sub: string,
        offered: readonly CategoryName[],
      ): PermissionsPayload => {
        const payload = signedIn('05', sub);
        return {
          ...payload,
          permissions: {
            ...payload.permissions,
            PILOT_STUDY: { 'global.unmarked': { record: ['view'] } },
          },
          resourceCategories: {
            ...payload.resourceCategories,
            PILOT_STUDY: ['resource.offered', ...offered],
          },
          servedResources: [...payload.servedResources, 'PILOT_STUDY'],
        };
      };
      const ana = signInToken({ sub: 'subject-ana' });
      const ben = signInToken({ sub: 'subject-ben' });
      harness.issue(ana, offering('subject-ana', []));
      harness.issue(ben, offering('subject-ben', pastTheBound.slice(1, -1)));

      await accessOf(harness.core, ana);
      await accessOf(harness.core, ben);

      assert.deepEqual(
        timesLogged(harness, 'category.unknown', [
          'resource.c0',
          'resource.c1',
          'resource.c4096',
        ]),
        [2, 1, 1],
      );
      await harness.core.stop();
    });
  });

  suite('when a refusal ends', () => {
    test('asks the controller again once a refusal reaches its TTL on the monotonic clock, and not a millisecond sooner', async () => {
      const harness = await running();
      const credential = signInToken({ sub: 'subject-revoked' });
      await harness.core.resolve(credential);

      harness.confirm(299_999);
      harness.advanceMonotonic(299_999);
      const beforeTtl = await harness.core.resolve(credential);
      const exchangedBeforeTtl = exchangesOf(harness, credential);
      harness.confirm(300_000);
      harness.advanceMonotonic(1);
      const atTtl = await harness.core.resolve(credential);

      assert.deepEqual(
        [beforeTtl, atTtl],
        [{ kind: 'refused' }, { kind: 'refused' }],
      );
      assert.equal(exchangedBeforeTtl, 1);
      assert.equal(exchangesOf(harness, credential), 2);
      await harness.core.stop();
    });

    test("asks the controller again once a refusal reaches its sign-in token's exp on the wall clock, and not a millisecond sooner", async () => {
      const harness = await running();
      const credential = signInToken({
        exp: ANONYMOUS.iat + 100,
        sub: 'subject-revoked',
      });
      await harness.core.resolve(credential);

      harness.advanceWall(99_999);
      const beforeExp = await harness.core.resolve(credential);
      const exchangedBeforeExp = exchangesOf(harness, credential);
      harness.advanceWall(1);
      const atExp = await harness.core.resolve(credential);

      assert.deepEqual(
        [beforeExp, atExp],
        [{ kind: 'refused' }, { kind: 'refused' }],
      );
      assert.equal(exchangedBeforeExp, 1);
      assert.equal(exchangesOf(harness, credential), 2);
      await harness.core.stop();
    });
  });
});
