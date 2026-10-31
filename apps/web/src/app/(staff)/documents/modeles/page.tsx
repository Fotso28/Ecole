'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminDocumentType } from '@ecole/shared';
import { ChevronRight, Eye } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
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
import { InputField, TextareaField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api, openPdf } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface Template {
  type: AdminDocumentType;
  label: string;
  customized: boolean;
  title: string;
  headerLines: string[];
  signatoryName: string | null;
  signatoryTitle: string;
  mentions: string;
}

function TemplateCard({ template }: { template: Template }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    title: template.title,
    header: template.headerLines.join('\n'),
    signatoryName: template.signatoryName ?? '',
    signatoryTitle: template.signatoryTitle,
    mentions: template.mentions,
  });
  useEffect(() => {
    setForm({
      title: template.title,
      header: template.headerLines.join('\n'),
      signatoryName: template.signatoryName ?? '',
      signatoryTitle: template.signatoryTitle,
      mentions: template.mentions,
    });
  }, [template]);
  const headerLines = form.header
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const body = {
    title: form.title,
    headerLines,
    signatoryName: form.signatoryName,
    signatoryTitle: form.signatoryTitle,
    mentions: form.mentions,
  };
  const [previewing, setPreviewing] = useState(false);
  /** Aperçu du modèle tel que saisi, avec un élève fictif : aucun numéro du registre consommé. */
  const preview = () => {
    setPreviewing(true);
    openPdf(`/documents/templates/${template.type}/preview`, { method: 'POST', body })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : 'Erreur', 'error'))
      .finally(() => setPreviewing(false));
  };
  const save = useMutation({
    mutationFn: () =>
      api<Template>(`/documents/templates/${template.type}`, { method: 'PUT', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['document-templates'] });
      toast(`Modèle « ${template.label} » enregistré`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <Card>
      <CardHeader
        title={template.label}
        action={
          template.customized ? (
            <Badge tone="success">Personnalisé</Badge>
          ) : (
            <Badge>Modèle par défaut</Badge>
          )
        }
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <InputField
          label="Titre du document"
          value={form.title}
          maxLength={80}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
        <TextareaField
          label="En-tête officiel"
          value={form.header}
          onChange={(e) => setForm({ ...form, header: e.target.value })}
          hint="Une ligne par mention (6 au plus). Vide : en-tête de la République du Cameroun."
          error={headerLines.length > 6 ? 'Six lignes au plus' : undefined}
          optional
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <InputField
            label="Nom du signataire"
            value={form.signatoryName}
            maxLength={80}
            onChange={(e) => setForm({ ...form, signatoryName: e.target.value })}
            optional
          />
          <InputField
            label="Qualité du signataire"
            value={form.signatoryTitle}
            maxLength={80}
            onChange={(e) => setForm({ ...form, signatoryTitle: e.target.value })}
          />
        </div>
        <TextareaField
          label="Mentions"
          value={form.mentions}
          maxLength={600}
          onChange={(e) => setForm({ ...form, mentions: e.target.value })}
          hint="Formule finale du document, par exemple « pour servir et valoir ce que de droit »."
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" loading={save.isPending} disabled={headerLines.length > 6}>
            Enregistrer le modèle
          </Button>
          <Button
            variant="secondary"
            loading={previewing}
            disabled={headerLines.length > 6}
            onClick={preview}
            aria-label={`Aperçu : ${template.label}`}
          >
            <Eye className="size-4" aria-hidden />
            Aperçu
          </Button>
        </div>
        <p className="text-[13px] text-muted">
          L’aperçu montre le modèle tel que saisi, avec un élève fictif et la mention « SPÉCIMEN » :
          aucun numéro du registre n’est utilisé.
        </p>
      </form>
    </Card>
  );
}

export default function TemplatesPage() {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['document-templates'],
    queryFn: () => api<Template[]>('/documents/templates'),
  });
  return (
    <>
      <nav aria-label="Fil d’Ariane" className="flex items-center gap-1.5 text-sm">
        <Link href="/documents" className="font-semibold text-primary">
          Documents administratifs
        </Link>
        <ChevronRight className="size-3.5 text-muted" aria-hidden />
        <span className="text-muted">Modèles</span>
      </nav>
      <PageHeader
        title="Modèles de documents"
        subtitle="En-tête, signataire et mentions propres à votre établissement. Les documents déjà délivrés ne changent pas."
      />
      {!can('documents.configure') ? (
        <EmptyState title="Réservé à la direction">
          Seule la direction peut modifier les modèles de documents.
        </EmptyState>
      ) : q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {q.data.map((t) => (
            <TemplateCard key={t.type} template={t} />
          ))}
        </div>
      )}
    </>
  );
}
