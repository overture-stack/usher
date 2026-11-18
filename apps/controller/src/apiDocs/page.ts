import { API_DOCS_PATH, INITIALIZER_PATH } from './paths.js';

/** The id of the page's element Swagger UI renders into. */
export const PAGE_ELEMENT_ID = 'swagger-ui';

/**
 * The API documentation page: Swagger UI's icons, stylesheet and bundle, then the initializer, each
 * named by an absolute path under the page's own, so each loads from the Controller's origin. It
 * holds no inline script, no style element or attribute, and no event handler attribute.
 */
export const API_DOCS_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Usher Controller API</title>
    <link rel="icon" type="image/png" href="${API_DOCS_PATH}/favicon-32x32.png" sizes="32x32">
    <link rel="icon" type="image/png" href="${API_DOCS_PATH}/favicon-16x16.png" sizes="16x16">
    <link rel="stylesheet" href="${API_DOCS_PATH}/swagger-ui.css">
  </head>
  <body>
    <div id="${PAGE_ELEMENT_ID}"></div>
    <script src="${API_DOCS_PATH}/swagger-ui-bundle.js"></script>
    <script src="${INITIALIZER_PATH}"></script>
  </body>
</html>
`;
