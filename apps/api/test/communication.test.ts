import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayInCameroon } from '../src/common/dates';
import { CalendarService } from '../src/modules/calendar/calendar.module';
import { MemoryEmailProvider } from '../src/modules/notifications/email.provider';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { MemorySmsProvider } from '../src/modules/notifications/sms.provider';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, requestOtp, resetDb, type Session, toSession } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  f = await seedSchool();
  s = await sessions(app);
});

async function parentLogin(phone: string): Promise<Session> {
  const code = await requestOtp(app, phone);
  return toSession(await http().post('/auth/otp/verify').send({ phone, code }).expect(200));
}

/** Élèves de la démo : Marie-Claire (4e A), Junior (4e B), Awa (6e A). */
async function enrollFamilies() {
  const mc = await enrollStudent(app, s.secretariat, {
    firstName: 'Marie-Claire',
    lastName: 'Ngono',
    classId: f.class4AId,
    phone: '677123456',
  });
  const junior = await enrollStudent(app, s.secretariat, {
    firstName: 'Junior',
    lastName: 'Tchoupo',
    classId: f.class4BId,
    phone: '695442108',
    gender: 'M',
  });
  const awa = await enrollStudent(app, s.secretariat, {
    firstName: 'Awa',
    lastName: 'Bello',
    classId: f.class6AId,
    phone: '699887766',
  });
  return { mc, junior, awa };
}

async function guardianOf(studentId: string, as: Session = s.direction) {
  const res = await http()
    .get(`/messages/contacts?studentId=${studentId}`)
    .set(as.auth)
    .expect(200);
  return res.body[0] as { guardianId: string; firstName: string };
}

async function outbox(template: string) {
  return prisma.notificationOutbox.findMany({ where: { template }, orderBy: { createdAt: 'asc' } });
}

async function releaseOutbox() {
  await prisma.notificationOutbox.updateMany({
    where: { status: 'PENDING' },
    data: { availableAt: new Date(Date.now() - 1000) },
  });
  return app.get(NotificationsService).dispatchPending();
}

describe('annonces', () => {
  it('vise les parents de quelques élèves seulement, par SMS ou par e-mail', async () => {
    const { mc, junior, awa } = await enrollFamilies();
    // L'école préfère l'e-mail ; seul le parent de Junior en a renseigné un.
    await http()
      .patch('/settings')
      .set(s.direction.auth)
      .send({ settings: { preferredChannel: 'EMAIL' } })
      .expect(200);
    const juniorDetail = await http().get(`/students/${junior.id}`).set(s.direction.auth);
    await http()
      .patch(`/students/${junior.id}/guardians/${juniorDetail.body.guardians[0].linkId}/contact`)
      .set(s.secretariat.auth)
      .send({ email: 'Tchoupo.Parent@exemple.cm' })
      .expect(200);

    const res = await http()
      .post('/announcements')
      .set(s.secretariat.auth)
      .send({
        title: 'Sortie au musée national',
        body: 'Merci de signer l’autorisation avant vendredi.',
        scope: 'STUDENTS',
        studentIds: [mc.id, junior.id],
        sendSms: true,
      })
      .expect(201);
    expect(res.body).toMatchObject({ scope: 'STUDENTS', sms: 1, emails: 1 });
    const sent = await outbox('announcement');
    expect(sent.map((n) => [n.channel, n.recipient]).sort()).toEqual([
      ['EMAIL', 'tchoupo.parent@exemple.cm'],
      ['SMS', '+237677123456'],
    ]);

    await releaseOutbox();
    const mail = MemoryEmailProvider.lastTo('tchoupo.parent@exemple.cm');
    expect(mail?.subject).toBe('Collège demo : Sortie au musée national');
    expect(mail?.text).toContain('Merci de signer l’autorisation avant vendredi.');
    expect(MemorySmsProvider.lastTo('+237677123456')).toContain('Sortie au musée national');
    expect(MemorySmsProvider.countTo('+237699887766')).toBe(0);

    // Visible sur le portail des seuls élèves visés.
    const parent = await parentLogin('699887766');
    const overview = await http().get(`/portal/children/${awa.id}`).set(parent.auth).expect(200);
    expect(overview.body.announcements).toEqual([]);
    const ngono = await parentLogin('677123456');
    const mcView = await http().get(`/portal/children/${mc.id}`).set(ngono.auth).expect(200);
    expect(mcView.body.announcements.map((a: { title: string }) => a.title)).toEqual([
      'Sortie au musée national',
    ]);
  });

  it('refuse une annonce sans élève ou vers un élève d’une autre école', async () => {
    await http()
      .post('/announcements')
      .set(s.secretariat.auth)
      .send({ title: 'Titre', body: 'Message', scope: 'STUDENTS', studentIds: [] })
      .expect(400);
    const other = await seedSchool('autre', 'AU');
    const so = await sessions(app, 'autre');
    const foreign = await enrollStudent(app, so.secretariat, {
      firstName: 'Paul',
      lastName: 'Etoundi',
      classId: other.class4AId,
    });
    await http()
      .post('/announcements')
      .set(s.secretariat.auth)
      .send({ title: 'Titre', body: 'Message', scope: 'STUDENTS', studentIds: [foreign.id] })
      .expect(404);
  });
});

