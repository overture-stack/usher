/**
 * Types for the two Express majors under test, since Express ships none of its own. Only the tests
 * import Express itself; the middleware imports types alone, from express-serve-static-core.
 */
declare module 'express' {
  import type { Express } from 'express-serve-static-core';

  const createApplication: () => Express;
  export default createApplication;
}

declare module 'express4' {
  import type { Express } from 'express-serve-static-core';

  const createApplication: () => Express;
  export default createApplication;
}
