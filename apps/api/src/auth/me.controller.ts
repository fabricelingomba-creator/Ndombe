import { Controller, Get } from '@nestjs/common';
import { AuthenticatedUser } from './authenticated-user';
import { CurrentUser } from './decorators';

/** Profil, rôles et permissions de l'utilisateur : sert à construire les menus web et mobile. */
@Controller('v1/me')
export class MeController {
  @Get()
  me(@CurrentUser() user: AuthenticatedUser) {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: user.roles,
      permissions: [...new Set(user.grants.map((g) => g.permission))].sort(),
      grants: user.grants,
    };
  }
}
