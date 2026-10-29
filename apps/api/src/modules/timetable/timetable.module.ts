import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { findConflicts, timeOfDay, toMinutes, weeklyMinutesByTeacher } from '@ecole/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId } from '../../common/context';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';

const entrySchema = z.object({
  classSubjectId: z.string().min(1),
  dayOfWeek: z.number().int().min(1).max(6),
  startTime: timeOfDay,
  endTime: timeOfDay,
  roomId: z.string().min(1).optional(),
});
const roomSchema = z.object({ name: z.string().trim().min(1).max(40), capacity: z.number().int().positive().optional() });

@Injectable()
export class TimetableService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  async list(filter: { classId?: string; teacherId?: string; roomId?: string }) {
    const year = await this.scope.currentYear();
    return this.db.timetableEntry.findMany({
      where: { academicYearId: year.id, classId: filter.classId, teacherId: filter.teacherId, roomId: filter.roomId },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
  }

  /** Ajoute un cours en refusant tout conflit (enseignant, salle, classe) et tout dépassement de charge. */
  async add(input: z.infer<typeof entrySchema>) {
    if (toMinutes(input.endTime) <= toMinutes(input.startTime)) throw new BadRequestException('L’heure de fin doit suivre l’heure de début');
    const year = await this.scope.currentYear();
    const cs = await this.db.classSubject.findUnique({ where: { id: input.classSubjectId }, include: { class: true } });
    if (!cs || cs.class.academicYearId !== year.id) throw new BadRequestException('Matière de classe inconnue pour l’année en cours');
    if (input.roomId) await this.db.room.findUniqueOrThrow({ where: { id: input.roomId } });
    const existing = await this.db.timetableEntry.findMany({ where: { academicYearId: year.id } });
    const candidate = { id: 'nouveau', dayOfWeek: input.dayOfWeek, startTime: input.startTime, endTime: input.endTime, classId: cs.classId, teacherId: cs.teacherId, roomId: input.roomId ?? null };
    const conflicts = findConflicts([...existing, candidate]).filter((c) => c.slotIds.includes('nouveau'));
    if (conflicts.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: 'Conflit d’emploi du temps',
        conflicts: conflicts.map((c) => ({ kind: c.kind, entryId: c.slotIds.find((id) => id !== 'nouveau') })),
      });
    }
    if (cs.teacherId) {
      const membership = await this.db.membership.findUnique({ where: { userId_schoolId: { userId: cs.teacherId, schoolId: currentSchoolId() } } });
      const minutes = weeklyMinutesByTeacher([...existing, candidate]).get(cs.teacherId) ?? 0;
      if (membership?.maxWeeklyHours && minutes > membership.maxWeeklyHours * 60) {
        throw new ConflictException(`Charge horaire dépassée : ${Math.round(minutes / 6) / 10} h pour ${membership.maxWeeklyHours} h autorisées`);
      }
    }
    const entry = await this.db.timetableEntry.create({
      data: { schoolId: currentSchoolId(), academicYearId: year.id, classId: cs.classId, classSubjectId: cs.id, teacherId: cs.teacherId, roomId: input.roomId, dayOfWeek: input.dayOfWeek, startTime: input.startTime, endTime: input.endTime },
    });
    await this.audit.log({ action: 'timetable.entry_added', entity: 'TimetableEntry', entityId: entry.id, after: input });
    return entry;
  }

  async remove(id: string) {
    await this.db.timetableEntry.delete({ where: { id } });
    await this.audit.log({ action: 'timetable.entry_removed', entity: 'TimetableEntry', entityId: id });
    return { ok: true };
  }

  rooms() {
    return this.db.room.findMany({ orderBy: { name: 'asc' } });
  }

  addRoom(input: z.infer<typeof roomSchema>) {
    return this.db.room.create({ data: { schoolId: currentSchoolId(), ...input } });
  }
}

@ApiTags('timetable')
@ApiBearerAuth()
@RequireModule('timetable')
@Controller('timetable')
export class TimetableController {
  constructor(private readonly timetable: TimetableService) {}

  @RequirePermissions('academic.read')
  @Get('entries')
  list(@Query('classId') classId?: string, @Query('teacherId') teacherId?: string, @Query('roomId') roomId?: string) {
    return this.timetable.list({ classId, teacherId, roomId });
  }

  @RequirePermissions('academic.write')
  @Post('entries')
  add(@Body(new ZodPipe(entrySchema)) body: z.infer<typeof entrySchema>) {
    return this.timetable.add(body);
  }

  @RequirePermissions('academic.write')
  @Delete('entries/:id')
  remove(@Param('id') id: string) {
    return this.timetable.remove(id);
  }

  @RequirePermissions('academic.read')
  @Get('rooms')
  rooms() {
    return this.timetable.rooms();
  }

  @RequirePermissions('academic.write')
  @Post('rooms')
  addRoom(@Body(new ZodPipe(roomSchema)) body: z.infer<typeof roomSchema>) {
    return this.timetable.addRoom(body);
  }
}

@Module({ controllers: [TimetableController], providers: [TimetableService] })
export class TimetableModule {}
