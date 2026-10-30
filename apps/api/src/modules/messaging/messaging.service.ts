import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { GuardianRelationship, MessageAuthor, MessageThread, Prisma } from '@prisma/client';
import { pickChannel, planMessageNotification } from '@ecole/shared';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, parentContext, runAsSystem, staffContext } from '../../common/context';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { subjects, templates } from '../notifications/templates';
import { ParentLinkService } from './parent-link';

export const MESSAGE_TEMPLATE = 'message.new';
const PERMISSION = 'messaging.use' as const;
const DAY_MS = 86_400_000;

type Side = MessageAuthor;
const other = (side: Side): Side => (side === 'STAFF' ? 'PARENT' : 'STAFF');

interface Person {
  id: string;
  firstName: string;
  lastName: string;
}

export interface ThreadSummary {
  id: string;
  student: Person & { className: string | null };
  guardian: Person & { relationship: GuardianRelationship | null };
  staff: Person & { labels: string[] };
  school: { id: string; name: string };
  lastMessage: { body: string; authorKind: Side; createdAt: Date } | null;
  lastMessageAt: Date;
  unread: number;
}

/**
 * Messagerie enseignants-parents : un fil par élève, parent et membre du personnel.
 * Un enseignant n'écrit qu'aux parents de ses élèves ; un parent écrit au personnel de la classe
 * de son enfant (enseignants, professeur principal, vie scolaire). La direction consulte un fil
 * sur motif journalisé. Les notifications passent par la table d'envoi, regroupées.
 */
