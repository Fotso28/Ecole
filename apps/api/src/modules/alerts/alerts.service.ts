import { readFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import type { OpsAlertState, Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { Db, InjectDb } from '../../common/prisma';
import { createEmailProvider } from '../notifications/email.provider';
import { NotificationsService } from '../notifications/notifications.service';
import { createSmsProvider } from '../notifications/sms.provider';

/** Modèle des notifications d'alerte : exclu du décompte des notifications abandonnées. */
export const ALERT_TEMPLATE = 'ops.alert';

/** Seuils des situations surveillées. */
export const ALERT_RULES = {
  /** Paiement Mobile Money en attente au-delà de ce délai. */
  pendingPaymentMinutes: 120,
  /** Échecs Mobile Money sur une heure glissante au-delà desquels l'équipe est prévenue. */
  mobileMoneyFailuresPerHour: 5,
  /** Sondes de santé consécutives en échec avant l'alerte (une sonde par minute). */
  healthFailures: 3,
} as const;

const MOBILE_METHODS = ['MTN_MOMO', 'ORANGE_MONEY'] as const;

export interface BackupStatus {
  status: 'ok' | 'failed';
  /** Date de la dernière tentative. */
  at: string;
  /** Date de la dernière sauvegarde réussie. */
  lastSuccess?: string;
  message?: string;
}

interface Alert {
  key: string;
  title: string;
  message: string;
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Alertes à l'équipe technique (SMS et e-mail), vérifiées chaque minute par le worker.
 * Anti-répétition : une même alerte n'est renvoyée qu'après `ALERT_COOLDOWN_MINUTES` ;
 * les compteurs (conflits, notifications abandonnées) cumulent ce qui survient entre-temps.
 * Les envois passent par la table d'envoi, dans la même transaction que l'état de l'alerte ;
 * si la base est injoignable (cas de l'API en panne), ils partent directement aux fournisseurs.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger('Alertes');
  /** Sonde de santé de l'API, indépendante de la base. */
  private readonly health = { failures: 0, active: false, lastSentAt: null as Date | null };
  /** Anti-répétition des envois directs (base indisponible). */
  private readonly directSentAt = new Map<string, Date>();

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  /** Lance toutes les vérifications ; renvoie les clés des alertes émises. */
  async runChecks(now = new Date()): Promise<string[]> {
    const checks: [string, () => Promise<Alert | null>][] = [
      ['mobile_money_conflict', () => this.checkMobileMoneyConflicts(now)],
      ['mobile_money_failures', () => this.checkMobileMoneyFailures(now)],
      ['notifications_failed', () => this.checkAbandonedNotifications(now)],
      ['payments_pending', () => this.checkPendingPayments(now)],
      ['backup', () => this.checkBackup(now)],
      ['api_health', () => this.checkApiHealth(now)],
    ];
    const sent: string[] = [];
    // Erreurs regroupées par message : une base arrêtée ne produit qu'une ligne par passage.
    const failures = new Map<string, string[]>();
    for (const [key, check] of checks) {
      try {
        const alert = await check();
        if (alert) sent.push(alert.key);
      } catch (e) {
        const message = e instanceof Error ? e.message.trim() : String(e);
        failures.set(message, [...(failures.get(message) ?? []), key]);
      }
    }
    for (const [message, keys] of failures) {
      this.logger.error(`Vérification impossible (${keys.join(', ')}) : ${message}`);
    }
    return sent;
  }

  /** Entrées d'audit `finance.mobile_money_conflict` apparues depuis la dernière alerte. */
  async checkMobileMoneyConflicts(now: Date): Promise<Alert | null> {
    const count = await this.db.auditLog.count({
      where: { action: 'finance.mobile_money_conflict' },
    });
    return this.counter('mobile_money_conflict', count, now, (n) => ({
      title: 'Conflit Mobile Money',
      message: `${n} conflit(s) Mobile Money à vérifier (succès annoncé après un échec). Voir le journal d'audit.`,
    }));
  }

  /** Échecs Mobile Money anormalement nombreux sur l'heure écoulée. */
  async checkMobileMoneyFailures(now: Date): Promise<Alert | null> {
    const count = await this.db.payment.count({
      where: {
        status: 'FAILED',
        method: { in: [...MOBILE_METHODS] },
        createdAt: { gte: new Date(now.getTime() - 60 * 60_000) },
      },
    });
    return this.condition(
      'mobile_money_failures',
      count >= ALERT_RULES.mobileMoneyFailuresPerHour,
      now,
      {
        title: 'Échecs Mobile Money',
        message: `${count} paiements Mobile Money en échec depuis une heure : vérifier l'opérateur.`,
      },
    );
  }

  /** Notifications abandonnées après toutes les tentatives (hors alertes elles-mêmes). */
  async checkAbandonedNotifications(now: Date): Promise<Alert | null> {
    const count = await this.db.notificationOutbox.count({
      where: { status: 'FAILED', template: { not: ALERT_TEMPLATE } },
    });
    return this.counter('notifications_failed', count, now, (n) => ({
      title: 'Notifications abandonnées',
      message: `${n} notification(s) abandonnée(s) après plusieurs tentatives : vérifier la passerelle SMS.`,
    }));
  }

  /** Paiements en attente depuis plus de 2 h. */
  async checkPendingPayments(now: Date): Promise<Alert | null> {
    const count = await this.db.payment.count({
      where: {
        status: 'PENDING',
        createdAt: { lt: new Date(now.getTime() - ALERT_RULES.pendingPaymentMinutes * 60_000) },
      },
    });
    return this.condition('payments_pending', count > 0, now, {
      title: 'Paiements en attente',
      message: `${count} paiement(s) en attente depuis plus de 2 h : vérifier la réconciliation Mobile Money.`,
    });
  }

  /** Sauvegarde : état écrit par `deploy/backup.sh` (échec, ou dernière réussite trop ancienne). */
  async checkBackup(now: Date): Promise<Alert | null> {
    const { BACKUP_STATUS_FILE, BACKUP_MAX_AGE_HOURS } = env();
    if (!BACKUP_STATUS_FILE) return null;
    let problem: string | null = null;
    let status: BackupStatus | null = null;
    try {
      status = JSON.parse(await readFile(BACKUP_STATUS_FILE, 'utf8')) as BackupStatus;
    } catch {
      problem = 'aucun état de sauvegarde lisible (la sauvegarde planifiée tourne-t-elle ?)';
    }
    if (status) {
      const last = status.lastSuccess || (status.status === 'ok' ? status.at : undefined);
      const ageHours = last ? (now.getTime() - new Date(last).getTime()) / 3_600_000 : Infinity;
      if (status.status !== 'ok') {
        problem = `la sauvegarde du ${status.at} a échoué${status.message ? ` (${status.message})` : ''}`;
      } else if (ageHours > BACKUP_MAX_AGE_HOURS) {
        problem = `dernière sauvegarde réussie il y a ${Math.floor(ageHours)} h`;
      }
    }
    return this.condition(
      'backup',
      problem !== null,
      now,
      { title: 'Sauvegarde ratée', message: `Sauvegarde : ${problem ?? ''}.` },
      { title: 'Sauvegarde rétablie', message: 'Sauvegarde : une sauvegarde a de nouveau réussi.' },
    );
  }

  /**
   * API injoignable : trois sondes consécutives en échec. L'état est gardé en mémoire (le
   * worker est un processus unique) : la sonde fonctionne même quand la base est arrêtée.
   */
  async checkApiHealth(now: Date): Promise<Alert | null> {
    const url = env().ALERT_HEALTH_URL;
    if (!url) return null;
    let error: string | null = null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const health = this.health;
    if (!error) {
      const wasActive = health.active;
      health.failures = 0;
      health.active = false;
      if (!wasActive) return null;
      return this.send(
        { key: 'api_health', title: 'API rétablie', message: "L'API répond de nouveau." },
        now,
        { active: false },
      );
    }
    health.failures++;
    this.logger.warn(`Sonde de santé en échec (${health.failures}) : ${error}`);
    if (health.failures < ALERT_RULES.healthFailures) return null;
    if (health.active && health.lastSentAt && !this.cooledDown(health, now)) return null;
    health.active = true;
    health.lastSentAt = now;
    return this.send(
      {
        key: 'api_health',
        title: 'API injoignable',
        message: `API injoignable depuis ${health.failures} min (${error}).`,
      },
      now,
      { active: true },
    );
  }

  /** Compteur croissant : alerte sur l'écart depuis la dernière alerte. */
  private async counter(
    key: string,
    count: number,
    now: Date,
    describe: (n: number) => Omit<Alert, 'key'>,
  ): Promise<Alert | null> {
    const state = await this.db.opsAlertState.findUnique({ where: { key } });
    // Premier passage, ou compteur remis à zéro : nouvelle référence, sans alerte.
    if (!state || state.baseline === null || count < state.baseline) {
      await this.db.opsAlertState.upsert({
        where: { key },
        create: { key, baseline: count },
        update: { baseline: count },
      });
      return null;
    }
    if (count === state.baseline || !this.cooledDown(state, now)) return null;
    return this.send({ key, ...describe(count - state.baseline) }, now, { baseline: count });
  }

  /** Situation durable : alerte à l'apparition puis après chaque délai, message de retour à la normale. */
  private async condition(
    key: string,
    active: boolean,
    now: Date,
    alert: Omit<Alert, 'key'>,
    recovered?: Omit<Alert, 'key'>,
  ): Promise<Alert | null> {
    const state = await this.db.opsAlertState.findUnique({ where: { key } });
    if (!active) {
      if (!state?.active) return null;
      if (recovered && state.lastSentAt)
        return this.send({ key, ...recovered }, now, { active: false });
      await this.db.opsAlertState.update({ where: { key }, data: { active: false } });
      return null;
    }
    if (state?.active && !this.cooledDown(state, now)) return null;
    return this.send({ key, ...alert }, now, { active: true });
  }

  private cooledDown(state: Pick<OpsAlertState, 'lastSentAt'>, now: Date): boolean {
    if (!state.lastSentAt) return true;
    return now.getTime() - state.lastSentAt.getTime() >= env().ALERT_COOLDOWN_MINUTES * 60_000;
  }

  private async send(
    alert: Alert,
    now: Date,
    data: Pick<Prisma.OpsAlertStateUncheckedCreateInput, 'baseline' | 'active'>,
  ): Promise<Alert> {
    const { ALERT_SMS_TO, ALERT_EMAIL_TO } = env();
    const text = `[Ecole] ${alert.message}`;
    try {
      await this.enqueue(alert, now, data, text);
    } catch (e) {
      // Base injoignable : envoi direct aux fournisseurs, une fois par délai d'anti-répétition.
      this.logger.error(
        `Table d'envoi indisponible (${e instanceof Error ? e.message : String(e)}) : envoi direct`,
      );
      const last = this.directSentAt.get(alert.key);
      if (!last || this.cooledDown({ lastSentAt: last }, now) || data.active === false) {
        this.directSentAt.set(alert.key, now);
        await this.sendDirect(alert, text, list(ALERT_SMS_TO), list(ALERT_EMAIL_TO));
      }
    }
    this.logger.error(`ALERTE ${alert.key} : ${alert.message}`);
    return alert;
  }

  private async sendDirect(alert: Alert, text: string, phones: string[], emails: string[]) {
    const sms = createSmsProvider();
    const email = createEmailProvider();
    const attempts = [
      ...phones.map((to) => () => sms.send(to, text.slice(0, 300))),
      ...emails.map((to) => () => email.send({ to, subject: `[Ecole] ${alert.title}`, text })),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
      } catch (e) {
        this.logger.error(
          `Envoi direct de l'alerte impossible : ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  /** Écriture de l'état et des notifications dans une même transaction (table d'envoi). */
  private async enqueue(
    alert: Alert,
    now: Date,
    data: Pick<Prisma.OpsAlertStateUncheckedCreateInput, 'baseline' | 'active'>,
    text: string,
  ): Promise<void> {
    const { ALERT_SMS_TO, ALERT_EMAIL_TO } = env();
    await this.db.$transaction(async (tx) => {
      await tx.opsAlertState.upsert({
        where: { key: alert.key },
        create: { key: alert.key, lastSentAt: now, ...data },
        update: { lastSentAt: now, ...data },
      });
      const payload = { alert: alert.key, subject: `[Ecole] ${alert.title}` };
      for (const recipient of list(ALERT_SMS_TO)) {
        await this.notifications.enqueue(
          {
            channel: 'SMS',
            recipient,
            template: ALERT_TEMPLATE,
            body: text.slice(0, 300),
            payload,
          },
          tx,
        );
      }
      for (const recipient of list(ALERT_EMAIL_TO)) {
        await this.notifications.enqueue(
          { channel: 'EMAIL', recipient, template: ALERT_TEMPLATE, body: text, payload },
          tx,
        );
      }
    });
  }
}
