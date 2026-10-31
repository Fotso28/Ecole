import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  documentCancelSchema,
  documentIssueSchema,
  documentListSchema,
  documentTemplateSchema,
} from '@ecole/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { FilesService } from '../files/files.service';
import { PdfModule } from '../pdf/pdf.module';
import { DocumentsPdf } from './documents.pdf';
import { DocumentsService, type AdminDocumentData } from './documents.service';

@ApiTags('documents')
@ApiBearerAuth()
@RequireModule('documents')
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly pdf: DocumentsPdf,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  @RequirePermissions('documents.read')
  @Get()
  list(@Query(new ZodPipe(documentListSchema)) q: z.infer<typeof documentListSchema>) {
    return this.documents.list(q);
  }

  @RequirePermissions('documents.read')
  @Get('templates')
  templates() {
    return this.documents.templates();
  }

  @RequirePermissions('documents.configure')
  @Put('templates/:type')
  saveTemplate(
    @Param('type') type: string,
    @Body(new ZodPipe(documentTemplateSchema)) body: z.infer<typeof documentTemplateSchema>,
  ) {
    return this.documents.saveTemplate(DocumentsService.assertType(type), body);
  }

  /** Aperçu PDF du modèle en cours de saisie, avec un élève fictif, sans numéro du registre. */
  @RequirePermissions('documents.configure')
  @Post('templates/:type/preview')
  @HttpCode(200)
  async preview(
    @Param('type') type: string,
    @Body(new ZodPipe(documentTemplateSchema)) body: z.infer<typeof documentTemplateSchema>,
    @Res() res: Response,
  ) {
    const docType = DocumentsService.assertType(type);
    const buffer = await this.pdf.render({
      type: docType,
      number: 'SPÉCIMEN',
      verificationCode: 'SPECIMEN',
      status: 'ISSUED',
      issuedAt: new Date(),
      data: await this.documents.previewData(docType, body),
      photo: null,
      specimen: true,
    });
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', 'inline; filename="apercu.pdf"');
    res.send(buffer);
  }

  @RequirePermissions('documents.issue')
  @Post()
  issue(@Body(new ZodPipe(documentIssueSchema)) body: z.infer<typeof documentIssueSchema>) {
    return this.documents.issue(body.studentId, body.type);
  }

  @RequirePermissions('documents.issue')
  @Post(':id/duplicate')
  duplicate(@Param('id') id: string) {
    return this.documents.duplicate(id);
  }

  @RequirePermissions('documents.cancel')
  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body(new ZodPipe(documentCancelSchema)) body: z.infer<typeof documentCancelSchema>,
  ) {
    return this.documents.cancel(id, body.reason);
  }

  @RequirePermissions('documents.read')
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.documents.view(await this.documents.get(id));
  }

  /** Chaque impression d'un document officiel est tracée. */
  @RequirePermissions('documents.read')
  @Get(':id/pdf')
  async file(@Param('id') id: string, @Res() res: Response) {
    const doc = await this.documents.get(id);
    const buffer = await this.pdf.render({
      type: doc.type,
      number: doc.number,
      verificationCode: doc.verificationCode,
      status: doc.status,
      issuedAt: doc.issuedAt,
      data: doc.data as unknown as AdminDocumentData,
      // Une photo retirée (consentement retiré, photo remplacée) n'est plus imprimée.
      photo: doc.type === 'STUDENT_CARD' ? await this.files.content(doc.photoKey) : null,
    });
    await this.audit.log({
      action: 'documents.printed',
      entity: 'AdminDocument',
      entityId: doc.id,
      after: { number: doc.number },
    });
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="${doc.number}.pdf"`);
    res.send(buffer);
  }
}

@Module({
  imports: [PdfModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentsPdf],
})
export class DocumentsModule {}
