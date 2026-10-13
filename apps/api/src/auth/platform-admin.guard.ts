import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ENV, Env } from '../config/env';
import { bearerToken, JwtVerifierService } from './jwt-verifier.service';

export const PLATFORM_ADMIN_ROLE = 'platform-admin';

/** Accès au portail Super Admin : jeton du realm plateforme avec le rôle platform-admin. */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtVerifierService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = bearerToken(req.header('authorization'));
    if (!token) throw new UnauthorizedException('Jeton manquant');
    let claims;
    try {
      claims = await this.jwt.verify(token, this.env.PLATFORM_REALM);
    } catch {
      throw new UnauthorizedException('Jeton invalide');
    }
    const realmRoles = (claims.realm_access as { roles?: unknown } | undefined)?.roles;
    if (!Array.isArray(realmRoles) || !realmRoles.includes(PLATFORM_ADMIN_ROLE)) {
      throw new ForbiddenException('Rôle platform-admin requis');
    }
    req.platformAdmin = {
      externalId: String(claims.sub),
      email: typeof claims.email === 'string' ? claims.email : null,
    };
    return true;
  }
}
