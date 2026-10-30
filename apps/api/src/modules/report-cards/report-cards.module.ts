import { Body, Controller, Get, Module, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  councilDecisionSchema,
  reportCardGenerateSchema,
  reportCardPublishSchema,
} from '@ecole/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { PdfModule } from '../pdf/pdf.module';
import { PdfService } from '../pdf/pdf.service';
import { ReportCardsService } from './report-cards.service';

const decisionBody = councilDecisionSchema.extend({
  studentId: z.string().min(1),
  termId: z.string().min(1),
});

@ApiTags('report-cards')
@ApiBearerAuth()
@RequireModule('grades')
@Controller('report-cards')
export class ReportCardsController {
  constructor(
    private readonly cards: ReportCardsService,
    private readonly pdf: PdfService,
  ) {}

  @RequirePermissions('reportcards.generate')
  @Post('generate')
  generate(
    @Body(new ZodPipe(reportCardGenerateSchema)) body: z.infer<typeof reportCardGenerateSchema>,
  ) {
    return this.cards.generate(body.classId, body.termId);
  }

  @RequirePermissions('reportcards.publish')
  @Post('publish')
  publish(
    @Body(new ZodPipe(reportCardPublishSchema)) body: z.infer<typeof reportCardPublishSchema>,
  ) {
    return this.cards.publish(body.classId, body.termId, body.overrideReason);
  }

  @RequirePermissions('reportcards.read')
  @Get('completeness')
  completeness(
    @Query(new ZodPipe(reportCardGenerateSchema)) q: z.infer<typeof reportCardGenerateSchema>,
  ) {
    return this.cards.completeness(q.classId, q.termId);
  }

  @RequirePermissions('reportcards.read')
  @Get()
  list(@Query(new ZodPipe(reportCardGenerateSchema)) q: z.infer<typeof reportCardGenerateSchema>) {
    return this.cards.list(q.classId, q.termId);
  }

  @RequirePermissions('reportcards.generate')
  @Put('decisions')
  decision(@Body(new ZodPipe(decisionBody)) body: z.infer<typeof decisionBody>) {
    return this.cards.setDecision(
      body.studentId,
      body.termId,
      body.decision,
      body.comment,
      body.yearEndDecision,
    );
  }

  @RequirePermissions('reportcards.read')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.cards.get(id);
  }

  @RequirePermissions('reportcards.read')
  @Get(':id/pdf')
  async file(@Param('id') id: string, @Res() res: Response) {
    const buffer = await this.pdf.reportCard(id);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="bulletin-${id}.pdf"`);
    res.send(buffer);
  }
}

@Module({
  imports: [PdfModule],
  controllers: [ReportCardsController],
  providers: [ReportCardsService],
  exports: [ReportCardsService],
})
export class ReportCardsModule {}
