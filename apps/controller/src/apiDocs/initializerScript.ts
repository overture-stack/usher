import { PAGE_ELEMENT_ID } from './page.js';
import { CONTRACT_PATH, REDIRECT_PATH } from './paths.js';

/**
 * The script starting Swagger UI on the page, from the served contract, with its base layout and the
 * API preset alone, so the page offers no box loading another contract. Configuration from the
 * page's query, the online validator and authorization kept across reloads are each turned off. It
 * signs in through the client given, by the authorization code flow with PKCE, asking for the
 * `openid` scope alone and holding no secret, its redirect URL built in the browser from the page's
 * origin. The client is written as a JSON string, so any character it holds stays within it.
 *
 * @param clientId the client used by the page to sign people in.
 */
export const initializerScript = (clientId: string): string => `'use strict';
SwaggerUIBundle({
  dom_id: ${JSON.stringify(`#${PAGE_ELEMENT_ID}`)},
  layout: 'BaseLayout',
  oauth2RedirectUrl: window.location.origin + ${JSON.stringify(REDIRECT_PATH)},
  persistAuthorization: false,
  presets: [SwaggerUIBundle.presets.apis],
  queryConfigEnabled: false,
  url: ${JSON.stringify(CONTRACT_PATH)},
  validatorUrl: null,
}).initOAuth({
  clientId: ${JSON.stringify(clientId)},
  scopes: ['openid'],
  usePkceWithAuthorizationCodeGrant: true,
});
`;
