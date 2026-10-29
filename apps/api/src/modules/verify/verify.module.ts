import { Controller, Get, Module, NotFoundException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { formatFcfa, formatGrade } from '@ecole/shared';
import { runAsSystem } from '../../common/context';
import { Public } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import type { ReportCardData } from '../report-cards/report-cards.service';

/** Vérification publique de l'authenticité d'un bulletin ou d'un reçu (QR code). */
@ApiTags('verify')
@Controller('verify')
export class VerifyController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':code')
  async verify(@Param('code') code: string) {
    if (!/^[A-Z0-9]{6,20}$/.test(code)) throw new NotFoundException('Code inconnu');
    return runAsSystem('public-verify', async () => {
      const card = await this.db.reportCard.findUnique({ where: { verificationCode: code } });
      if (card && card.status !== 'DRAFT') {
        const data = card.data as unknown as ReportCardData;
        const latest = await this.db.reportCard.findFirst({
          where: { studentId: card.studentId, termId: card.termId, status: 'PUBLISHED' },
          select: { version: true },
        });
        return {
          type: 'report-card',
          valid: card.status === 'PUBLISHED',
          status: card.status,
          school: data.school.name,
          student: `${data.student.lastName.toUpperCase()} ${data.student.firstName}`,
          class: data.class.name,
          term: data.term.name,
          year: data.year,
          version: card.version,
          latestVersion: latest?.version ?? null,
          generalAverage:
            card.generalAverageCenti === null ? null : formatGrade(card.generalAverageCenti),
          publishedAt: card.publishedAt,
        };
      }
      const receipt = await this.db.receipt.findUnique({
        where: { verificationCode: code },
        include: { payment: true },
      });
      if (receipt) {
        const [school, student] = await Promise.all([
          this.db.school.findUniqueOrThrow({
            where: { id: receipt.schoolId },
            select: { name: true },
          }),
          this.db.student.findUniqueOrThrow({
            where: { id: receipt.payment.studentId },
            select: { firstName: true, lastName: true },
          }),
        ]);
        return {
          type: 'receipt',
          valid: receipt.payment.reversedAt === null,
          status: receipt.payment.reversedAt ? 'REVERSED' : 'VALID',
          school: school.name,
          student: `${student.lastName.toUpperCase()} ${student.firstName}`,
          number: receipt.number,
          amount: formatFcfa(receipt.payment.amount),
          issuedAt: receipt.issuedAt,
        };
      }
      throw new NotFoundException('Code inconnu');
    });
  }
}

@Module({ controllers: [VerifyController] })
export class VerifyModule {}
