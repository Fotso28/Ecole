import { Body, Controller, Get, Injectable, Module, Param, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { schoolCreateSchema } from '@ecole/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import type { AccessTokenPayload } from '../../common/auth.guard';
import { currentActorId } from '../../common/context';
import { PlatformAdminRoute } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';
import { AuthService } from '../auth/auth.service';

const breakGlassSchema = z.object({
  reason: z.string().trim().min(10, 'Motif de 10 caractères minimum').max(300),
});

@Injectable()
export class PlatformService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
  ) {}

  async createSchool(input: z.infer<typeof schoolCreateSchema>) {
    const passwordHash = await AuthService.hashPassword(input.director.password);
    return this.db.$transaction(async (tx) => {
      const school = await tx.school.create({
        data: {
          name: input.name,
          slug: input.slug,
          city: input.city,
          matriculePrefix: input.matriculePrefix,
        },
      });
      const existing = await tx.user.findUnique({ where: { email: input.director.email } });
      const user =
        existing ??
        (await tx.user.create({
          data: {
            email: input.director.email,
            firstName: input.director.firstName,
            lastName: input.director.lastName,
            passwordHash,
          },
        }));
      await tx.membership.create({
        data: { userId: user.id, schoolId: school.id, roles: ['DIRECTOR'] },
      });
      await this.audit.log(
        {
          action: 'platform.school_created',
          entity: 'School',
          entityId: school.id,
          schoolId: school.id,
          after: { name: school.name },
        },
        tx,
      );
      return { school, directorId: user.id };
    });
  }

  listSchools() {
    return this.db.school.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        city: true,
        status: true,
        modules: true,
        createdAt: true,
      },
    });
  }

  /** Accès exceptionnel en lecture seule, motivé et journalisé. */
  async breakGlass(schoolId: string, reason: string) {
    const school = await this.db.school.findUniqueOrThrow({ where: { id: schoolId } });
    const actorId = currentActorId();
    if (!actorId) throw new Error('Acteur inconnu');
    await this.audit.log({
      action: 'platform.break_glass',
      entity: 'School',
      entityId: school.id,
      schoolId: school.id,
      reason,
    });
    const payload: AccessTokenPayload = { sub: actorId, typ: 'staff', sch: school.id, bg: true };
    return { accessToken: await this.jwt.signAsync(payload, { expiresIn: 1800 }), expiresIn: 1800 };
  }
}

@ApiTags('platform')
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @PlatformAdminRoute()
  @Post('schools')
  create(@Body(new ZodPipe(schoolCreateSchema)) body: z.infer<typeof schoolCreateSchema>) {
    return this.platform.createSchool(body);
  }

  @PlatformAdminRoute()
  @Get('schools')
  list() {
    return this.platform.listSchools();
  }

  @PlatformAdminRoute()
  @Post('schools/:id/access')
  access(
    @Param('id') id: string,
    @Body(new ZodPipe(breakGlassSchema)) body: z.infer<typeof breakGlassSchema>,
  ) {
    return this.platform.breakGlass(id, body.reason);
  }
}

@Module({ controllers: [PlatformController], providers: [PlatformService] })
export class PlatformModule {}
