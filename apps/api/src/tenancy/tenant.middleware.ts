import { Injectable, NestMiddleware, NotFoundException, ForbiddenException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TenantResolverService } from './tenant-resolver.service';

export const TENANT_HEADER = 'x-elongo-tenant';

/**
 * Attache l'université à la requête. Le nom d'hôte prime ; l'en-tête
 * x-elongo-tenant (slug) ne sert qu'aux clients sans domaine propre, comme l'app mobile.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly resolver: TenantResolverService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    try {
      let tenant = await this.resolver.resolveHost(req.hostname ?? '');
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
