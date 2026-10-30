'use client';

import {
  formatAnonymityCode,
  isValidAnonymityCode,
  normalizeAnonymityCode,
  parseGradeInput,
} from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
} from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { formatShortDate } from '@/lib/format';

interface GradingPaper {
  id: string;
  sessionName: string;
  subjectName: string;
  date: string;
  startTime: string;
  maxScore: number;
  classes: string;
  scores: number;
  expected: number;
  published: boolean;
}

interface PaperScores {
  paper: {
    id: string;
    sessionName: string;
    subjectName: string;
    date: string;
    maxScore: number;
    published: boolean;
  };
  rows: { code: string; value: string }[];
}

export default function ExamGradingPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [paperId, setPaperId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [quickCode, setQuickCode] = useState('');
  const [quickValue, setQuickValue] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const quickRef = useRef<HTMLInputElement>(null);
  const papers = useQuery({
    queryKey: ['exam-grading'],
    queryFn: () => api<GradingPaper[]>('/exams/grading'),
  });
  useEffect(() => {
    if (!paperId && papers.data?.[0]) setPaperId(papers.data[0].id);
  }, [papers.data, paperId]);
  const sheet = useQuery({
    queryKey: ['exam-paper-scores', paperId],
    queryFn: () => api<PaperScores>(`/exams/papers/${paperId}/scores`),
    enabled: !!paperId,
  });
  useEffect(() => {
    if (sheet.data) setValues(Object.fromEntries(sheet.data.rows.map((r) => [r.code, r.value])));
    setErrors({});
  }, [sheet.data]);

  const maxScore = sheet.data?.paper.maxScore ?? 20;
  const original = useMemo(
    () => new Map(sheet.data?.rows.map((r) => [r.code, r.value]) ?? []),
    [sheet.data],
  );
  const changed = Object.entries(values).filter(([code, v]) => (original.get(code) ?? '') !== v);
  const filled = Object.values(values).filter((v) => v.trim() !== '').length;

  const save = useMutation({
    mutationFn: () =>
      api<{ saved: number }>(`/exams/papers/${paperId}/scores`, {
        method: 'PUT',
        body: { scores: changed.map(([code, value]) => ({ code, value })) },
      }),
    onSuccess: (r) => {
      toast(`${r.saved} note(s) enregistrée(s)`);
      void queryClient.invalidateQueries({ queryKey: ['exam-paper-scores', paperId] });
      void queryClient.invalidateQueries({ queryKey: ['exam-grading'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && Array.isArray(e.body.errors)) {
        setErrors(
          Object.fromEntries(
            (e.body.errors as { code: string; message: string }[]).map((x) => [
              normalizeAnonymityCode(x.code),
              x.message,
            ]),
          ),
        );
      }
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });

  const validate = (v: string) =>
    parseGradeInput(v, maxScore).kind === 'invalid'
      ? `Entre 0 et ${maxScore}, « abs » ou « disp »`
      : undefined;

  /** Saisie rapide : numéro lu sur la copie, puis note. */
  const quickAdd = () => {
    const code = normalizeAnonymityCode(quickCode);
    if (!isValidAnonymityCode(code)) {
      setErrors((e) => ({ ...e, quick: 'Numéro invalide : vérifiez chaque caractère' }));
      return;
    }
    if (!original.has(code)) {
      setErrors((e) => ({ ...e, quick: 'Numéro inconnu pour cette épreuve' }));
      return;
    }
    const err = validate(quickValue);
    if (err) {
      setErrors((e) => ({ ...e, quick: err }));
      return;
    }
    setValues((v) => ({ ...v, [code]: quickValue.trim() }));
    setErrors(({ quick: _quick, ...rest }) => rest);
    setQuickCode('');
    setQuickValue('');
    quickRef.current?.focus();
  };

  const current = papers.data?.find((p) => p.id === paperId);
  const locked = !!sheet.data?.paper.published;

  return (
    <>
      <PageHeader
        title="Notes d’examen"
        subtitle="Saisie par numéro d’anonymat : aucun nom n’apparaît avant la publication des résultats."
      />
      {papers.isPending ? (
        <LoadingBlock />
      ) : papers.isError ? (
        <ErrorBlock error={papers.error} onRetry={() => papers.refetch()} />
      ) : papers.data.length === 0 ? (
        <EmptyState title="Aucune épreuve à noter">
          Les épreuves de vos matières apparaîtront ici.
        </EmptyState>
      ) : (
        <>
          <SelectField
            label="Épreuve"
            value={paperId}
            onChange={(e) => setPaperId(e.target.value)}
            containerClassName="sm:max-w-xl"
          >
            {papers.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sessionName} · {p.subjectName} · {p.classes} ({p.scores}/{p.expected})
              </option>
            ))}
          </SelectField>
          {current ? (
            <p className="text-sm text-muted">
              {formatShortDate(current.date)} à {current.startTime} · barème sur {current.maxScore}
              {locked ? ' · résultats publiés, notes figées' : ''}
            </p>
          ) : null}
          {sheet.isPending ? (
            <LoadingBlock />
          ) : sheet.isError ? (
            <ErrorBlock error={sheet.error} />
          ) : (
            <>
              {!locked ? (
                <Card>
                  <CardHeader
                    title="Saisie rapide"
                    subtitle="Tapez le numéro inscrit sur la copie : une faute de frappe est détectée."
                  />
                  <form
                    className="grid grid-cols-[1fr_6rem] gap-3 sm:grid-cols-[14rem_7rem_auto] sm:items-end"
                    onSubmit={(e) => {
                      e.preventDefault();
                      quickAdd();
                    }}
                  >
                    <InputField
                      ref={quickRef}
                      label="Numéro d’anonymat"
                      value={quickCode}
                      onChange={(e) => setQuickCode(e.target.value)}
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      className="font-semibold tracking-wider uppercase"
                    />
                    <InputField
                      label="Note"
                      value={quickValue}
                      onChange={(e) => setQuickValue(e.target.value)}
                      inputMode="decimal"
                      autoComplete="off"
                    />
                    <Button type="submit" variant="secondary" className="col-span-2 sm:col-span-1">
                      Ajouter à la grille
                    </Button>
                  </form>
                  {errors.quick ? (
                    <p role="alert" className="mt-2 text-[13px] font-medium text-danger">
                      {errors.quick}
                    </p>
                  ) : null}
                </Card>
              ) : null}
              <Card>
                <CardHeader
                  title="Grille anonyme"
                  subtitle={`${filled}/${sheet.data.rows.length} notes · « abs » pour un absent`}
                  action={locked ? <Badge tone="night">Publié</Badge> : undefined}
                />
                <ul className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
                  {sheet.data.rows.map((r) => {
                    const v = values[r.code] ?? '';
                    const err = errors[r.code] ?? validate(v);
                    return (
                      <li key={r.code} className="border-t border-line py-2">
                        <InputField
                          label={`Copie ${formatAnonymityCode(r.code)}`}
                          value={v}
                          disabled={locked}
                          onChange={(e) =>
                            setValues((all) => ({ ...all, [r.code]: e.target.value }))
                          }
                          error={err}
                          inputMode="decimal"
                          autoComplete="off"
                          containerClassName="[&_label]:tabular"
                        />
                      </li>
                    );
                  })}
                </ul>
              </Card>
              {!locked ? (
                <div className="sticky bottom-20 z-10 lg:bottom-4">
                  <Button
                    block
                    size="lg"
                    onClick={() => save.mutate()}
                    loading={save.isPending}
                    disabled={
                      changed.length === 0 || changed.some(([, value]) => !!validate(value))
                    }
                  >
                    <Save className="size-4" aria-hidden />
                    Enregistrer {changed.length > 0 ? `${changed.length} note(s)` : ''}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </>
  );
}