describe('canal e-mail', () => {
  it('se replie sur le SMS sans adresse et réessaie après un échec SMTP', async () => {
    const notifications = app.get(NotificationsService);
    const viaSms = await notifications.notifyContact(
      { schoolId: f.schoolId, contact: { phone: '+237677000000' }, template: 't', body: 'B' },
      undefined,
      'EMAIL',
    );
    expect(viaSms?.channel).toBe('SMS');
    expect(
      await notifications.notifyContact(
        { schoolId: f.schoolId, contact: {}, template: 't', body: 'B' },
        undefined,
        'SMS',
      ),
    ).toBeNull();
    const mail = await notifications.notifyContact(
      {
        schoolId: f.schoolId,
        contact: { email: 'parent@exemple.cm' },
        template: 't',
        body: 'Court',
        emailBody: 'Texte complet',
        subject: 'Objet',
      },
      undefined,
      'SMS',
    );
    expect(mail).toMatchObject({ channel: 'EMAIL', recipient: 'parent@exemple.cm' });
    MemoryEmailProvider.failNext = 1;
    await notifications.dispatchPending();
    let row = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: mail!.id } });
    expect(row).toMatchObject({ status: 'PENDING', lastError: 'Échec simulé du serveur SMTP' });
    await releaseOutbox();
    row = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: mail!.id } });
    expect(row.status).toBe('SENT');
    expect(MemoryEmailProvider.lastTo('parent@exemple.cm')).toEqual({
      to: 'parent@exemple.cm',
      subject: 'Objet',
      text: 'Texte complet',
    });
  });

  it('laisse le parent renseigner son adresse depuis le portail', async () => {
    await enrollFamilies();
    const parent = await parentLogin('677123456');
    await http()
      .patch('/portal/contact')
      .set(parent.auth)
      .send({ email: 'pas-une-adresse' })
      .expect(400);
    const res = await http()
      .patch('/portal/contact')
      .set(parent.auth)
      .send({ email: 'ngono@exemple.cm' })
      .expect(200);
    expect(res.body).toEqual({ phone: '+237677123456', email: 'ngono@exemple.cm' });
    const guardian = await prisma.guardian.findFirstOrThrow({ where: { phone: '+237677123456' } });
    expect(guardian.email).toBe('ngono@exemple.cm');
    expect(
      await prisma.auditLog.count({
        where: { action: 'portal.contact_updated', entityId: guardian.id },
      }),
    ).toBe(1);
  });
});

