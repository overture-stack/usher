import { PAGE_ELEMENT_ID } from './page.js';
import { API_DOCS_PATH, CONTRACT_PATH, REDIRECT_PATH } from './paths.js';
import { END_SESSION_MEMBER, SIGN_IN_SCHEME } from './servedSpec.js';

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
 * @param clientId the client used by the page to sign people in.
 */
export const initializerScript = (clientId: string): string => `'use strict';
const clientId = ${JSON.stringify(clientId)};
const signInScheme = ${JSON.stringify(SIGN_IN_SCHEME)};
const endSessionMember = ${JSON.stringify(END_SESSION_MEMBER)};
const endSessionPlugin = (system) => ({
  statePlugins: {
    auth: {
      wrapActions: {
        logout: (original) => (names) => {
          const result = original(names);
          const endSession = system.specSelectors
            .specJson()
            .getIn(['components', 'securitySchemes', signInScheme, endSessionMember]);
          if (Array.isArray(names) && names.includes(signInScheme) && typeof endSession === 'string') {
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
});
SwaggerUIBundle({
  dom_id: ${JSON.stringify(`#${PAGE_ELEMENT_ID}`)},
  layout: 'BaseLayout',
  oauth2RedirectUrl: window.location.origin + ${JSON.stringify(REDIRECT_PATH)},
  persistAuthorization: false,
  plugins: [endSessionPlugin],
  presets: [SwaggerUIBundle.presets.apis],
  queryConfigEnabled: false,
  url: ${JSON.stringify(CONTRACT_PATH)},
  validatorUrl: null,
}).initOAuth({
  clientId,
  scopes: ['openid'],
  usePkceWithAuthorizationCodeGrant: true,
});
`;
