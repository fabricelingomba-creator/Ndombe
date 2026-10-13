import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DatabaseService } from '../db/database.service';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';

const createFacultySchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
});

const createDepartmentSchema = createFacultySchema;

const FACULTY_COLUMNS = 'id, code, name, created_at AS "createdAt"';

/** Premier module académique : facultés et départements (base des portées RBAC). */
@Controller('v1/faculties')
export class FacultiesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('academic:structure:read')
  list(@CurrentTenant() tenant: Tenant) {
    // Pas de filtre tenant_id ici : la RLS ne renvoie que les facultés de l'université courante.
    return this.db.withTenant(tenant.id, async (tx) => {
      return (await tx.query(`SELECT ${FACULTY_COLUMNS} FROM faculties WHERE deleted_at IS NULL ORDER BY code`)).rows;
    });
  }

  @Post()
  @RequirePermission('academic:structure:write')
  create(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(createFacultySchema)) body: z.infer<typeof createFacultySchema>,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const faculty = (
        await tx.query(`INSERT INTO faculties (tenant_id, code, name) VALUES ($1, $2, $3) RETURNING ${FACULTY_COLUMNS}`, [
          tenant.id,
          body.code,
          body.name,
        ])
      ).rows[0];
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'faculty.created',
        entityType: 'faculty',
        entityId: faculty.id,
        after: faculty,
        ip: req.ip,
      });
      return faculty;
    });
  }

  @Get(':facultyId/departments')
  @RequirePermission('academic:structure:read', { type: 'faculty', param: 'facultyId' })
  departments(@CurrentTenant() tenant: Tenant, @Param('facultyId', ParseUUIDPipe) facultyId: string) {
    return this.db.withTenant(tenant.id, async (tx) => {
      return (
        await tx.query(
          `SELECT id, code, name FROM departments WHERE faculty_id = $1 AND deleted_at IS NULL ORDER BY code`,
          [facultyId],
        )
      ).rows;
    });
  }

  @Post(':facultyId/departments')
  @RequirePermission('academic:structure:write', { type: 'faculty', param: 'facultyId' })
  createDepartment(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('facultyId', ParseUUIDPipe) facultyId: string,
    @Body(new ZodPipe(createDepartmentSchema)) body: z.infer<typeof createDepartmentSchema>,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const department = (
        await tx.query(
          `INSERT INTO departments (tenant_id, faculty_id, code, name) VALUES ($1, $2, $3, $4)
           RETURNING id, faculty_id AS "facultyId", code, name`,
          [tenant.id, facultyId, body.code, body.name],
        )
      ).rows[0];
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'department.created',
        entityType: 'department',
        entityId: department.id,
        after: department,
        ip: req.ip,
      });
      return department;
    });
  }
}
