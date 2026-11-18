/**
 * Types for Express, which ships none of its own, so `vendoredBridge.ts` can mount the
 * Bridge's middleware in an app. Follows
 * `modules/express-bridge/src/express/testExpress.d.ts`, whose layer imports only types from
 * express-serve-static-core.
 */
declare module 'express' {
  import type { Express } from 'express-serve-static-core';

  const createApplication: () => Express;
  export default createApplication;
}
