import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    // Verified JWT payload only; owner identity and ownership remain unvalidated.
    user?: unknown;
  }
}
