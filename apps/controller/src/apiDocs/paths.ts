/** The path the API documentation page is served at, under which every file it loads is served. */
export const API_DOCS_PATH = '/api-docs';

/** The path of the contract the page shows. */
export const CONTRACT_PATH = `${API_DOCS_PATH}/openapi.json`;

/** The path of the script starting Swagger UI on the page. */
export const INITIALIZER_PATH = `${API_DOCS_PATH}/initializer.js`;

/** The path the identity provider redirects a sign-in back to, which must be a redirect URI of the page's client. */
export const REDIRECT_PATH = `${API_DOCS_PATH}/oauth2-redirect.html`;
