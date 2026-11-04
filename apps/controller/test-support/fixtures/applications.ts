import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';

import {
  type AdminCaller,
  type ApplicationRegistration,
  assertSucceeded,
  type IssuedApplicationKey,
  issueApplicationKey,
  issuedApplicationKeyOf,
  managementClaims,
  registerApplication,
  type RegisteredApplication,
  registeredApplicationOf,
} from '../admin.js';
import type { KeycloakPerson, KeycloakRealmOptions } from '../containers.js';
import type { ControllerApplication } from '../controller.js';
import {
  exchange,
  type ExchangeRequest,
  PEOPLE,
  type WireResponse,
} from '../exchange.js';
import {
  APPLICATION_KEY_RELOAD_INTERVAL_MILLISECONDS,
  configurationToRead,
  type Harness,
  type HarnessOptions,
} from '../harness.js';
import { mintServiceAccountToken } from '../identityProvider.js';
import { POLICY_TABLES, qualified } from '../policy.js';

// The helpers of the application suites alone: the Policy Management API for applications and their
// keys, under test/admin/applications/, and the exchange's side of those keys, under
// test/exchange/applicationKeys/. Every path, body, answer reader, refusal and vocabulary comes
// from admin.ts, and every table from policy.ts. The harness of these suites registers no application
// of its own, so every application read by a test is one registered by it, or by a harness the test
// started to register one. The people are the shared
// cast: the administrator and the second administrator are each one by the management token's realm
// role alone, and the outsider holds no administrator role.

/** The people named by the tests, by their parts. */
export const CAST = Object.freeze({
  administrator: PEOPLE.administrator,
  outsider: PEOPLE.ana,
  secondAdministrator: PEOPLE.owner,
});

/** The harness options of every application suite: no application registered by the harness. */
export const APPLICATION_SUITE: HarnessOptions = Object.freeze({
  applications: [],
});

const REGISTERING = configurationToRead();

const realmPerson = (
  username: string,
  realmRoles: readonly string[],
): KeycloakPerson => ({
  email: username,
  password: randomBytes(18).toString('base64url'),
  realmRoles,
  username,
});

/**
 * The username of {@link REGISTRAR_REALM}'s administrator, who registers a realm harness's
 * applications.
 */
export const REALM_ADMINISTRATOR = 'registrar@example.org';

/**
 * A Keycloak realm for a harness registering its applications as the realm's own administrator: the
 * harness's management client, naming the management API; {@link REALM_ADMINISTRATOR}, holding the
 * configured administrator role; and a person holding none.
 */
export const REGISTRAR_REALM: KeycloakRealmOptions = Object.freeze({
  clients: [
    {
      audiences: [REGISTERING.managementAudience],
      clientId: REGISTERING.managementClients[0] ?? 'usher-ui-test',
    },
  ],
  people: [
    realmPerson(REALM_ADMINISTRATOR, [REGISTERING.administratorRole]),
    realmPerson('bystander@example.org', []),
  ],
  realm: 'usher-applications-test',
  realmRoles: [REGISTERING.administratorRole],
});

/** A uuid in its text form, as every application's id and every key's id is generated. */
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The controller's clock and the test's may differ by the container host's drift. */
export const CLOCK_TOLERANCE_MS = 30_000;

/**
 * Whether a key is 32 bytes as 43 base64url characters in canonical form: every application key's form.
 *
 * @param key the key's value.
 */
export const isCanonicalKey = (key: string): boolean =>
  /^[\w-]{43}$/u.test(key) &&
  Buffer.from(key, 'base64url').toString('base64url') === key;

/**
 * A key's value in each of its forms, base64url, base64 and hex, for a search of an answer or a log
 * line.
 *
 * @param value the key's value.
 */
export const keyForms = (value: string): readonly string[] => {
  const bytes = Buffer.from(value, 'base64url');
  return [value, bytes.toString('base64'), bytes.toString('hex')];
};

/**
 * Application ids naming no registered application, each answered `applicationNotFound` alike: a
 * well-formed unknown one, and malformed ones.
 */
export const absentApplicationIds = (): readonly {
  id: string;
  name: string;
}[] => [
  { id: randomUUID(), name: 'an unknown id' },
  { id: 'not-a-uuid', name: 'a malformed id' },
  { id: `${randomUUID()}0`, name: 'a uuid with a character added' },
];

/**
 * Registers an application, failing the test unless the registration succeeds, and gives the
 * answer's application and first key.
 *
 * @param caller a platform administrator.
 * @param registration the display name and the description.
 */
