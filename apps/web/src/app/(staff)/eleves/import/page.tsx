'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FileSpreadsheet } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, PageHeader } from '@/components/ui/card';
import { SelectField, TextareaField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { plural } from '@/lib/format';
import { useClasses } from '@/lib/queries';

interface ImportReport {
  total: number;
  valid: number;
  errors: { line: number; messages: string[] }[];
  created: number;
}

const TEMPLATE =
  'nom;prenoms;sexe;date_naissance;lieu_naissance;parent_nom;parent_prenom;parent_telephone;lien\nAtangana;Cédric;M;04/07/2013;Yaoundé;Atangana;Joseph;677000101;Père';

export default function ImportPage() {
  const classes = useClasses();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState('');
  const [classId, setClassId] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<ImportReport>('/students/import', {
        method: 'POST',
        body: { csv, classId: classId || undefined, dryRun },
      }),
    onSuccess: (r, dryRun) => {
      setReport(r);
      if (!dryRun && r.created > 0) {
        void queryClient.invalidateQueries({ queryKey: ['students'] });
        toast(`${plural(r.created, 'élève importé', 'élèves importés')}`);
      }
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });

  return (
    <>
      <nav aria-label="Fil d’Ariane" className="flex items-center gap-1.5 text-sm">
        <Link href="/eleves" className="font-semibold text-primary">
          Élèves
        </Link>
        <ChevronRight className="size-3.5 text-muted" aria-hidden />
        <span className="text-muted">Import</span>
      </nav>
      <PageHeader
        title="Importer des élèves"
        subtitle="Fichier CSV exporté d’Excel (séparateur point-virgule ou virgule)."
      />
      <Card className="flex flex-col gap-4">
        <label className="flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-[12px] border-2 border-dashed border-line-strong px-4 text-sm font-semibold text-primary">
          <FileSpreadsheet className="size-5" aria-hidden />
          Choisir un fichier CSV
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) {
                setCsv(await file.text());
                setReport(null);
              }
            }}
          />
        </label>
        <TextareaField
          label="Contenu du fichier"
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setReport(null);
          }}
          className="min-h-40 font-mono text-[13px]"
          hint={`Colonnes attendues : ${TEMPLATE.split('\n')[0]}`}
        />
        <SelectField
          label="Inscrire dans la classe"
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
          optional
        >
          <option value="">Ne pas inscrire maintenant</option>
          {classes.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="secondary" onClick={() => setCsv(TEMPLATE)}>
            Insérer un exemple
          </Button>
          <Button
            onClick={() => run.mutate(true)}
            loading={run.isPending && run.variables}
            disabled={!csv.trim()}
          >
            Vérifier sans importer
          </Button>
        </div>
      </Card>
      {report ? (
        <Card aria-live="polite">
          <CardHeader
            title={report.created > 0 ? 'Import terminé' : 'Rapport de vérification'}
            subtitle={`${report.valid} ligne(s) valide(s) sur ${report.total}`}
          />
          {report.errors.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {report.errors.map((e) => (
                <li key={e.line} className="rounded-[10px] bg-danger-soft p-3 text-sm">
                  <strong className="text-danger">Ligne {e.line}</strong>
                  <ul className="mt-1 list-disc pl-5">
                    {e.messages.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : report.created > 0 ? (
            <p className="text-sm">
              {plural(report.created, 'élève créé', 'élèves créés')}, avec matricule et échéancier.{' '}
              <Link href="/eleves" className="font-semibold text-primary underline">
                Voir la liste
              </Link>
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm">Aucune erreur. Vous pouvez lancer l’import.</p>
              <Button
                onClick={() => run.mutate(false)}
                loading={run.isPending && !run.variables}
                className="self-start"
              >
                Importer {plural(report.valid, 'élève', 'élèves')}
              </Button>
            </div>
          )}
        </Card>
      ) : null}
    </>
  );
}
