import type { Grant } from '../rbac/scope';

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  externalId: string;
  email: string;
  fullName: string;
  roles: string[];
  grants: Grant[];
}

export interface PlatformAdmin {
  externalId: string;
  email: string | null;
}
