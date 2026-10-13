import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DatabaseService } from '../db/database.service';
import { RbacService } from '../rbac/rbac.service';
import { IS_PUBLIC } from './decorators';
import { bearerToken, JwtVerifierService } from './jwt-verifier.service';

interface UserRow {
  id: string;
  external_id: string | null;
  email: string;
  full_name: string;
  status: 'invited' | 'active' | 'disabled';
}

/**
 * Authentifie l'utilisateur d'une université : le jeton doit venir du realm
 * Keycloak de CETTE université, et l'utilisateur doit exister dans son annuaire.
 * Un jeton d'une autre université est donc rejeté, même valide.
 */
@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtVerifierService,
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const tenant = req.tenant;
    if (!tenant) throw new UnauthorizedException();
    const token = bearerToken(req.header('authorization'));
    if (!token) throw new UnauthorizedException('Jeton manquant');

    let claims;
    try {
      claims = await this.jwt.verify(token, tenant.keycloakRealm);
    } catch {
      throw new UnauthorizedException('Jeton invalide');
    }
    const sub = claims.sub;
    if (!sub) throw new UnauthorizedException('Jeton sans sujet');
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    const emailVerified = claims.email_verified === true;

    req.user = await this.db.withTenant(tenant.id, async (tx) => {
      let user = (
        await tx.query<UserRow>(
          'SELECT id, external_id, email, full_name, status FROM users WHERE external_id = $1 AND deleted_at IS NULL',
          [sub],
        )
      ).rows[0];

      // Première connexion d'un utilisateur invité : on relie son compte Keycloak par e-mail vérifié.
      if (!user && email && emailVerified) {
        user = (
          await tx.query<UserRow>(
            `UPDATE users SET external_id = $1, status = 'active', updated_at = now()
              WHERE email = $2 AND external_id IS NULL AND status = 'invited' AND deleted_at IS NULL
              RETURNING id, external_id, email, full_name, status`,
            [sub, email],
          )
        ).rows[0];
      }

      if (!user || user.status === 'disabled') throw new ForbiddenException('Compte inconnu ou désactivé');
      const { roles, grants } = await this.rbac.loadGrants(tx, user.id);
      return {
        id: user.id,
        tenantId: tenant.id,
        externalId: sub,
        email: user.email,
        fullName: user.full_name,
        roles,
        grants,
      };
    });
    return true;
  }
}
