/**
 * Declares the request's access on Express's `res.locals`, typed `unknown` and read-only. A direct
 * read then needs a cast and a replacement does not compile, so an adapter reads the access only
 * through `readAccess`, which validates it. One declaration covers Express 4 and 5, whose types share
 * the global `Express.Locals`.
 */
declare global {
  namespace Express {
    interface Locals {
      readonly usher?: unknown;
    }
  }
}

export {};
