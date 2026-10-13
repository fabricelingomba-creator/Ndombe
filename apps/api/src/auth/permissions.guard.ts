import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DatabaseService } from '../db/database.service';
import { RbacService } from '../rbac/rbac.service';
import { grantsAllow, Scope, UNIVERSITY_SCOPE } from '../rbac/scope';
import { PermissionRequirement, REQUIRED_PERMISSION } from './decorators';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Applique @RequirePermission : permission + portée, vérifiées côté serveur à chaque appel. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(REQUIRED_PERMISSION, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!requirement) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!user || !req.tenant) throw new ForbiddenException();

    if (requirement.scope === 'any') {
      if (user.grants.some((g) => g.permission === requirement.permission)) return true;
      throw new ForbiddenException(`Permission requise : ${requirement.permission}`);
    }

    let chain: Scope[] = [UNIVERSITY_SCOPE];
    if (requirement.scope) {
      const id = req.params[requirement.scope.param];
      if (typeof id !== 'string' || !UUID.test(id)) throw new BadRequestException('Identifiant invalide');
      const target: Scope = { type: requirement.scope.type, id };
      chain = await this.db.withTenant(req.tenant.id, (tx) => this.rbac.scopeChain(tx, target));
    }

    if (!grantsAllow(user.grants, requirement.permission, chain)) {
      throw new ForbiddenException(`Permission requise : ${requirement.permission}`);
    }
    return true;
  }
}
