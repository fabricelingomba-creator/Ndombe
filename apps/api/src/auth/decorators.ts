import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Permission } from '../rbac/permissions';
import type { ScopeType } from '../rbac/scope';
import type { AuthenticatedUser } from './authenticated-user';

export const IS_PUBLIC = 'elongo:isPublic';
/** Route accessible sans connexion (page d'accueil, manifeste de marque). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_PERMISSION = 'elongo:requiredPermission';
export interface PermissionRequirement {
  permission: Permission;
  /** Où lire l'identifiant de la cible ; absent = action à l'échelle de l'université. */
  scope?: { type: Exclude<ScopeType, 'university'>; param: string };
}
export const RequirePermission = (permission: Permission, scope?: PermissionRequirement['scope']) =>
  SetMetadata(REQUIRED_PERMISSION, { permission, scope } satisfies PermissionRequirement);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => ctx.switchToHttp().getRequest<Request>().user!,
);
