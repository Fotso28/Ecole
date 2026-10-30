import { Injectable } from '@nestjs/common';
import { classStatistics, passRate } from '@ecole/shared';
import { Db, InjectDb } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { isFinalTerm } from '../report-cards/report-cards.service';

export interface PassRateCell {
  /** Élèves ayant une moyenne. */
  counted: number;
  passed: number;
  /** Taux de réussite (moyenne ≥ 10/20) en dixièmes de pour cent. */
  ratePermille: number | null;
  averageCenti: number | null;
  /** Vrai si les chiffres viennent de bulletins encore en brouillon. */
  provisional: boolean;
}

export interface ClassResults {
  classId: string;
  className: string;
  terms: (PassRateCell | null)[];
  annual: PassRateCell | null;
}

export interface ResultsIndicators {
  year: { id: string; name: string };
  terms: { id: string; name: string; order: number }[];
  classes: ClassResults[];
  overall: { terms: (PassRateCell | null)[]; annual: PassRateCell | null };
}

type CardRow = {
  studentId: string;
  classId: string;
  termId: string;
  status: string;
  generalAverageCenti: number | null;
  annualAverageCenti: number | null;
};

function cell(cards: readonly CardRow[], pick: (c: CardRow) => number | null): PassRateCell | null {
  if (cards.length === 0) return null;
  // Les bulletins publiés font foi ; à défaut, les brouillons donnent une tendance provisoire.
  const published = cards.filter((c) => c.status === 'PUBLISHED');
  const used = published.length > 0 ? published : cards;
  const averages = used.map(pick);
  const rate = passRate(averages);
  return {
    counted: rate.counted,
    passed: rate.passed,
    ratePermille: rate.ratePermille,
    averageCenti: classStatistics(averages).averageCenti,
    provisional: published.length === 0,
  };
}

/** Taux de réussite par classe et par trimestre, et sur l'année, à partir des bulletins. */
@Injectable()
export class ResultsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
  ) {}

  async indicators(): Promise<ResultsIndicators> {
    const year = await this.scope.currentYear();
    const [terms, classes] = await Promise.all([
      this.db.term.findMany({
        where: { academicYearId: year.id },
        select: { id: true, name: true, order: true },
        orderBy: { order: 'asc' },
      }),
      this.db.class.findMany({
        where: { academicYearId: year.id },
        select: { id: true, name: true, level: { select: { order: true } } },
      }),
    ]);
    const cards = await this.db.reportCard.findMany({
      where: { termId: { in: terms.map((t) => t.id) }, status: { in: ['PUBLISHED', 'DRAFT'] } },
      select: {
        studentId: true,
        classId: true,
        termId: true,
        status: true,
        generalAverageCenti: true,
        annualAverageCenti: true,
      },
    });
    const finalTerm = terms.find((t) => isFinalTerm(t, terms));
    const forTerm = (termId: string, classId?: string) =>
      cards.filter((c) => c.termId === termId && (!classId || c.classId === classId));
    const sortedClasses = [...classes].sort(
      (a, b) => a.level.order - b.level.order || a.name.localeCompare(b.name, 'fr'),
    );
    // Par classe, un trimestre est publié ou provisoire ; l'ensemble de l'école agrège les classes.
    const overallCell = (termId: string, pick: (c: CardRow) => number | null) => {
      const perClass = sortedClasses.flatMap((cls) => {
        const list = forTerm(termId, cls.id);
        const published = list.filter((c) => c.status === 'PUBLISHED');
        return published.length > 0 ? published : list;
      });
      const result = cell(perClass, pick);
      return result
        ? { ...result, provisional: perClass.some((c) => c.status !== 'PUBLISHED') }
        : null;
    };
    return {
      year: { id: year.id, name: year.name },
      terms,
      classes: sortedClasses.map((cls) => ({
        classId: cls.id,
        className: cls.name,
        terms: terms.map((t) => cell(forTerm(t.id, cls.id), (c) => c.generalAverageCenti)),
        annual: finalTerm ? cell(forTerm(finalTerm.id, cls.id), (c) => c.annualAverageCenti) : null,
      })),
      overall: {
        terms: terms.map((t) => overallCell(t.id, (c) => c.generalAverageCenti)),
        annual: finalTerm ? overallCell(finalTerm.id, (c) => c.annualAverageCenti) : null,
      },
    };
  }
}