describe('messagerie enseignants-parents', () => {
  it("permet à l'enseignant d'écrire aux parents de ses élèves seulement", async () => {
    const { mc, junior } = await enrollFamilies();
    const guardian = await guardianOf(mc.id, s.prof);
    // 4e B : le professeur n'y enseigne pas ; l'élève est signalé introuvable.
    await http().get(`/messages/contacts?studentId=${junior.id}`).set(s.prof.auth).expect(404);
    const juniorGuardian = await guardianOf(junior.id);
    await http()
      .post('/messages/threads')
      .set(s.prof.auth)
      .send({ studentId: junior.id, guardianId: juniorGuardian.guardianId, body: 'Bonjour' })
      .expect(404);
    // Parent d'un autre élève associé à un élève de sa classe.
    await http()
      .post('/messages/threads')
      .set(s.prof.auth)
      .send({ studentId: mc.id, guardianId: juniorGuardian.guardianId, body: 'Bonjour' })
      .expect(404);
    // Le secrétariat n'a pas accès à la messagerie.
    await http().get('/messages/threads').set(s.secretariat.auth).expect(403);

    const thread = await http()
      .post('/messages/threads')
      .set(s.prof.auth)
      .send({
        studentId: mc.id,
        guardianId: guardian.guardianId,
        body: 'Marie-Claire a oublié son cahier.',
      })
      .expect(201);
    expect(thread.body).toMatchObject({
      student: { firstName: 'Marie-Claire', className: '4e A' },
      staff: { labels: ['Professeur principal', 'Mathématiques'] },
      unread: 0,
    });
    expect(thread.body.messages).toHaveLength(1);
    expect(thread.body.messages[0]).toMatchObject({ authorKind: 'STAFF', mine: true });
    // Un second envoi réutilise le même fil.
    const again = await http()
      .post('/messages/threads')
      .set(s.prof.auth)
      .send({ studentId: mc.id, guardianId: guardian.guardianId, body: 'Merci de vérifier.' })
      .expect(201);
    expect(again.body.id).toBe(thread.body.id);
    expect(again.body.messages).toHaveLength(2);
    // Un collègue ne lit pas le fil d'un autre enseignant.
    await http().get(`/messages/threads/${thread.body.id}`).set(s.prof2.auth).expect(404);
  });

  it('relie parent et personnel de la classe, avec compteurs de non-lus', async () => {
    const { mc, junior } = await enrollFamilies();
    const parent = await parentLogin('677123456');
    const contacts = await http()
      .get(`/portal/children/${mc.id}/contacts`)
      .set(parent.auth)
      .expect(200);
    const byName = Object.fromEntries(
      contacts.body.map((c: { lastName: string; labels: string[] }) => [c.lastName, c.labels]),
    );
    expect(byName).toEqual({
      prof: ['Professeur principal (4e A)', 'Mathématiques'],
      prof2: ['Anglais', 'Français'],
      surveillant: ['Vie scolaire'],
    });
    // Pas la comptabilité, pas un enfant qui n'est pas le sien.
    await http()
      .post('/portal/messages/threads')
      .set(parent.auth)
      .send({ studentId: mc.id, staffUserId: f.users.accountant, body: 'Bonjour' })
      .expect(404);
    await http().get(`/portal/children/${junior.id}/contacts`).set(parent.auth).expect(404);

    const started = await http()
      .post('/portal/messages/threads')
      .set(parent.auth)
      .send({ studentId: mc.id, staffUserId: f.users.teacher2, body: 'Peut-on se voir jeudi ?' })
      .expect(201);
    expect(started.body.messages[0]).toMatchObject({ authorKind: 'PARENT', mine: true });

    expect((await http().get('/messages/unread').set(s.prof2.auth)).body).toEqual({ count: 1 });
    const list = await http().get('/messages/threads').set(s.prof2.auth).expect(200);
    expect(list.body[0]).toMatchObject({
      unread: 1,
      guardian: { lastName: 'Ngono', relationship: 'FATHER' },
      lastMessage: { body: 'Peut-on se voir jeudi ?', authorKind: 'PARENT' },
    });
    await http().get(`/messages/threads/${started.body.id}`).set(s.prof2.auth).expect(200);
    expect((await http().get('/messages/unread').set(s.prof2.auth)).body).toEqual({ count: 0 });

    await http()
      .post(`/messages/threads/${started.body.id}/messages`)
      .set(s.prof2.auth)
      .send({ body: 'Oui, à 15 h.' })
      .expect(201);
    await http()
      .post(`/messages/threads/${started.body.id}/messages`)
      .set(s.prof2.auth)
      .send({ body: '   ' })
      .expect(400);
    expect((await http().get('/portal/messages/unread').set(parent.auth)).body).toEqual({
      count: 1,
    });
    const threads = await http().get('/portal/messages/threads').set(parent.auth).expect(200);
    expect(threads.body).toHaveLength(1);
    expect(threads.body[0]).toMatchObject({ unread: 1, school: { name: 'Collège demo' } });
    const read = await http()
      .get(`/portal/messages/threads/${started.body.id}`)
      .set(parent.auth)
      .expect(200);
    expect(read.body.messages.map((m: { body: string }) => m.body)).toEqual([
      'Peut-on se voir jeudi ?',
      'Oui, à 15 h.',
    ]);
    expect((await http().get('/portal/messages/unread').set(parent.auth)).body).toEqual({
      count: 0,
    });

    // Un autre parent ne lit ni ne répond à ce fil.
    const other = await parentLogin('695442108');
    await http().get(`/portal/messages/threads/${started.body.id}`).set(other.auth).expect(404);
    await http()
      .post(`/portal/messages/threads/${started.body.id}/messages`)
      .set(other.auth)
      .send({ body: 'Intrus' })
      .expect(404);
    expect((await http().get('/portal/messages/threads').set(other.auth)).body).toEqual([]);
  });

  it('regroupe les notifications et les annule si le message a été lu', async () => {
    const { mc } = await enrollFamilies();
    const guardian = await guardianOf(mc.id, s.prof);
    const before = Date.now();
    const thread = await http()
      .post('/messages/threads')
      .set(s.prof.auth)
      .send({ studentId: mc.id, guardianId: guardian.guardianId, body: 'Premier message' })
      .expect(201);
    for (const body of ['Deuxième', 'Troisième']) {
      await http()
        .post(`/messages/threads/${thread.body.id}/messages`)
        .set(s.prof.auth)
        .send({ body })
        .expect(201);
    }
    let pending = await outbox('message.new');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ channel: 'SMS', recipient: '+237677123456' });
    expect(pending[0]!.body).toContain('nouveau message de Prénom prof au sujet de Marie-Claire');
    expect(pending[0]!.body).not.toContain('Premier message');
    expect(pending[0]!.availableAt.getTime()).toBeGreaterThanOrEqual(before + 9 * 60_000);
    // Rien ne part avant le délai de regroupement.
    await app.get(NotificationsService).dispatchPending();
    expect(MemorySmsProvider.countTo('+237677123456')).toBe(0);

    await releaseOutbox();
    expect(MemorySmsProvider.countTo('+237677123456')).toBe(1);

    // Après l'envoi, un nouveau message attend la fin de l'intervalle minimal (3 h).
    await http()
      .post(`/messages/threads/${thread.body.id}/messages`)
      .set(s.prof.auth)
      .send({ body: 'Quatrième' })
      .expect(201);
    pending = await prisma.notificationOutbox.findMany({
      where: { template: 'message.new', status: 'PENDING' },
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.availableAt.getTime()).toBeGreaterThan(Date.now() + 2.9 * 3600_000);
    // Le parent lit le fil entre-temps : la notification est annulée.
    const parent = await parentLogin('677123456');
    const smsBefore = MemorySmsProvider.countTo('+237677123456');
    await http().get(`/portal/messages/threads/${thread.body.id}`).set(parent.auth).expect(200);
    await releaseOutbox();
    expect(
      (await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: pending[0]!.id } })).status,
    ).toBe('CANCELLED');
    expect(MemorySmsProvider.countTo('+237677123456')).toBe(smsBefore);

    // Réponse du parent : le professeur (sans téléphone) est prévenu par e-mail.
    await http()
      .post(`/portal/messages/threads/${thread.body.id}/messages`)
      .set(parent.auth)
      .send({ body: 'Bien reçu, merci.' })
      .expect(201);
    await releaseOutbox();
    expect(MemoryEmailProvider.lastTo('prof@demo.cm')?.subject).toBe(
      'Nouveau message au sujet de Marie-Claire',
    );
  });

  it('laisse la direction consulter un fil sur motif journalisé, sans en lire le contenu sinon', async () => {
    const { mc } = await enrollFamilies();
    const guardian = await guardianOf(mc.id, s.prof);
    const thread = await http()
      .post('/messages/threads')
      .set(s.prof.auth)
      .send({ studentId: mc.id, guardianId: guardian.guardianId, body: 'Message confidentiel' })
      .expect(201);
    const list = await http().get('/messages/oversight').set(s.direction.auth).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: thread.body.id, messageCount: 1 });
    expect(JSON.stringify(list.body)).not.toContain('Message confidentiel');
    await http().get('/messages/oversight').set(s.prof.auth).expect(403);
    await http()
      .post(`/messages/threads/${thread.body.id}/consult`)
      .set(s.censeur.auth)
      .send({ reason: 'Plainte d’un parent reçue ce matin' })
      .expect(403);
    await http()
      .post(`/messages/threads/${thread.body.id}/consult`)
      .set(s.direction.auth)
      .send({ reason: 'court' })
      .expect(400);
    const consulted = await http()
      .post(`/messages/threads/${thread.body.id}/consult`)
      .set(s.direction.auth)
      .send({ reason: 'Plainte d’un parent reçue ce matin' })
      .expect(201);
    expect(consulted.body.messages[0]).toMatchObject({
      body: 'Message confidentiel',
      mine: false,
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'messaging.thread_consulted' },
    });
    expect(audit).toMatchObject({
      entityId: thread.body.id,
      actorId: f.users.director,
      reason: 'Plainte d’un parent reçue ce matin',
    });
    // Un message envoyé ne se modifie pas.
    await expect(
      prisma.message.updateMany({ where: { threadId: thread.body.id }, data: { body: 'x' } }),
    ).rejects.toThrow(/ne peut pas être modifié/);
  });

  it('isole les fils de discussion entre établissements', async () => {
    const { mc } = await enrollFamilies();
    const guardian = await guardianOf(mc.id, s.prof);
    const thread = await http()
      .post('/messages/threads')
      .set(s.prof.auth)
      .send({ studentId: mc.id, guardianId: guardian.guardianId, body: 'Bonjour' })
      .expect(201);
    await seedSchool('autre', 'AU');
    const so = await sessions(app, 'autre');
    expect((await http().get('/messages/oversight').set(so.direction.auth)).body).toEqual([]);
    await http()
      .post(`/messages/threads/${thread.body.id}/consult`)
      .set(so.direction.auth)
      .send({ reason: 'Tentative depuis une autre école' })
      .expect(404);
    await http().get(`/messages/contacts?studentId=${mc.id}`).set(so.direction.auth).expect(404);
    await http()
      .post('/messages/threads')
      .set(so.direction.auth)
      .send({ studentId: mc.id, guardianId: guardian.guardianId, body: 'Bonjour' })
      .expect(404);
  });
});

