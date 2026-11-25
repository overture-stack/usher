import { PAGE_ELEMENT_ID } from './page.js';
import { API_DOCS_PATH, CONTRACT_PATH, REDIRECT_PATH } from './paths.js';
import { END_SESSION_MEMBER, SIGN_IN_SCHEME } from './servedSpec.js';

// The most time left on a sign-in's token when the page renews it.
const RENEWAL_MARGIN_MILLISECONDS = 30_000;

/**
 * The script starting Swagger UI on the page, from the served contract, with its base layout and the
 * API preset alone, so the page offers no box loading another contract. Configuration from the
 * page's query, the online validator and authorization kept across reloads are each turned off. It
 * signs in through the client given, by the authorization code flow with PKCE, asking for the
 * `openid` scope alone and holding no secret, its redirect URL built in the browser from the page's
 * origin. The client is written as a JSON string, so any character it holds stays within it.
 *
 * A sign-out from the sign-in scheme also ends the identity provider's session: once the page has
 * forgotten the token, the browser goes to the end-session endpoint the served contract names, with
 * the client and the page's own address to return to, and no ID token, so none ever appears in a URL.
 * Ending the session there sends the Controller its back-channel sign-out, and the page loads afresh
 * on its return, so nothing of the sign-in before is left in it. Where the contract names no such
 * endpoint, a sign-out only forgets the token.
 *
 * A sign-in through the scheme is renewed before its token lapses, while the identity provider's
 * session lives, with no visible sign-in. When 30 seconds of the token's `expires_in` are left, or
 * halfway through the life of a token living under a minute, the page asks the token endpoint the
 * contract names for a new token by POST, with the refresh token Swagger UI already holds from the
 * sign-in. It holds the answer in its place, keeping the refresh token where the answer carries none.
 * A request carrying the held token once its renewal is due, as after a tab has slept past its timer,
 * waits for that renewal and is sent with the new token, and only one renewal is asked for at a time.
 * A renewal the identity provider refuses, cannot answer, or answers without an access token, and a
 * token lapsing with no refresh token held, show the person signed out, the page staying where it is;
 * a due request is then sent with no token. Signing out, or in again, cancels the renewal set before.
 * A token naming no positive `expires_in` sets no renewal. Nothing is written to storage or to an address, and the token endpoint is at the issuer's origin,
 * which the content security policy already allows connections to.
 *
 * @param clientId the client used by the page to sign people in.
 */
export const initializerScript = (clientId: string): string => `'use strict';
const clientId = ${JSON.stringify(clientId)};
const signInScheme = ${JSON.stringify(SIGN_IN_SCHEME)};
const endSessionMember = ${JSON.stringify(END_SESSION_MEMBER)};
const renewalMarginMilliseconds = ${RENEWAL_MARGIN_MILLISECONDS};
const session = { dueAt: undefined, quiet: false, renewing: undefined, system: undefined, timer: undefined };
const held = (system) => system.authSelectors.authorized().toJS()[signInScheme];
const cancelRenewal = () => {
  if (session.timer !== undefined) {
    window.clearTimeout(session.timer);
  }
  session.dueAt = undefined;
  session.timer = undefined;
};
const signOutQuietly = (system) => {
  session.quiet = true;
  try {
    system.authActions.logout([signInScheme]);
  } finally {
    session.quiet = false;
  }
};
const askForRenewal = async (system) => {
  const auth = held(system);
  const refreshToken = auth?.token?.refresh_token;
  const tokenUrl = auth?.schema?.tokenUrl;
  if (typeof refreshToken !== 'string' || typeof tokenUrl !== 'string') {
    signOutQuietly(system);
    return undefined;
  }
  const answer = await window
    .fetch(tokenUrl, {
      body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined);
  if (typeof answer !== 'object' || answer === null || typeof answer.access_token !== 'string') {
    signOutQuietly(system);
    return undefined;
  }
  const token = { ...answer, refresh_token: typeof answer.refresh_token === 'string' ? answer.refresh_token : refreshToken };
  system.authActions.authorizeOauth2({ auth, token });
  return token.access_token;
};
const renew = (system) => {
  session.renewing ??= askForRenewal(system).finally(() => {
    session.renewing = undefined;
  });
  return session.renewing;
};
const setRenewal = (system, token) => {
  cancelRenewal();
  if (typeof token?.expires_in !== 'number' || !(token.expires_in > 0)) {
    return;
  }
  const lifeMilliseconds = token.expires_in * 1000;
  const delay = Math.max(0, lifeMilliseconds - Math.min(renewalMarginMilliseconds, lifeMilliseconds / 2));
  session.dueAt = Date.now() + delay;
  session.timer = window.setTimeout(() => {
    renew(system);
  }, delay);
};
const sessionPlugin = (system) => {
  session.system = system;
  return {
    statePlugins: {
      auth: {
        wrapActions: {
          authorizeOauth2: (original) => (payload) => {
            const result = original(payload);
            if (payload?.auth?.name === signInScheme) {
              setRenewal(system, payload.token);
            }
            return result;
          },
          logout: (original) => (names) => {
            const signingOut = Array.isArray(names) && names.includes(signInScheme);
            if (signingOut) {
              cancelRenewal();
            }
            const result = original(names);
            const endSession = system.specSelectors
              .specJson()
              .getIn(['components', 'securitySchemes', signInScheme, endSessionMember]);
            if (signingOut && !session.quiet && typeof endSession === 'string') {
              const target = new URL(endSession);
              target.searchParams.set('client_id', clientId);
              target.searchParams.set('post_logout_redirect_uri', window.location.origin + ${JSON.stringify(API_DOCS_PATH)});
              window.location.assign(target.href);
            }
            return result;
          },
        },
      },
    },
  };
};
const requestInterceptor = async (request) => {
  const { system } = session;
  const accessToken = system === undefined ? undefined : held(system)?.token?.access_token;
  const due = session.dueAt !== undefined && Date.now() >= session.dueAt;
  if (!due || typeof accessToken !== 'string' || request.headers?.Authorization !== 'Bearer ' + accessToken) {
    return request;
  }
  const renewed = await renew(system);
  const { Authorization: _lapsing, ...headers } = request.headers;
  request.headers = renewed === undefined ? headers : { ...headers, Authorization: 'Bearer ' + renewed };
  return request;
};
SwaggerUIBundle({
  dom_id: ${JSON.stringify(`#${PAGE_ELEMENT_ID}`)},
  layout: 'BaseLayout',
  oauth2RedirectUrl: window.location.origin + ${JSON.stringify(REDIRECT_PATH)},
  persistAuthorization: false,
  plugins: [sessionPlugin],
  presets: [SwaggerUIBundle.presets.apis],
  queryConfigEnabled: false,
  requestInterceptor,
  url: ${JSON.stringify(CONTRACT_PATH)},
  validatorUrl: null,
}).initOAuth({
  clientId,
  scopes: ['openid'],
  usePkceWithAuthorizationCodeGrant: true,
});
`;
