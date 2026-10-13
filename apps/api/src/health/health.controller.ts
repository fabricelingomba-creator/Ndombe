import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { DatabaseService } from '../db/database.service';

@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async check() {
    await this.db.query('SELECT 1');
    return { status: 'ok' };
  }
}