export const registered = async (
  caller: AdminCaller,
  registration: ApplicationRegistration,
): Promise<RegisteredApplication> => {
  const label = `registering ${registration.displayName}`;
  const response = await registerApplication(caller, registration);
  assertSucceeded(response, label);
  return registeredApplicationOf(response, label);
};

/**
 * Issues another key for an application, failing the test unless the issue succeeds, and gives the
 * answer's key.
 *
 * @param caller a platform administrator.
 * @param applicationId the application's id.
 */
export const issued = async (
  caller: AdminCaller,
  applicationId: string,
): Promise<IssuedApplicationKey> => {
  const label = `issuing a key for ${applicationId}`;
  const response = await issueApplicationKey(caller, applicationId);
  assertSucceeded(response, label);
  return issuedApplicationKeyOf(response, label);
};

/**
 * An application's id and one key's value, for an exchange made with that key: its first key by
 * default.
 *
 * @param application the registration's answer.
 * @param key the key held by the bridge.
 */
export const heldBy = (
  application: Pick<RegisteredApplication, 'id' | 'key'>,
  key: IssuedApplicationKey = application.key,
): ControllerApplication => ({ id: application.id, key: key.value });

/**
 * Sends the anonymous exchange through an application, as its bridge sends one: no credential, and a
 * fresh channel assertion signed under the key given unless the request names another assertion.
 *
 * @param url the instance exchanged with, its URL ending in `/`.
 * @param application the application's id and the key signing.
 * @param request a given assertion, and a signal aborting the exchange.
 */
export const anonymousExchange = (
  url: URL,
  application: ControllerApplication,
  { assertion, signal }: Pick<ExchangeRequest, 'assertion' | 'signal'> = {},
): Promise<WireResponse> =>
  exchange(url, {
    application,
    ...(assertion === undefined ? {} : { assertion }),
    credential: null,
    ...(signal === undefined ? {} : { signal }),
  });

/**
 * How long an instance may take to learn a registration, an issue or a revocation through the cache's
 * wake-up, in milliseconds: shorter than the reload interval, so a change learned within it by an
 * instance started just before the change was learned through the wake-up rather than the reload.
 */
export const WAKE_WITHIN_MS = 10_000;

/**
 * How long, in real time, an instance may take to reload its keys once its configured clock has passed
 * the reload interval, in milliseconds: the controller reads its clock on a timer of its own, with a
 * period fixed by nothing, so this allows for it while staying far below the interval itself.
 */
export const RELOAD_WITHIN_MS = 5_000;

/** The reload interval, and a moment past it, by which a test moves an instance's clock forward. */
export const PAST_THE_RELOAD_INTERVAL_MS =
  APPLICATION_KEY_RELOAD_INTERVAL_MILLISECONDS + 1_000;

/**
 * The counts of applications and application keys held in the store, for a test showing that a
 * refusal wrote nothing.
 *
 * @param client a connection under the migration role.
 */
export const applicationRowCounts = async (
  client: pg.ClientBase,
): Promise<{ applications: number; keys: number }> => {
  const { applicationKeys, applications } = POLICY_TABLES;
  const { rows } = await client.query<{ applications: number; keys: number }>(
    `SELECT (SELECT count(*)::int FROM ${qualified(applications)}) AS ${pg.escapeIdentifier('applications')}, (SELECT count(*)::int FROM ${qualified(applicationKeys)}) AS ${pg.escapeIdentifier('keys')}`,
  );
  return rows[0] ?? { applications: 0, keys: 0 };
};

/**
 * A service account's client-credentials token in Keycloak's shape, without and with the
 * administrator role, each refused 403 `serviceAccountNotPermitted` on every operation.
 *
 * @param harness the harness, its configuration listing the service account's client.
 */
export const serviceAccountTokens = async (
  harness: Harness,
): Promise<readonly { label: string; token: string }[]> => [
  {
    label: 'a client-credentials token',
    token: await mintServiceAccountToken(
      harness.identityProvider,
      harness.configuration,
    ),
  },
  {
    label: 'a client-credentials token with the administrator role',
    token: await mintServiceAccountToken(
      harness.identityProvider,
      harness.configuration,
      {
        mint: {
          claims: {
            realm_access: managementClaims(
              harness.identityProvider,
              harness.configuration,
              CAST.administrator,
              true,
            )['realm_access'],
          },
        },
      },
    ),
  },
];