describe('calendrier des événements', () => {
  it('publie des événements par portée, visibles des parents concernés', async () => {
    const { mc, junior } = await enrollFamilies();
    const meeting = await http()
      .post('/events')
      .set(s.direction.auth)
      .send({
        title: 'Réunion des parents de 4e A',
        category: 'PARENT_MEETING',
        startDate: '2026-11-12',
        startTime: '15:00',
        endTime: '17:00',
        location: 'Salle polyvalente',
        scope: 'CLASS',
        targetId: f.class4AId,
        remindBySms: true,
      })
      .expect(201);
    expect(meeting.body).toMatchObject({
      endDate: '2026-11-12',
      targetName: '4e A',
      categoryLabel: 'Réunion de parents',
    });
    await http()
      .post('/events')
      .set(s.direction.auth)
      .send({
        title: 'Congés de Noël',
        category: 'HOLIDAY',
        startDate: '2026-12-19',
        endDate: '2027-01-04',
        scope: 'SCHOOL',
      })
      .expect(201);
    await http()
      .post('/events')
      .set(s.direction.auth)
      .send({ title: 'Cible', category: 'OUTING', startDate: '2026-11-20', scope: 'LEVEL' })
      .expect(400);
    await http()
      .post('/events')
      .set(s.prof.auth)
      .send({ title: 'Sortie', category: 'OUTING', startDate: '2026-11-20', scope: 'SCHOOL' })
      .expect(403);

    // L'enseignant consulte le calendrier ; les congés débordent sur janvier.
    const january = await http()
      .get('/events?from=2027-01-01&to=2027-01-31')
      .set(s.prof.auth)
      .expect(200);
    expect(january.body.map((e: { title: string }) => e.title)).toEqual(['Congés de Noël']);
    await http().get('/events?from=2027-01-31&to=2027-01-01').set(s.prof.auth).expect(400);

    const ngono = await parentLogin('677123456');
    const forMc = await http()
      .get(`/portal/children/${mc.id}/events?from=2026-11-01&to=2026-12-31`)
      .set(ngono.auth)
      .expect(200);
    expect(forMc.body.map((e: { title: string }) => e.title)).toEqual([
      'Réunion des parents de 4e A',
      'Congés de Noël',
    ]);
    const tchoupo = await parentLogin('695442108');
    const forJunior = await http()
      .get(`/portal/children/${junior.id}/events?from=2026-11-01&to=2026-12-31`)
      .set(tchoupo.auth)
      .expect(200);
    expect(forJunior.body.map((e: { title: string }) => e.title)).toEqual(['Congés de Noël']);
    await http()
      .get(`/portal/children/${mc.id}/events?from=2026-11-01&to=2026-12-31`)
      .set(tchoupo.auth)
      .expect(404);

    // Une autre école ne voit ni ne supprime ces événements.
    await seedSchool('autre', 'AU');
    const so = await sessions(app, 'autre');
    expect(
      (await http().get('/events?from=2026-11-01&to=2026-12-31').set(so.direction.auth)).body,
    ).toEqual([]);
    await http().delete(`/events/${meeting.body.id}`).set(so.direction.auth).expect(404);
    await http().delete(`/events/${meeting.body.id}`).set(s.direction.auth).expect(200);
    expect(await prisma.auditLog.count({ where: { action: 'calendar.event_deleted' } })).toBe(1);
  });

  it('envoie le rappel la veille aux parents concernés, une seule fois', async () => {
    const { mc } = await enrollFamilies();
    const tomorrow = addDays(todayInCameroon(), 1);
    await http()
      .post('/events')
      .set(s.direction.auth)
      .send({
        title: 'Sortie au zoo de Mvog-Betsi',
        category: 'OUTING',
        startDate: tomorrow,
        startTime: '08:00',
        scope: 'LEVEL',
        targetId: f.level4Id,
        remindBySms: true,
      })
      .expect(201);
    await http()
      .post('/events')
      .set(s.direction.auth)
      .send({ title: 'Sans rappel', category: 'OTHER', startDate: tomorrow, scope: 'SCHOOL' })
      .expect(201);
    const calendar = app.get(CalendarService);
    expect(await calendar.sendReminders()).toEqual({ events: 1, notifications: 2 });
    expect(await calendar.sendReminders()).toEqual({ events: 0, notifications: 0 });
    await releaseOutbox();
    expect(MemorySmsProvider.lastTo('+237677123456')).toMatch(
      /rappel, Sortie au zoo de Mvog-Betsi demain .* à 08:00/,
    );
    expect(MemorySmsProvider.countTo('+237695442108')).toBe(1);
    // Élève de 6e : hors de la portée « 4e ».
    expect(MemorySmsProvider.countTo('+237699887766')).toBe(0);
    void mc;
  });
});
