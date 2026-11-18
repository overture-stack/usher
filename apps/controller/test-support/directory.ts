import { createHash, randomBytes } from 'node:crypto';

import type { KeycloakDirectory } from './containers.js';
import {
  type RecordedRequest,
  type ScriptedAnswer,
  startRecordingServer,
} from './recordingServer.js';

/** An account the directory stand-in holds, as Keycloak's admin API represents a user. */
export interface DirectoryAccount {
  email: string;

  /** Whether the address is verified: true by default. */
  emailVerified?: boolean;

  /** Whether the account is enabled: true by default. */
  enabled?: boolean;

  /** The given name, Keycloak's `firstName`: one made from the id by default ({@link directoryNamesOf}), none when `null`. */
  firstName?: string | null;

  /** The account's id, which the realm's tokens carry as `sub`: the identity provider's subject. */
  id: string;

  /** The family name, Keycloak's `lastName`: one made from the id by default ({@link directoryNamesOf}), none when `null`. */
  lastName?: string | null;

  /** The username: the address by default. */
  username?: string;
}

/** An account's names as the stand-in gives them: each a string, or `null` for none. */
export interface DirectoryNames {
  firstName: string | null;
  lastName: string | null;
}

/**
 * The names the stand-in gives an account: those it was given, `null` for one given as `null`, and
 * otherwise a given name and a family name made from its id, `Given-` and `Family-` with six hex
 * digits of the id's digest, invented and unlike any other text a test writes, so a scan of what the
 * Controller stored can show that no name ever reaches the store.
 *
 * @param account the account.
 */
export const directoryNamesOf = ({
  firstName,
  id,
  lastName,
}: DirectoryAccount): DirectoryNames => {
  const tag = createHash('sha256').update(id).digest('hex').slice(0, 6);
  return {
    firstName: firstName === undefined ? `Given-${tag}` : firstName,
    lastName: lastName === undefined ? `Family-${tag}` : lastName,
  };
};

/** One lookup of accounts the stand-in received, answered or refused. */
export interface DirectoryLookup {
  /** The address looked up, as sent; `undefined` for a lookup by id. */
  email: string | undefined;

  /** The account id looked up; `undefined` for a lookup by address. */
  id: string | undefined;

  /** The status it was answered with. */
  status: number;
}

/**
 * A stand-in for the identity provider's directory (#216 Q9), lighter than a Keycloak and set per
 * test: it answers the parts of Keycloak's admin API the Controller's directory reads, behind a token
 * from the client credentials grant, as a realm does.
 */
export interface DirectoryStandIn {
  /** The configuration fields pointing the Controller's directory at the stand-in. */
  configuration: KeycloakDirectory;

  /**
   * Answers every lookup of an account by id on 503 from now on, while lookups by address are answered
   * as before: a directory failing as a Keycloak member's subject is sought, which never counts as the
   * directory not knowing the subject.
   */
  failLookupsById(): void;

  /**
   * Answers every lookup from the one numbered here on 503, counting from 1 over the stand-in's whole
   * life, as a directory failing part way through a migration's run does.
   */
  failLookupsFrom(lookup: number): void;

  /** Every lookup received, in order. */
  lookups(): readonly DirectoryLookup[];

  /** Replaces the accounts it holds: one, none, one disabled, or two holding one address, as a test needs. */
  setAccounts(accounts: readonly DirectoryAccount[]): void;

  /** Settles once the stand-in has stopped, every connection closed. */
  stop(): Promise<void>;
}

/** What the directory stand-in starts with. */
export interface DirectoryOptions {
  /** The accounts it holds: none by default. */
  accounts?: readonly DirectoryAccount[];

  /** The realm in its paths: `overture` by default. */
  realm?: string;
}

/** The client the Controller's directory signs in as, through the client credentials grant. */
const DIRECTORY_CLIENT = 'usher-directory';

const json = (status: number, body: unknown): ScriptedAnswer => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  status,
});

// Keycloak's user representation leaves out a name an account does not hold.
const representation = (
  account: DirectoryAccount,
): Readonly<Record<string, unknown>> => {
  const { email, emailVerified = true, enabled = true, id, username } = account;
  const { firstName, lastName } = directoryNamesOf(account);
  return {
    createdTimestamp: 1_767_225_600_000,
    email: email.toLowerCase(),
    emailVerified,
    enabled,
    ...(firstName === null ? {} : { firstName }),
    id,
    ...(lastName === null ? {} : { lastName }),
    username: (username ?? email).toLowerCase(),
  };
};

const basicCredentials = (
  header: string | undefined,
): { id: string; secret: string } | undefined => {
  const [scheme, encoded] = (header ?? '').split(' ');
  if (scheme?.toLowerCase() === 'basic' && encoded !== undefined) {
    const [id = '', secret = ''] = Buffer.from(encoded, 'base64')
      .toString('utf8')
      .split(':');
    return { id: decodeURIComponent(id), secret: decodeURIComponent(secret) };
  }
  return undefined;
};

