'use client';

import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, PenLine } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
} from '@/components/ui/card';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatWeekday } from '@/lib/format';

interface TeacherDay {
  today: string;
  lessons: {
    id: string;
    startTime: string;
    endTime: string;
    classId: string;
    className: string;
    classSubjectId: string;
    subjectName: string;
    attendanceTaken: boolean;
  }[];
  classSubjects: {
    id: string;
    classId: string;
    className: string;
    subjectName: string;
    coefficient: number;
    students: number;
  }[];
}

export default function TeacherPage() {
  const { me } = useAuth();
  const q = useQuery({
    queryKey: ['teacher-today'],
    queryFn: () => api<TeacherDay>('/teacher/today'),
  });
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  return (
    <>
      <PageHeader
        title={`Bonjour, ${me?.user.firstName ?? ''}`}
        subtitle={formatWeekday(d.today).replace(/^./, (c) => c.toUpperCase())}
      />
      <Card>
        <CardHeader title="Mes cours du jour" />
        {d.lessons.length === 0 ? (
          <p className="text-sm text-muted">Aucun cours inscrit à l’emploi du temps aujourd’hui.</p>
        ) : (
          <ul className="flex flex-col">
            {d.lessons.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-center gap-3 border-t border-line py-3 first:border-t-0"
              >
                <div className="flex min-w-40 flex-1 flex-col">
                  <strong className="tabular">
                    {l.startTime}–{l.endTime} · {l.className}
                  </strong>
                  <span className="text-sm text-muted">{l.subjectName}</span>
                </div>
                {l.attendanceTaken ? (
                  <Badge tone="success">Appel fait</Badge>
                ) : (
                  <Link
                    href={`/presences?classe=${l.classId}&debut=${l.startTime}&fin=${l.endTime}&cs=${l.classSubjectId}`}
                    className="flex min-h-12 items-center gap-2 rounded-[10px] bg-primary px-4 text-sm font-semibold text-white lg:min-h-10"
                  >
                    <ClipboardCheck className="size-4" aria-hidden />
                    Faire l’appel
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">Mes classes</h2>
        {d.classSubjects.length === 0 ? (
          <EmptyState title="Aucune classe attribuée">
            Le censeur vous affecte vos classes dans la structure académique.
          </EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {d.classSubjects.map((c) => (
              <li key={c.id}>
                <Card className="flex flex-col gap-3">
                  <div>
                    <strong className="text-[17px]">{c.className}</strong>
                    <p className="text-sm text-muted">
                      {c.subjectName} · coef. {c.coefficient} · {c.students} élèves
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Link
                      href={`/presences?classe=${c.classId}&cs=${c.id}`}
                      className="flex min-h-12 items-center justify-center gap-1.5 rounded-[10px] border border-line-strong text-sm font-semibold lg:min-h-10"
                    >
                      <ClipboardCheck className="size-4" aria-hidden />
                      Appel
                    </Link>
                    <Link
                      href={`/notes?cs=${c.id}`}
                      className="flex min-h-12 items-center justify-center gap-1.5 rounded-[10px] border border-line-strong text-sm font-semibold lg:min-h-10"
                    >
                      <PenLine className="size-4" aria-hidden />
                      Notes
                    </Link>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
