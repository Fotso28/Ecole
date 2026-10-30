import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  examPaperCreateSchema,
  examPublishSchema,
  examRevealSchema,
  examRoomAddSchema,
  examScoresSchema,
  examSeatMoveSchema,
  examSessionCreateSchema,
  examSupervisionSchema,
  examTransferSchema,
} from '@ecole/shared';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { z } from 'zod';
import { parentContext, runAsSystem } from '../../common/context';
import { ParentRoute, RequireModule, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';
import { renderAttendanceSheets, renderConvocations } from './exams.pdf';
import { ExamsService } from './exams.service';

const seatingSchema = z.object({ mixClasses: z.boolean().optional() });
const roomCreateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  capacity: z.number().int().min(1).max(500).optional(),
});
const convocationQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  studentId: z.string().min(1).optional(),
});
const sheetQuerySchema = z.object({
  paperId: z.string().min(1),
  roomId: z.string().min(1).optional(),
});

/** Examens : sessions, calendrier, salles, surveillances, anonymat, notes et résultats. */
@ApiTags('exams')
@ApiBearerAuth()
@RequireModule('exams')
@Controller('exams')
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

  @RequirePermissions('exams.read')
  @Get('sessions')
  list() {
    return this.exams.listSessions();
  }

  @RequirePermissions('exams.manage')
  @Post('sessions')
  create(
    @Body(new ZodPipe(examSessionCreateSchema)) body: z.infer<typeof examSessionCreateSchema>,
  ) {
    return this.exams.createSession(body);
  }

  @RequirePermissions('exams.read')
  @Get('sessions/:id')
  detail(@Param('id') id: string) {
    return this.exams.detail(id);
  }

  @RequirePermissions('exams.manage')
  @Delete('sessions/:id')
  remove(@Param('id') id: string) {
    return this.exams.deleteSession(id);
  }

  @RequirePermissions('exams.manage')
  @Post('sessions/:id/papers')
  addPaper(
    @Param('id') id: string,
    @Body(new ZodPipe(examPaperCreateSchema)) body: z.infer<typeof examPaperCreateSchema>,
  ) {
    return this.exams.addPaper(id, body);
  }

  @RequirePermissions('exams.manage')
  @Delete('papers/:id')
  deletePaper(@Param('id') id: string) {
    return this.exams.deletePaper(id);
  }

  @RequirePermissions('exams.read')
  @Get('rooms')
  rooms() {
    return this.exams.rooms();
  }

  @RequirePermissions('exams.manage')
  @Post('rooms')
  createRoom(@Body(new ZodPipe(roomCreateSchema)) body: z.infer<typeof roomCreateSchema>) {
    return this.exams.createRoom(body);
  }

  @RequirePermissions('exams.manage')
  @Post('sessions/:id/rooms')
  addRoom(
    @Param('id') id: string,
    @Body(new ZodPipe(examRoomAddSchema)) body: z.infer<typeof examRoomAddSchema>,
  ) {
    return this.exams.addRoom(id, body);
  }

  @RequirePermissions('exams.manage')
  @Delete('sessions/:id/rooms/:roomId')
  removeRoom(@Param('id') id: string, @Param('roomId') roomId: string) {
    return this.exams.removeRoom(id, roomId);
  }

  @RequirePermissions('exams.manage')
  @Post('sessions/:id/seating')
  seat(
    @Param('id') id: string,
    @Body(new ZodPipe(seatingSchema)) body: z.infer<typeof seatingSchema>,
  ) {
    return this.exams.seat(id, body.mixClasses);
  }

  @RequirePermissions('exams.read')
  @Get('sessions/:id/seating')
  seating(@Param('id') id: string) {
    return this.exams.seating(id);
  }

  @RequirePermissions('exams.manage')
  @Put('candidates/:id/seat')
  move(
    @Param('id') id: string,
    @Body(new ZodPipe(examSeatMoveSchema)) body: z.infer<typeof examSeatMoveSchema>,
  ) {
    return this.exams.moveCandidate(id, body.roomId, body.seat);
  }

  @RequirePermissions('exams.manage')
  @Get('staff')
  staff() {
    return this.exams.staff();
  }

  @RequirePermissions('exams.manage')
  @Post('sessions/:id/supervisors/auto')
  autoSupervisors(@Param('id') id: string) {
    return this.exams.autoAssignSupervisors(id);
  }

  @RequirePermissions('exams.manage')
  @Post('supervisions')
  addSupervision(
    @Body(new ZodPipe(examSupervisionSchema)) body: z.infer<typeof examSupervisionSchema>,
  ) {
    return this.exams.addSupervision(body);
  }

  @RequirePermissions('exams.manage')
  @Delete('supervisions/:id')
  removeSupervision(@Param('id') id: string) {
    return this.exams.removeSupervision(id);
  }

  @RequirePermissions('exams.read')
  @Get('my-supervisions')
  mySupervisions() {
    return this.exams.mySupervisions();
  }

  @RequirePermissions('exams.anonymity.reveal')
  @Post('sessions/:id/anonymity/reveal')
  reveal(
    @Param('id') id: string,
    @Body(new ZodPipe(examRevealSchema)) body: z.infer<typeof examRevealSchema>,
  ) {
    return this.exams.revealAnonymity(id, body.reason);
  }

  @RequirePermissions('exams.grade')
  @Get('grading')
  grading() {
    return this.exams.gradingPapers();
  }

  @RequirePermissions('exams.grade')
  @Get('papers/:id/scores')
  scores(@Param('id') id: string) {
    return this.exams.paperScores(id);
  }

  @RequirePermissions('exams.grade')
  @Put('papers/:id/scores')
  saveScores(
    @Param('id') id: string,
    @Body(new ZodPipe(examScoresSchema)) body: z.infer<typeof examScoresSchema>,
  ) {
    return this.exams.saveScores(id, body.scores);
  }

  @RequirePermissions('exams.read')
  @Get('sessions/:id/results')
  results(@Param('id') id: string) {
    return this.exams.results(id);
  }

  @RequirePermissions('exams.manage')
  @Post('sessions/:id/publish')
  publish(
    @Param('id') id: string,
    @Body(new ZodPipe(examPublishSchema)) body: z.infer<typeof examPublishSchema>,
  ) {
    return this.exams.publish(id, body);
  }

  @RequirePermissions('exams.manage')
  @Post('sessions/:id/transfer')
  transfer(
    @Param('id') id: string,
    @Body(new ZodPipe(examTransferSchema)) body: z.infer<typeof examTransferSchema>,
  ) {
    return this.exams.transfer(id, body.weight);
  }

  @RequirePermissions('exams.read')
  @Get('sessions/:id/convocations.pdf')
  async convocations(
    @Param('id') id: string,
    @Query(new ZodPipe(convocationQuerySchema)) q: z.infer<typeof convocationQuerySchema>,
    @Res() res: Response,
  ) {
    const buffer = await renderConvocations(await this.exams.convocations(id, q));
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', 'inline; filename="convocations.pdf"');
    res.send(buffer);
  }

  @RequirePermissions('exams.read')
  @Get('sessions/:id/attendance-sheet.pdf')
  async attendanceSheet(
    @Param('id') id: string,
    @Query(new ZodPipe(sheetQuerySchema)) q: z.infer<typeof sheetQuerySchema>,
    @Res() res: Response,
  ) {
    const buffer = await renderAttendanceSheets(
      await this.exams.attendanceSheets(id, q.paperId, q.roomId),
    );
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', 'inline; filename="emargement.pdf"');
    res.send(buffer);
  }
}

/** Élèves visibles dans le portail : établissement actif ayant activé le portail et les examens. */
const VISIBLE_STUDENT = {
  deletedAt: null,
  school: { status: 'ACTIVE', modules: { hasEvery: ['portal', 'exams'] } },
} satisfies Prisma.StudentWhereInput;

/** Résultats d'examen publiés, dans le portail des parents. */
@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal')
export class ExamsPortalController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly exams: ExamsService,
  ) {}

  @ParentRoute()
  @Get('children/:id/exams')
  async results(@Param('id') id: string) {
    const userId = parentContext().userId;
    const link = await runAsSystem('portal-exams-link', () =>
      this.db.studentGuardian.findFirst({
        where: { studentId: id, guardian: { userId }, student: VISIBLE_STUDENT },
      }),
    );
    if (!link) throw new NotFoundException('Enfant introuvable');
    return runAsSystem('portal-exams', () => this.exams.studentResults(id), link.schoolId);
  }
}

@Module({
  controllers: [ExamsController, ExamsPortalController],
  providers: [ExamsService],
  exports: [ExamsService],
})
export class ExamsModule {}
