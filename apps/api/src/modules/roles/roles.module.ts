import { Body, Controller, Delete, Get, Module, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  builtinRoleUpdateSchema,
  customRoleSchema,
  STAFF_ROLES,
  type CustomRoleInput,
} from '@ecole/shared';
import { z } from 'zod';
import { RequirePermissions } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { RolesService } from './roles.service';

const roleKey = z.object({ role: z.enum(STAFF_ROLES) });

@ApiTags('roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** Lecture : utile aussi pour attribuer les rôles depuis l'écran du personnel. */
  @RequirePermissions('staff.read')
  @Get()
  list() {
    return this.roles.list();
  }

  @RequirePermissions('roles.manage')
  @Put('builtin/:role')
  updateBuiltin(
    @Param(new ZodPipe(roleKey)) params: z.infer<typeof roleKey>,
    @Body(new ZodPipe(builtinRoleUpdateSchema)) body: z.infer<typeof builtinRoleUpdateSchema>,
  ) {
    return this.roles.updateBuiltin(params.role, body.permissions);
  }

  @RequirePermissions('roles.manage')
  @Post('builtin/:role/reset')
  resetBuiltin(@Param(new ZodPipe(roleKey)) params: z.infer<typeof roleKey>) {
    return this.roles.resetBuiltin(params.role);
  }

  @RequirePermissions('roles.manage')
  @Post('custom')
  createCustom(@Body(new ZodPipe(customRoleSchema)) body: CustomRoleInput) {
    return this.roles.createCustom(body);
  }

  @RequirePermissions('roles.manage')
  @Put('custom/:id')
  updateCustom(
    @Param('id') id: string,
    @Body(new ZodPipe(customRoleSchema)) body: CustomRoleInput,
  ) {
    return this.roles.updateCustom(id, body);
  }

  @RequirePermissions('roles.manage')
  @Delete('custom/:id')
  deleteCustom(@Param('id') id: string) {
    return this.roles.deleteCustom(id);
  }
}

@Module({ controllers: [RolesController], providers: [RolesService] })
export class RolesModule {}
