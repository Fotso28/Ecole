import { Controller, Get, Module, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { transcriptQuerySchema } from '@ecole/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { renderTranscript } from './transcript.pdf';
import { TranscriptsService } from './transcripts.service';

type TranscriptQuery = z.infer<typeof transcriptQuerySchema>;

/** Relevés de notes par élève (direction, censeur, secrétariat). */
@ApiTags('transcripts')
@ApiBearerAuth()
@RequireModule('grades')
@Controller('transcripts')
export class TranscriptsController {
  constructor(private readonly transcripts: TranscriptsService) {}

  @RequirePermissions('reportcards.read')
  @Get('students/:id')
  get(@Param('id') id: string, @Query(new ZodPipe(transcriptQuerySchema)) q: TranscriptQuery) {
    return this.transcripts.compute(id, q.scope, q.periodId);
  }

  @RequirePermissions('reportcards.read')
  @Get('students/:id/pdf')
  async pdf(
    @Param('id') id: string,
    @Query(new ZodPipe(transcriptQuerySchema)) q: TranscriptQuery,
    @Res() res: Response,
  ) {
    const data = await this.transcripts.compute(id, q.scope, q.periodId);
    const buffer = await renderTranscript(data);
    await this.transcripts.logIssued(data, 'staff');
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="releve-${data.student.matricule}.pdf"`);
    res.send(buffer);
  }
}

@Module({
  controllers: [TranscriptsController],
  providers: [TranscriptsService],
  exports: [TranscriptsService],
})
export class TranscriptsModule {}
