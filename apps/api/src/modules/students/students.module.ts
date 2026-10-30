import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  duplicateCheckSchema,
  enrollmentCreateSchema,
  ENROLLMENT_STATUSES,
  guardianInputSchema,
  studentCreateSchema,
  studentImportSchema,
  studentUpdateSchema,
} from '@ecole/shared';
import { z } from 'zod';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { FinanceModule } from '../finance/finance.module';
import { FileUpload } from '../files/files.module';
import type { UploadedFile as Upload } from '../files/files.service';
import { StudentsService } from './students.service';

const listSchema = z.object({
  search: z.string().max(80).optional(),
  classId: z.string().optional(),
  status: z.enum(ENROLLMENT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const reasonSchema = z.object({ reason: z.string().trim().min(5).max(300) });
const documentSchema = z.object({ status: z.enum(['RECEIVED', 'MISSING']) });
const enrollmentChangeSchema = z.object({
  classId: z.string().optional(),
  status: z.enum(ENROLLMENT_STATUSES).optional(),
});
const healthQuerySchema = z.object({
  reason: z.string().trim().min(5, 'Motif obligatoire (5 caractères minimum)').max(300),
});
const healthSchema = z.object({
  allergies: z.string().max(1000).optional(),
  conditions: z.string().max(1000).optional(),
  treatments: z.string().max(1000).optional(),
  doctor: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

@ApiTags('students')
@ApiBearerAuth()
@RequireModule('students')
@Controller()
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @RequirePermissions('students.read')
  @Get('students')
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.students.list(q);
  }

  @RequirePermissions('students.write')
  @Post('students')
  create(@Body(new ZodPipe(studentCreateSchema)) body: z.infer<typeof studentCreateSchema>) {
    return this.students.create(body);
  }

  @RequirePermissions('students.write')
  @Post('students/check-duplicates')
  checkDuplicates(
    @Body(new ZodPipe(duplicateCheckSchema)) body: z.infer<typeof duplicateCheckSchema>,
  ) {
    return this.students.findDuplicates(body);
  }

  @RequirePermissions('students.write')
  @Post('students/import')
  import(@Body(new ZodPipe(studentImportSchema)) body: z.infer<typeof studentImportSchema>) {
    return this.students.importCsv(body.csv, body.classId, body.dryRun);
  }

  @RequirePermissions('students.read')
  @Get('students/:id')
  overview(@Param('id') id: string) {
    return this.students.overview(id);
  }

  @RequirePermissions('students.write')
  @Patch('students/:id')
  update(
    @Param('id') id: string,
    @Body(new ZodPipe(studentUpdateSchema)) body: z.infer<typeof studentUpdateSchema>,
  ) {
    return this.students.update(id, body);
  }

  @RequirePermissions('students.write')
  @Delete('students/:id')
  remove(
    @Param('id') id: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
  ) {
    return this.students.softDelete(id, body.reason);
  }

  @RequirePermissions('students.write')
  @Post('students/:id/guardians')
  addGuardian(
    @Param('id') id: string,
    @Body(new ZodPipe(guardianInputSchema)) body: z.infer<typeof guardianInputSchema>,
  ) {
    return this.students.addGuardian(id, body);
  }

  @RequirePermissions('students.write')
  @Delete('students/:id/guardians/:linkId')
  removeGuardian(@Param('id') id: string, @Param('linkId') linkId: string) {
    return this.students.removeGuardian(id, linkId);
  }

  @RequirePermissions('students.write')
  @Patch('students/:id/documents/:documentId')
  setDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body(new ZodPipe(documentSchema)) body: z.infer<typeof documentSchema>,
  ) {
    return this.students.setDocument(id, documentId, body.status);
  }

  @RequirePermissions('students.documents')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileUpload)
  @Post('students/:id/documents/:documentId/file')
  uploadDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @UploadedFile() file: Upload | undefined,
  ) {
    return this.students.uploadDocument(id, documentId, file);
  }

  @RequirePermissions('students.documents')
  @Get('students/:id/documents/:documentId/file')
  documentFile(@Param('id') id: string, @Param('documentId') documentId: string) {
    return this.students.documentLink(id, documentId);
  }

  @RequirePermissions('health.read')
  @Get('students/:id/health')
  health(
    @Param('id') id: string,
    @Query(new ZodPipe(healthQuerySchema)) q: z.infer<typeof healthQuerySchema>,
  ) {
    return this.students.health(id, q.reason);
  }

  @RequirePermissions('health.read')
  @Put('students/:id/health')
  saveHealth(
    @Param('id') id: string,
    @Body(new ZodPipe(healthSchema)) body: z.infer<typeof healthSchema>,
  ) {
    return this.students.saveHealth(id, body);
  }

  @RequirePermissions('enrollments.write')
  @Post('enrollments')
  enroll(@Body(new ZodPipe(enrollmentCreateSchema)) body: z.infer<typeof enrollmentCreateSchema>) {
    return this.students.enroll(body.studentId, body.classId, body.status);
  }

  @RequirePermissions('enrollments.write')
  @Patch('enrollments/:id')
  changeEnrollment(
    @Param('id') id: string,
    @Body(new ZodPipe(enrollmentChangeSchema)) body: z.infer<typeof enrollmentChangeSchema>,
  ) {
    return this.students.changeEnrollment(id, body);
  }
}

@Module({
  imports: [FinanceModule],
  controllers: [StudentsController],
  providers: [StudentsService],
})
export class StudentsModule {}