@Injectable()
export class MessagingService implements OnModuleInit {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly parents: ParentLinkService,
  ) {}

  onModuleInit(): void {
    // Pas de notification pour un fil lu entre-temps.
    this.notifications.registerGuard(MESSAGE_TEMPLATE, (n) => {
      const payload = n.payload as { threadId?: string; side?: Side };
      if (!payload.threadId || !payload.side) return Promise.resolve(true);
      return runAsSystem(
        'message-notification-guard',
        () => this.unreadFor(payload.threadId!, payload.side!).then((count) => count > 0),
        n.schoolId ?? undefined,
      );
    });
  }

  // Personnel

  async staffThreads(): Promise<ThreadSummary[]> {
    const threads = await this.db.messageThread.findMany({
      where: { staffUserId: staffContext().userId },
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
    });
    return this.summaries(threads, 'STAFF');
  }

  async staffUnread(): Promise<{ count: number }> {
    const threads = await this.db.messageThread.findMany({
      where: { staffUserId: staffContext().userId },
      select: { id: true },
    });
    const counts = await this.unreadByThread(
      threads.map((t) => t.id),
      'STAFF',
    );
    return { count: [...counts.values()].reduce((a, b) => a + b, 0) };
  }

  /** Parents d'un élève à qui le membre du personnel peut écrire. */
  async guardiansFor(studentId: string) {
    await this.assertStaffCanReach(studentId);
    const links = await this.db.studentGuardian.findMany({
      where: { studentId },
      include: { guardian: true },
      orderBy: { isPrimary: 'desc' },
    });
    return links.map((l) => ({
      guardianId: l.guardianId,
      firstName: l.guardian.firstName,
      lastName: l.guardian.lastName,
      relationship: l.relationship,
      isPrimary: l.isPrimary,
      portalActive: !!l.guardian.userId,
    }));
  }

  async staffStart(input: { studentId: string; guardianId: string; body: string }) {
    await this.assertStaffCanReach(input.studentId);
    const link = await this.db.studentGuardian.findFirst({
      where: { studentId: input.studentId, guardianId: input.guardianId },
    });
    if (!link) throw new NotFoundException('Parent introuvable pour cet élève');
    const userId = staffContext().userId;
    const threadId = await this.db.$transaction(async (tx) => {
      const thread = await this.findOrCreate(tx, {
        schoolId: currentSchoolId(),
        studentId: input.studentId,
        guardianId: input.guardianId,
        staffUserId: userId,
        createdById: userId,
      });
      await this.post(tx, thread, 'STAFF', userId, input.body);
      return thread.id;
    });
    return this.staffThread(threadId);
  }

  async staffThread(threadId: string) {
    const thread = await this.staffOwnThread(threadId);
    const now = new Date();
    await this.db.messageThread.update({
      where: { id: thread.id },
      data: { staffLastReadAt: now },
    });
    return this.detail({ ...thread, staffLastReadAt: now }, 'STAFF');
  }

  async staffReply(threadId: string, body: string) {
    const thread = await this.staffOwnThread(threadId);
    await this.assertStaffCanReach(thread.studentId);
    const userId = staffContext().userId;
    await this.db.$transaction((tx) => this.post(tx, thread, 'STAFF', userId, body));
    return this.staffThread(threadId);
  }

  /** Direction : liste de tous les fils, sans leur contenu. */
  async oversight() {
    const threads = await this.db.messageThread.findMany({
      orderBy: { lastMessageAt: 'desc' },
      take: 200,
      include: { _count: { select: { messages: true } } },
    });
    const summaries = await this.summaries(threads, null);
    const counts = new Map(threads.map((t) => [t.id, t._count.messages]));
    return summaries.map(({ lastMessage: _hidden, unread: _unread, ...s }) => ({
      ...s,
      messageCount: counts.get(s.id) ?? 0,
    }));
  }

  /** Direction : lecture d'un fil sur motif, inscrite au journal d'audit. */
  async consult(threadId: string, reason: string) {
    const thread = await this.db.messageThread.findUnique({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Fil introuvable');
    await this.audit.log({
      action: 'messaging.thread_consulted',
      entity: 'MessageThread',
      entityId: thread.id,
      reason,
      after: { studentId: thread.studentId, staffUserId: thread.staffUserId },
    });
    return this.detail(thread, null);
  }

  // Parents

  async parentThreads(): Promise<ThreadSummary[]> {
    const links = await this.parents.children();
    const bySchool = new Map<string, Set<string>>();
    for (const l of links) {
      const set = bySchool.get(l.schoolId) ?? new Set<string>();
      set.add(`${l.student.id}:${l.guardianId}`);
      bySchool.set(l.schoolId, set);
    }
    const result: ThreadSummary[] = [];
    for (const [schoolId, pairs] of bySchool) {
      const list = await runAsSystem(
        'portal-threads',
        async () => {
          const threads = await this.db.messageThread.findMany({
            where: {
              OR: [...pairs].map((p) => {
                const [studentId, guardianId] = p.split(':');
                return { studentId, guardianId };
              }),
            },
            orderBy: { lastMessageAt: 'desc' },
            take: 100,
          });
          return this.summaries(threads, 'PARENT');
        },
        schoolId,
      );
      result.push(...list);
    }
    return result.sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
  }

  async parentUnread(): Promise<{ count: number }> {
    const threads = await this.parentThreads();
    return { count: threads.reduce((a, t) => a + t.unread, 0) };
  }

  /** Coordonnées du parent connecté (téléphone de connexion, e-mail facultatif). */
  async parentContact() {
    const userId = parentContext().userId;
    const guardians = await runAsSystem('portal-contact', () =>
      this.db.guardian.findMany({ where: { userId }, select: { phone: true, email: true } }),
    );
    return {
      phone: guardians[0]?.phone ?? null,
      email: guardians.find((g) => g.email)?.email ?? null,
    };
  }

  /** Le parent renseigne son e-mail : appliqué à ses fiches dans chaque établissement. */
  async setParentEmail(email: string | null) {
    const userId = parentContext().userId;
    const guardians = await runAsSystem('portal-contact', () =>
      this.db.guardian.findMany({
        where: { userId },
        select: { id: true, schoolId: true, email: true },
      }),
    );
    for (const g of guardians) {
      await runAsSystem(
        'portal-contact-update',
        async () => {
          await this.db.guardian.update({ where: { id: g.id }, data: { email } });
          await this.audit.log({
            action: 'portal.contact_updated',
            entity: 'Guardian',
            entityId: g.id,
            before: { email: g.email },
            after: { email },
          });
        },
        g.schoolId,
      );
    }
    return this.parentContact();
  }

  /** Personnel de la classe de l'enfant : enseignants, professeur principal, vie scolaire. */
  async contactsFor(studentId: string) {
    const link = await this.parents.child(studentId);
    return runAsSystem(
      'portal-contacts',
      async () => {
        const contacts = await this.classStaff(studentId, link.schoolId);
        return [...contacts.values()].sort(
          (a, b) =>
            a.lastName.localeCompare(b.lastName, 'fr') ||
            a.firstName.localeCompare(b.firstName, 'fr'),
        );
      },
      link.schoolId,
    );
  }

  async parentStart(input: { studentId: string; staffUserId: string; body: string }) {
    const link = await this.parents.child(input.studentId);
    const userId = parentContext().userId;
    const threadId = await runAsSystem(
      'portal-thread-start',
      async () => {
        const contacts = await this.classStaff(input.studentId, link.schoolId);
        if (!contacts.has(input.staffUserId))
          throw new NotFoundException(
            'Ce membre du personnel n’intervient pas auprès de votre enfant',
          );
        return this.db.$transaction(async (tx) => {
          const thread = await this.findOrCreate(tx, {
            schoolId: link.schoolId,
            studentId: input.studentId,
            guardianId: link.guardianId,
            staffUserId: input.staffUserId,
            createdById: userId,
          });
          await this.post(tx, thread, 'PARENT', userId, input.body);
          return thread.id;
        });
      },
      link.schoolId,
    );
    return this.parentThread(threadId);
  }

  async parentThread(threadId: string) {
    const thread = await this.parentOwnThread(threadId);
    return runAsSystem(
      'portal-thread',
      async () => {
        const now = new Date();
        await this.db.messageThread.update({
          where: { id: thread.id },
          data: { parentLastReadAt: now },
        });
        return this.detail({ ...thread, parentLastReadAt: now }, 'PARENT');
      },
      thread.schoolId,
    );
  }

  async parentReply(threadId: string, body: string) {
    const thread = await this.parentOwnThread(threadId);
    const userId = parentContext().userId;
    await runAsSystem(
      'portal-thread-reply',
      async () => {
        const membership = await this.db.membership.findUnique({
          where: { userId_schoolId: { userId: thread.staffUserId, schoolId: thread.schoolId } },
          select: { active: true },
        });
        if (!membership?.active)
          throw new ConflictException(
            'Ce membre du personnel ne fait plus partie de l’établissement',
          );
        await this.db.$transaction((tx) => this.post(tx, thread, 'PARENT', userId, body));
      },
      thread.schoolId,
    );
    return this.parentThread(threadId);
  }

  // Règles communes

  /** Un enseignant n'atteint que les élèves de ses classes ; les autres rôles, toute l'école. */
  private async assertStaffCanReach(studentId: string): Promise<void> {
    const student = await this.db.student.findFirst({
      where: { id: studentId, deletedAt: null },
      select: { id: true },
    });
    if (!student) throw new NotFoundException('Élève introuvable');
    await this.scope.assertStudentInScope(studentId, PERMISSION);
  }

  private async staffOwnThread(threadId: string) {
    const thread = await this.db.messageThread.findFirst({
      where: { id: threadId, staffUserId: staffContext().userId },
    });
    if (!thread) throw new NotFoundException('Fil introuvable');
    return thread;
  }

  private async parentOwnThread(threadId: string) {
    const thread = await runAsSystem('portal-thread-lookup', () =>
      this.db.messageThread.findUnique({ where: { id: threadId } }),
    );
    if (!thread) throw new NotFoundException('Fil introuvable');
    const link = await this.parents.child(thread.studentId).catch(() => null);
    if (!link || link.guardianId !== thread.guardianId || link.schoolId !== thread.schoolId)
      throw new NotFoundException('Fil introuvable');
    return thread;
  }

  /** Personnel actif de la classe de l'élève (année en cours), avec ses fonctions. */
  private async classStaff(studentId: string, schoolId: string) {
    const enrollment = await this.db.enrollment.findFirst({
      where: {
        studentId,
        status: { in: ['ENROLLED', 'REPEATING'] },
        class: { academicYear: { isCurrent: true } },
      },
      include: {
        class: {
          include: {
            subjects: {
              where: { teacherId: { not: null } },
              include: { subject: true },
              orderBy: { subject: { name: 'asc' } },
            },
          },
        },
      },
    });
    const labels = new Map<string, string[]>();
    const add = (userId: string | null, label: string) => {
      if (!userId) return;
      labels.set(userId, [...(labels.get(userId) ?? []), label]);
    };
    if (enrollment) {
      add(enrollment.class.mainTeacherId, `Professeur principal (${enrollment.class.name})`);
      for (const cs of enrollment.class.subjects) add(cs.teacherId, cs.subject.name);
    }
    const supervisors = await this.db.membership.findMany({
      where: { schoolId, active: true, roles: { has: 'SUPERVISOR' } },
      select: { userId: true },
    });
    for (const m of supervisors) add(m.userId, 'Vie scolaire');
    const active = await this.db.membership.findMany({
      where: {
        schoolId,
        active: true,
        userId: { in: [...labels.keys()] },
        user: { status: 'ACTIVE' },
      },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    return new Map(
      active.map((m) => [
        m.userId,
        {
          userId: m.userId,
          firstName: m.user.firstName,
          lastName: m.user.lastName,
          labels: labels.get(m.userId) ?? [],
        },
      ]),
    );
  }

  private async findOrCreate(
    tx: Tx,
    data: {
      schoolId: string;
      studentId: string;
      guardianId: string;
      staffUserId: string;
      createdById: string;
    },
  ): Promise<MessageThread> {
    const existing = await tx.messageThread.findUnique({
      where: {
        studentId_guardianId_staffUserId: {
          studentId: data.studentId,
          guardianId: data.guardianId,
          staffUserId: data.staffUserId,
        },
      },
    });
    if (existing) return existing;
    const thread = await tx.messageThread.create({ data });
    await this.audit.log(
      {
        action: 'messaging.thread_created',
        entity: 'MessageThread',
        entityId: thread.id,
        schoolId: data.schoolId,
        after: {
          studentId: data.studentId,
          guardianId: data.guardianId,
          staffUserId: data.staffUserId,
        },
      },
      tx,
    );
    return thread;
  }

  /** Ajoute un message, marque le fil lu pour l'auteur et prévoit la notification du destinataire. */
  private async post(
    tx: Tx,
    thread: MessageThread,
    side: Side,
    authorUserId: string,
    body: string,
  ): Promise<void> {
    const now = new Date();
    await tx.message.create({
      data: {
        schoolId: thread.schoolId,
        threadId: thread.id,
        authorKind: side,
        authorUserId,
        body,
      },
    });
    await tx.messageThread.update({
      where: { id: thread.id },
      data: {
        lastMessageAt: now,
        ...(side === 'STAFF' ? { staffLastReadAt: now } : { parentLastReadAt: now }),
      },
    });
    await this.scheduleNotification(tx, thread, other(side), authorUserId, now);
  }

  /** Notification « nouveau message », regroupée et plafonnée (anti-harcèlement). */
  private async scheduleNotification(
    tx: Tx,
    thread: MessageThread,
    recipientSide: Side,
    authorUserId: string,
    now: Date,
  ): Promise<void> {
    const contact =
      recipientSide === 'PARENT'
        ? await tx.guardian.findUnique({
            where: { id: thread.guardianId },
            select: { phone: true, email: true },
          })
        : await tx.user.findUnique({
            where: { id: thread.staffUserId },
            select: { phone: true, email: true },
          });
    if (!contact) return;
    const preferred = await this.notifications.preferredChannel(thread.schoolId, tx);
    const channel = pickChannel(contact, preferred);
    if (!channel) return;
    const recipient = (channel === 'SMS' ? contact.phone : contact.email)!.trim();
    const sameThread: Prisma.NotificationOutboxWhereInput = {
      template: MESSAGE_TEMPLATE,
      AND: [
        { payload: { path: ['threadId'], equals: thread.id } },
        { payload: { path: ['side'], equals: recipientSide } },
      ],
    };
    const [pending, lastSent, countLast24h] = await Promise.all([
      tx.notificationOutbox.count({ where: { ...sameThread, status: 'PENDING' } }),
      tx.notificationOutbox.findFirst({
        where: { ...sameThread, status: 'SENT' },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
      }),
      tx.notificationOutbox.count({
        where: {
          template: MESSAGE_TEMPLATE,
          recipient,
          status: { in: ['PENDING', 'SENT'] },
          createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        },
      }),
    ]);
    const plan = planMessageNotification(
      {
        pendingForThread: pending > 0,
        lastSentForThreadAt: lastSent?.sentAt ?? null,
        countLast24h,
      },
      now,
    );
    if (plan.action === 'skip') return;
    const [school, student, author] = await Promise.all([
      tx.school.findUniqueOrThrow({ where: { id: thread.schoolId }, select: { name: true } }),
      tx.student.findUniqueOrThrow({
        where: { id: thread.studentId },
        select: { firstName: true },
      }),
      tx.user.findUnique({
        where: { id: authorUserId },
        select: { firstName: true, lastName: true },
      }),
    ]);
    const from = author ? `${author.firstName} ${author.lastName}` : 'l’école';
    await this.notifications.enqueue(
      {
        schoolId: thread.schoolId,
        channel,
        recipient,
        template: MESSAGE_TEMPLATE,
        body: templates.messageNew({ school: school.name, from, student: student.firstName }),
        subject: subjects.messageNew({ student: student.firstName }),
        payload: { threadId: thread.id, side: recipientSide },
        availableAt: plan.availableAt,
      },
      tx,
    );
  }

  private async unreadFor(threadId: string, side: Side): Promise<number> {
    return (await this.unreadByThread([threadId], side)).get(threadId) ?? 0;
  }

  /** Messages de l'autre partie postérieurs à la dernière lecture, par fil (fils déjà autorisés). */
  private async unreadByThread(threadIds: string[], side: Side): Promise<Map<string, number>> {
    if (threadIds.length === 0) return new Map();
    const readAt =
      side === 'STAFF' ? Prisma.sql`t."staffLastReadAt"` : Prisma.sql`t."parentLastReadAt"`;
    const rows = await this.db.$queryRaw<{ threadId: string; count: number }[]>`
      SELECT m."threadId", COUNT(*)::int AS count
      FROM "Message" m JOIN "MessageThread" t ON t."id" = m."threadId"
      WHERE m."threadId" = ANY(${threadIds}::text[])
        AND m."authorKind" = ${other(side)}::"MessageAuthor"
        AND (${readAt} IS NULL OR m."createdAt" > ${readAt})
      GROUP BY m."threadId"`;
    return new Map(rows.map((r) => [r.threadId, Number(r.count)]));
  }

  /** Résumés des fils (élève, parent, personnel, dernier message, non lus pour `side`). */
  private async summaries(threads: MessageThread[], side: Side | null): Promise<ThreadSummary[]> {
    if (threads.length === 0) return [];
    const ids = threads.map((t) => t.id);
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    const [students, guardians, links, staff, lastMessages, unread, schools] = await Promise.all([
      this.db.student.findMany({
        where: { id: { in: threads.map((t) => t.studentId) } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          enrollments: {
            where: { academicYearId: year?.id ?? '' },
            select: { class: { select: { id: true, name: true } } },
          },
        },
      }),
      this.db.guardian.findMany({
        where: { id: { in: threads.map((t) => t.guardianId) } },
        select: { id: true, firstName: true, lastName: true },
      }),
      this.db.studentGuardian.findMany({
        where: {
          studentId: { in: threads.map((t) => t.studentId) },
          guardianId: { in: threads.map((t) => t.guardianId) },
        },
        select: { studentId: true, guardianId: true, relationship: true },
      }),
      this.db.user.findMany({
        where: { id: { in: threads.map((t) => t.staffUserId) } },
        select: { id: true, firstName: true, lastName: true },
      }),
      this.db.message.findMany({
        where: { threadId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        distinct: ['threadId'],
        select: { threadId: true, body: true, authorKind: true, createdAt: true },
      }),
      side ? this.unreadByThread(ids, side) : Promise.resolve(new Map<string, number>()),
      this.db.school.findMany({
        where: { id: { in: [...new Set(threads.map((t) => t.schoolId))] } },
        select: { id: true, name: true },
      }),
    ]);
    const studentById = new Map(students.map((s) => [s.id, s]));
    const guardianById = new Map(guardians.map((g) => [g.id, g]));
    const staffById = new Map(staff.map((u) => [u.id, u]));
    const lastById = new Map(lastMessages.map((m) => [m.threadId, m]));
    const schoolById = new Map(schools.map((s) => [s.id, s]));
    const classIds = [...new Set(students.flatMap((s) => s.enrollments.map((e) => e.class.id)))];
    const labelsByClass = await this.staffLabelsByClass(classIds);
    const unknown = { firstName: '—', lastName: '' };
    return threads.map((t) => {
      const s = studentById.get(t.studentId);
      const cls = s?.enrollments[0]?.class ?? null;
      const last = lastById.get(t.id);
      return {
        id: t.id,
        student: {
          id: t.studentId,
          firstName: s?.firstName ?? unknown.firstName,
          lastName: s?.lastName ?? unknown.lastName,
          className: cls?.name ?? null,
        },
        guardian: {
          id: t.guardianId,
          ...(guardianById.get(t.guardianId) ?? unknown),
          relationship:
            links.find((l) => l.studentId === t.studentId && l.guardianId === t.guardianId)
              ?.relationship ?? null,
        },
        staff: {
          id: t.staffUserId,
          ...(staffById.get(t.staffUserId) ?? unknown),
          labels: (cls && labelsByClass.get(`${cls.id}:${t.staffUserId}`)) ?? [],
        },
        school: schoolById.get(t.schoolId) ?? { id: t.schoolId, name: '' },
        lastMessage: last
          ? {
              body: last.body.length > 140 ? `${last.body.slice(0, 139)}…` : last.body,
              authorKind: last.authorKind,
              createdAt: last.createdAt,
            }
          : null,
        lastMessageAt: t.lastMessageAt,
        unread: unread.get(t.id) ?? 0,
      };
    });
  }

  /** Fonctions du personnel dans les classes données : clé « classe:utilisateur ». */
  private async staffLabelsByClass(classIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (classIds.length === 0) return result;
    const add = (key: string, label: string) =>
      result.set(key, [...(result.get(key) ?? []), label]);
    const classes = await this.db.class.findMany({
      where: { id: { in: classIds } },
      include: {
        subjects: {
          where: { teacherId: { not: null } },
          include: { subject: true },
          orderBy: { subject: { name: 'asc' } },
        },
      },
    });
    for (const c of classes) {
      if (c.mainTeacherId) add(`${c.id}:${c.mainTeacherId}`, 'Professeur principal');
      for (const cs of c.subjects) add(`${c.id}:${cs.teacherId}`, cs.subject.name);
    }
    const supervisors = await this.db.membership.findMany({
      where: {
        schoolId: { in: [...new Set(classes.map((c) => c.schoolId))] },
        active: true,
        roles: { has: 'SUPERVISOR' },
      },
      select: { userId: true },
    });
    for (const c of classes)
      for (const m of supervisors) add(`${c.id}:${m.userId}`, 'Vie scolaire');
    return result;
  }

  /** Fil complet : messages du plus ancien au plus récent (200 derniers). */
  private async detail(thread: MessageThread, side: Side | null) {
    const [summary] = await this.summaries([thread], side);
    const messages = await this.db.message.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return {
      ...summary!,
      messages: messages.reverse().map((m) => ({
        id: m.id,
        authorKind: m.authorKind,
        authorName:
          m.authorKind === 'STAFF'
            ? `${summary!.staff.firstName} ${summary!.staff.lastName}`.trim()
            : `${summary!.guardian.firstName} ${summary!.guardian.lastName}`.trim(),
        body: m.body,
        createdAt: m.createdAt,
        mine: side !== null && m.authorKind === side,
      })),
    };
  }
}
