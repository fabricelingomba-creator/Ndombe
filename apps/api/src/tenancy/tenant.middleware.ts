import { Injectable, NestMiddleware, NotFoundException, ForbiddenException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TenantResolverService } from './tenant-resolver.service';

export const TENANT_HEADER = 'x-elongo-tenant';
export const PORTAL_HOST_HEADER = 'x-elongo-host';

/**
 * Attache l'université à la requête. Le nom d'hôte prime. À défaut :
 *   - x-elongo-host : domaine du portail, envoyé par le serveur web qui appelle l'API en interne ;
 *   - x-elongo-tenant : slug, envoyé par l'app mobile.
 * Ces en-têtes ne donnent aucun droit : le jeton doit toujours venir du realm de l'université.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly resolver: TenantResolverService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    try {
      let tenant = await this.resolver.resolveHost(req.hostname ?? '');
      const portalHost = req.header(PORTAL_HOST_HEADER);
      if (!tenant && portalHost) tenant = await this.resolver.resolveHost(portalHost);
      const headerSlug = req.header(TENANT_HEADER);
      if (!tenant && headerSlug) tenant = await this.resolver.resolveSlug(headerSlug.toLowerCase());
      if (!tenant) throw new NotFoundException('Université inconnue');
      if (tenant.status !== 'active') throw new ForbiddenException('Université suspendue');
      req.tenant = tenant;
      next();
    } catch (err) {
      next(err);
    }
  }
}
