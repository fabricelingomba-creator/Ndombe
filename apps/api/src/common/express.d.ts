import type { Tenant } from '../tenancy/tenant';
import type { AuthenticatedUser, PlatformAdmin } from '../auth/authenticated-user';

declare global {
  namespace Express {
    interface Request {
      tenant?: Tenant;
      user?: AuthenticatedUser;
      platformAdmin?: PlatformAdmin;
    }
  }
}

export {};
