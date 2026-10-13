import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { Request } from 'express';
import { Tenant } from './tenant';

export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): Tenant => {
  const tenant = ctx.switchToHttp().getRequest<Request>().tenant;
  if (!tenant) throw new InternalServerErrorException('Route tenant appelée sans tenant résolu');
  return tenant;
});