/**
 * Starts a directory stand-in on loopback. It answers, under `/realms/<realm>` and
 * `/admin/realms/<realm>` as a Keycloak realm does:
 * - `POST .../protocol/openid-connect/token`, the client credentials grant for its one client, with the
 *   secret in the form or as HTTP Basic, giving a bearer token; any other client or secret 401;
 * - `GET .../users?email=<address>`, every account holding the address in any letter case when
 *   `exact=true`, and every one whose address contains it otherwise, as Keycloak stores and matches
 *   addresses in lower case, disabled accounts included with `enabled: false`;
 * - `GET .../users/<id>`, one account by the subject the realm's tokens carry, or 404 for an id no
 *   account holds, an address or another provider's id among them.
 * Each account carries its names as Keycloak's representation does, `firstName` and `lastName`
 * ({@link directoryNamesOf}), whichever way it is looked up. A test sets the accounts it holds
 * ({@link DirectoryStandIn.setAccounts}), and fails lookups from a numbered one on, or every lookup
 * by id. Every admin request needs a token it issued, or is answered 401. The two tests whose
 * outcome is Keycloak's own (address matching in any letter case, two accounts holding one address)
 * use the real realm in `containers.ts` instead.
 *
 * @param options the accounts it holds, and the realm.
 */
export const startDirectory = async ({
  accounts = [],
  realm = 'overture',
}: DirectoryOptions = {}): Promise<DirectoryStandIn> => {
  const secret = randomBytes(24).toString('base64url');
  const state: {
    accounts: readonly DirectoryAccount[];
    failingById: boolean;
    failingFrom: number | undefined;
    lookups: readonly DirectoryLookup[];
    tokens: ReadonlySet<string>;
  } = {
    accounts,
    failingById: false,
    failingFrom: undefined,
    lookups: [],
    tokens: new Set(),
  };
  const tokenPath = `/realms/${realm}/protocol/openid-connect/token`;
  const usersPath = `/admin/realms/${realm}/users`;
  const issueToken = (request: RecordedRequest): ScriptedAnswer => {
    const form = new URLSearchParams(request.body);
    const basic = basicCredentials(request.headers.authorization);
    const client = basic?.id ?? form.get('client_id');
    const given = basic?.secret ?? form.get('client_secret');
    if (
      form.get('grant_type') === 'client_credentials' &&
      client === DIRECTORY_CLIENT &&
      given === secret
    ) {
      const token = randomBytes(24).toString('base64url');
      state.tokens = new Set([...state.tokens, token]);
      return json(200, {
        access_token: token,
        expires_in: 300,
        token_type: 'Bearer',
      });
    }
    return json(401, { error: 'unauthorized_client' });
  };
  const lookUp = (url: URL): ScriptedAnswer => {
    const id = url.pathname.startsWith(`${usersPath}/`)
      ? decodeURIComponent(url.pathname.slice(usersPath.length + 1))
      : undefined;
    const email =
      id === undefined ? (url.searchParams.get('email') ?? '') : undefined;
    const failing =
      (state.failingById && id !== undefined) ||
      (state.failingFrom !== undefined &&
        state.lookups.length + 1 >= state.failingFrom);
    const exact = url.searchParams.get('exact') === 'true';
    const matching = state.accounts.filter((account) =>
      email === undefined
        ? account.id === id
        : exact
          ? account.email.toLowerCase() === email.toLowerCase()
          : account.email.toLowerCase().includes(email.toLowerCase()),
    );
    const [account] = matching;
    const answer: ScriptedAnswer = failing
      ? json(503, { error: 'unavailable' })
      : email !== undefined
        ? json(200, matching.map(representation))
        : account !== undefined
          ? json(200, representation(account))
          : json(404, { error: 'User not found' });
    state.lookups = [
      ...state.lookups,
      { email, id, status: 'status' in answer ? answer.status : 200 },
    ];
    return answer;
  };
  const server = await startRecordingServer((request) => {
    const url = new URL(request.target, 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === tokenPath) {
      return issueToken(request);
    }
    if (
      request.method === 'GET' &&
      (url.pathname === usersPath || url.pathname.startsWith(`${usersPath}/`))
    ) {
      const [scheme, token] = (request.headers.authorization ?? '').split(' ');
      return scheme?.toLowerCase() === 'bearer' &&
        token !== undefined &&
        state.tokens.has(token)
        ? lookUp(url)
        : json(401, { error: 'HTTP 401 Unauthorized' });
    }
    return json(404, {
      error: 'Unable to find matching target resource method',
    });
  });
  return {
    configuration: {
      directoryClientId: DIRECTORY_CLIENT,
      directoryClientSecret: secret,
      directoryRealm: realm,
      directoryUrl: server.url.href.replace(/\/$/u, ''),
    },
    failLookupsById: () => {
      state.failingById = true;
    },
    failLookupsFrom: (lookup) => {
      state.failingFrom = lookup;
    },
    lookups: () => state.lookups,
    setAccounts: (replacing) => {
      state.accounts = replacing;
    },
    stop: () => server.stop(),
  };
};
