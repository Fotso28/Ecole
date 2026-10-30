'use client';

import { ArrowLeft, SendHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';
import type { ChatMessage, ThreadSummary } from '@/lib/communication';
import { RELATION_LABELS } from '@/lib/communication';
import { cn } from '@/lib/utils';

/** Liste des fils : élève, interlocuteur, aperçu du dernier message et non-lus. */
export function ThreadList({
  threads,
  hrefFor,
  viewer,
}: {
  threads: ThreadSummary[];
  hrefFor: (id: string) => string;
  viewer: 'STAFF' | 'PARENT';
}) {
  return (
    <ul className="flex flex-col gap-2" aria-label="Conversations">
      {threads.map((t) => {
        const counterpart =
          viewer === 'STAFF'
            ? `${t.guardian.firstName} ${t.guardian.lastName}${t.guardian.relationship ? ` (${RELATION_LABELS[t.guardian.relationship].toLowerCase()})` : ''}`
            : `${t.staff.firstName} ${t.staff.lastName}`;
        const context =
          viewer === 'STAFF'
            ? `${t.student.firstName} ${t.student.lastName}${t.student.className ? ` · ${t.student.className}` : ''}`
            : [t.staff.labels.join(', '), t.student.firstName].filter(Boolean).join(' · ');
        return (
          <li key={t.id}>
            <Link
              href={hrefFor(t.id)}
              className={cn(
                'flex min-h-16 items-start gap-3 rounded-[14px] border bg-white p-3 hover:bg-paper',
                t.unread > 0 ? 'border-primary' : 'border-line',
              )}
            >
              <span
                aria-hidden
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary"
              >
                {(viewer === 'STAFF' ? t.guardian.firstName : t.staff.firstName)[0]}
                {(viewer === 'STAFF' ? t.guardian.lastName : t.staff.lastName)[0]}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline justify-between gap-2">
                  <strong className="truncate text-[15px]">{counterpart}</strong>
                  <span className="shrink-0 text-xs text-muted">
                    {formatDateTime(t.lastMessageAt)}
                  </span>
                </span>
                <span className="truncate text-[13px] text-muted">{context}</span>
                {t.lastMessage ? (
                  <span
                    className={cn(
                      'line-clamp-2 text-sm [overflow-wrap:anywhere]',
                      t.unread > 0 ? 'font-semibold text-ink' : 'text-muted',
                    )}
                  >
                    {t.lastMessage.authorKind === viewer ? 'Vous : ' : ''}
                    {t.lastMessage.body}
                  </span>
                ) : null}
              </span>
              {t.unread > 0 ? (
                <span className="mt-1 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-white">
                  {t.unread}
                  <span className="sr-only">
                    {' '}
                    {t.unread > 1 ? 'messages non lus' : 'message non lu'}
                  </span>
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Fil de discussion pensé pour le téléphone : bulles, saisie en bas, défilement vers le dernier message. */
export function ChatView({
  title,
  subtitle,
  backHref,
  messages,
  onSend,
  sending,
  notice,
  headingLevel = 1,
}: {
  /** 2 dans le portail, dont l'en-tête porte déjà le titre principal. */
  headingLevel?: 1 | 2;
  title: ReactNode;
  subtitle?: ReactNode;
  backHref: string;
  messages: ChatMessage[];
  /** Absent : lecture seule (consultation par la direction). */
  onSend?: (body: string) => Promise<unknown>;
  sending?: boolean;
  notice?: ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Link
          href={backHref}
          aria-label="Retour aux conversations"
          className="flex size-11 shrink-0 items-center justify-center rounded-[12px] border border-line-strong bg-white"
        >
          <ArrowLeft className="size-5" aria-hidden />
        </Link>
        <div className="flex min-w-0 flex-col">
          <Heading className="truncate font-display text-xl leading-tight font-bold lg:text-2xl">
            {title}
          </Heading>
          {subtitle ? <p className="truncate text-[13px] text-muted">{subtitle}</p> : null}
        </div>
      </div>
      {notice}
      {messages.length === 0 ? (
        <EmptyState title="Aucun message" />
      ) : (
        <ol className="flex flex-col gap-2.5" aria-label="Messages">
          {messages.map((m) => (
            <li
              key={m.id}
              className={cn('flex flex-col gap-1', m.mine ? 'items-end' : 'items-start')}
            >
              <span className="px-1 text-xs text-muted">
                {m.mine ? 'Vous' : m.authorName} · {formatDateTime(m.createdAt)}
              </span>
              <p
                className={cn(
                  'max-w-[85%] rounded-[16px] px-3.5 py-2.5 text-[15px] whitespace-pre-line [overflow-wrap:anywhere] lg:max-w-[70%] lg:text-sm',
                  m.mine
                    ? 'rounded-br-[4px] bg-primary text-white'
                    : 'rounded-bl-[4px] border border-line bg-white text-ink',
                )}
              >
                {m.body}
              </p>
            </li>
          ))}
        </ol>
      )}
      <div ref={endRef} />
      {onSend ? (
        <form
          className="sticky bottom-24 flex items-end gap-2 rounded-[16px] border border-line bg-white p-2 lg:bottom-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const body = draft.trim();
            if (!body) return;
            try {
              await onSend(body);
              setDraft('');
            } catch {
              // Échec signalé par l'appelant : le brouillon est conservé.
            }
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col">
            <span className="sr-only">Votre message</span>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Écrire un message…"
              rows={2}
              maxLength={2000}
              className="min-h-12 w-full resize-none rounded-[10px] bg-paper px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-primary lg:text-sm"
            />
          </label>
          <Button
            type="submit"
            size="icon"
            loading={sending}
            disabled={!draft.trim()}
            aria-label="Envoyer"
          >
            {sending ? null : <SendHorizontal className="size-5" aria-hidden />}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
