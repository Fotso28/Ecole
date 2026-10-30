/**
 * Examens : calendrier des épreuves, détection des conflits, répartition des candidats dans les
 * salles, affectation équilibrée des surveillants, numéros d'anonymat et résultats.
 * Dates au format AAAA-MM-JJ, heures au format HH:MM, notes en centièmes.
 */
import { z } from 'zod';
import {
  appreciation,
  DEFAULT_MAX_SCORE,
  formatRank,
  generalAverage,
  normalizeTo20,
  rankWithTies,
  type ParsedGrade,
  type RankResult,
} from './grades';
import { isoDate, timeOfDay } from './schemas';
import { toMinutes } from './timetable';

export const EXAM_KINDS = ['MOCK', 'SEQUENCE', 'PROMOTION'] as const;
export type ExamKind = (typeof EXAM_KINDS)[number];
export const EXAM_KIND_LABELS: Record<ExamKind, string> = {
  MOCK: 'Examen blanc',
  SEQUENCE: 'Composition de séquence',
  PROMOTION: 'Examen de passage',
};

// ---------------------------------------------------------------------------
// Créneaux et conflits
// ---------------------------------------------------------------------------

export interface ExamSlot {
  date: string;
  startTime: string;
  durationMinutes: number;
}

const DAY_MS = 86_400_000;

/** Intervalle [début, fin[ en minutes depuis le 1er janvier 1970. */
export function slotRange(s: ExamSlot): { start: number; end: number } {
  const day = Date.parse(`${s.date}T00:00:00Z`);
  if (Number.isNaN(day)) throw new RangeError(`Date invalide : ${s.date}`);
  if (!Number.isInteger(s.durationMinutes) || s.durationMinutes <= 0)
    throw new RangeError('La durée doit être un nombre entier de minutes strictement positif');
  const start = (day / DAY_MS) * 1440 + toMinutes(s.startTime);
  return { start, end: start + s.durationMinutes };
}

export function slotsOverlap(a: ExamSlot, b: ExamSlot): boolean {
  const ra = slotRange(a);
  const rb = slotRange(b);
  return ra.start < rb.end && rb.start < ra.end;
}

/** Heure de fin d'une épreuve (« 10:00 » + 150 min → « 12:30 »). */
export function slotEndTime(s: Pick<ExamSlot, 'startTime' | 'durationMinutes'>): string {
  const end = toMinutes(s.startTime) + s.durationMinutes;
  const m = end % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export interface ExamPaperSlot extends ExamSlot {
  id: string;
  sessionId: string;
  classIds: readonly string[];
  /** Salles occupées par l'épreuve. */
  roomIds: readonly string[];
}

export interface ExamSupervisionSlot {
  id: string;
  paperId: string;
  roomId: string;
  userId: string;
}

export type ExamConflictKind = 'class' | 'room' | 'supervisor';

export interface ExamConflict {
  kind: ExamConflictKind;
  /** Épreuves (classe, salle) ou surveillances (surveillant) en conflit. */
  ids: [string, string];
  /** Classe, salle ou surveillant concerné. */
  targetId: string;
}

/**
 * Conflits du calendrier :
 * - une classe qui compose deux épreuves en même temps ;
 * - une salle occupée au même moment par deux sessions différentes (dans une même session, une
 *   salle accueille sans conflit des candidats de classes différentes) ;
 * - un surveillant affecté au même moment à deux salles différentes.
 */
export function findExamConflicts(
  papers: readonly ExamPaperSlot[],
  supervisions: readonly ExamSupervisionSlot[] = [],
): ExamConflict[] {
  const conflicts: ExamConflict[] = [];
  for (let i = 0; i < papers.length; i++) {
    for (let j = i + 1; j < papers.length; j++) {
      const a = papers[i]!;
      const b = papers[j]!;
      if (!slotsOverlap(a, b)) continue;
      for (const classId of a.classIds) {
        if (b.classIds.includes(classId))
          conflicts.push({ kind: 'class', ids: [a.id, b.id], targetId: classId });
      }
      if (a.sessionId !== b.sessionId) {
        for (const roomId of a.roomIds) {
          if (b.roomIds.includes(roomId))
            conflicts.push({ kind: 'room', ids: [a.id, b.id], targetId: roomId });
        }
      }
    }
  }
  const paperById = new Map(papers.map((p) => [p.id, p]));
  for (let i = 0; i < supervisions.length; i++) {
    for (let j = i + 1; j < supervisions.length; j++) {
      const a = supervisions[i]!;
      const b = supervisions[j]!;
      if (a.userId !== b.userId) continue;
      const pa = paperById.get(a.paperId);
      const pb = paperById.get(b.paperId);
      if (!pa || !pb) continue;
      const sameRoom = a.roomId === b.roomId && pa.sessionId === pb.sessionId;
      if (sameRoom || !slotsOverlap(pa, pb)) continue;
      conflicts.push({ kind: 'supervisor', ids: [a.id, b.id], targetId: a.userId });
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Répartition des candidats dans les salles
// ---------------------------------------------------------------------------

export interface SeatCandidate {
  id: string;
  classId: string;
  lastName: string;
  firstName: string;
}

export interface SeatRoom {
  id: string;
  capacity: number;
}

export interface SeatAssignment {
  candidateId: string;
  roomId: string;
  /** Numéro de place dans la salle, à partir de 1. */
  seat: number;
}

export class SeatingCapacityError extends RangeError {
  constructor(
    readonly candidates: number,
    readonly capacity: number,
  ) {
    super(`Capacité insuffisante : ${capacity} places pour ${candidates} candidats`);
  }
}

const byName = (a: SeatCandidate, b: SeatCandidate) =>
  a.lastName.localeCompare(b.lastName, 'fr') ||
  a.firstName.localeCompare(b.firstName, 'fr') ||
  a.id.localeCompare(b.id);

/**
 * Répartit les candidats dans les salles, dans l'ordre des salles, sans dépasser leur capacité.
 * - Sans mélange : classe après classe, élèves par ordre alphabétique.
 * - Avec mélange : les classes alternent (un élève de chaque classe à tour de rôle), de sorte que
 *   deux places voisines accueillent autant que possible des élèves de classes différentes.
 * Les salles sont remplies de façon équilibrée : chacune reçoit une part proportionnelle à sa
 * capacité plutôt que d'être remplie à ras bord pendant que la dernière reste presque vide.
 */
export function assignSeats(
  candidates: readonly SeatCandidate[],
  rooms: readonly SeatRoom[],
  options: { mixClasses: boolean },
): SeatAssignment[] {
  for (const r of rooms) {
    if (!Number.isInteger(r.capacity) || r.capacity < 0)
      throw new RangeError('La capacité d’une salle doit être un entier positif ou nul');
  }
  const capacity = rooms.reduce((s, r) => s + r.capacity, 0);
  if (candidates.length > capacity) throw new SeatingCapacityError(candidates.length, capacity);

  const classes = new Map<string, SeatCandidate[]>();
  for (const c of candidates) {
    const list = classes.get(c.classId) ?? [];
    list.push(c);
    classes.set(c.classId, list);
  }
  const classOrder = [...classes.keys()].sort();
  for (const list of classes.values()) list.sort(byName);

  const ordered: SeatCandidate[] = [];
  if (options.mixClasses) {
    // Tour de rôle pondéré : la classe la plus « en retard » sur sa proportion passe en premier.
    const taken = new Map(classOrder.map((k) => [k, 0]));
    for (let n = 0; n < candidates.length; n++) {
      let best: string | undefined;
      let bestScore = Infinity;
      for (const k of classOrder) {
        const list = classes.get(k)!;
        const t = taken.get(k)!;
        if (t >= list.length) continue;
        // Avancement de la classe si on prend son prochain élève : le plus petit passe d'abord.
        const score = (t + 1) / list.length;
        if (score < bestScore) {
          bestScore = score;
          best = k;
        }
      }
      const list = classes.get(best!)!;
      const t = taken.get(best!)!;
      ordered.push(list[t]!);
      taken.set(best!, t + 1);
    }
  } else {
    for (const k of classOrder) ordered.push(...classes.get(k)!);
  }

  // Parts proportionnelles aux capacités (méthode du plus fort reste), bornées par la capacité.
  const quotas = rooms.map((r) =>
    capacity === 0 ? 0 : Math.floor((r.capacity * ordered.length) / capacity),
  );
  let remaining = ordered.length - quotas.reduce((s, q) => s + q, 0);
  const remainders = rooms
    .map((r, i) => ({ i, rest: capacity === 0 ? 0 : (r.capacity * ordered.length) % capacity }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of remainders) {
    if (remaining === 0) break;
    if (quotas[i]! < rooms[i]!.capacity) {
      quotas[i]!++;
      remaining--;
    }
  }

  const result: SeatAssignment[] = [];
  let cursor = 0;
  rooms.forEach((room, i) => {
    for (let seat = 1; seat <= quotas[i]!; seat++) {
      result.push({ candidateId: ordered[cursor]!.id, roomId: room.id, seat });
      cursor++;
    }
  });
  return result;
}

/** Vérifie une répartition : aucune place en double, capacité respectée. Renvoie les erreurs. */
export function validateSeating(
  assignments: readonly SeatAssignment[],
  rooms: readonly SeatRoom[],
): string[] {
  const errors: string[] = [];
  const cap = new Map(rooms.map((r) => [r.id, r.capacity]));
  const seen = new Set<string>();
  for (const a of assignments) {
    const c = cap.get(a.roomId);
    if (c === undefined) errors.push(`Salle inconnue pour le candidat ${a.candidateId}`);
    else if (a.seat < 1 || a.seat > c)
      errors.push(`Place ${a.seat} hors de la capacité de la salle`);
    const key = `${a.roomId}:${a.seat}`;
    if (seen.has(key)) errors.push(`Place ${a.seat} attribuée deux fois`);
    seen.add(key);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Surveillants
// ---------------------------------------------------------------------------

export interface SupervisionNeed extends ExamSlot {
  /** Identifiant du besoin (épreuve × salle). */
  key: string;
  roomId: string;
  sessionId: string;
  /** Nombre de surveillants voulus dans la salle. */
  needed: number;
  /** Surveillants déjà affectés à ce besoin. */
  assigned?: readonly string[];
  /** Enseignants de la matière : évités tant que d'autres sont disponibles. */
  avoid?: readonly string[];
}

export interface ExistingSupervision extends ExamSlot {
  userId: string;
  roomId: string;
  sessionId: string;
}

export interface SupervisorAssignment {
  key: string;
  userId: string;
}

/**
 * Affecte les surveillants en équilibrant la charge (en minutes) : à chaque besoin, pris dans
 * l'ordre chronologique, on choisit les enseignants disponibles les moins chargés. Un enseignant
 * déjà occupé au même moment dans une autre salle n'est jamais retenu ; l'enseignant de la matière
 * n'est retenu qu'à défaut d'un autre. Égalités départagées par identifiant (résultat stable).
 */
export function assignSupervisors(
  needs: readonly SupervisionNeed[],
  pool: readonly string[],
  existing: readonly ExistingSupervision[] = [],
): { assignments: SupervisorAssignment[]; unfilled: { key: string; missing: number }[] } {
  const load = new Map<string, number>(pool.map((u) => [u, 0]));
  const busy: ExistingSupervision[] = [];
  for (const e of existing) {
    load.set(e.userId, (load.get(e.userId) ?? 0) + e.durationMinutes);
    busy.push(e);
  }
  for (const n of needs) {
    for (const u of n.assigned ?? []) {
      load.set(u, (load.get(u) ?? 0) + n.durationMinutes);
      busy.push({ ...n, userId: u });
    }
  }
  const sorted = [...needs].sort(
    (a, b) => slotRange(a).start - slotRange(b).start || a.key.localeCompare(b.key),
  );
  const assignments: SupervisorAssignment[] = [];
  const unfilled: { key: string; missing: number }[] = [];
  for (const need of sorted) {
    const already = new Set(need.assigned ?? []);
    let missing = need.needed - already.size;
    const isBusy = (u: string) =>
      busy.some(
        (b) =>
          b.userId === u &&
          !(b.roomId === need.roomId && b.sessionId === need.sessionId) &&
          slotsOverlap(b, need),
      );
    const candidates = pool
      .filter((u) => !already.has(u) && !isBusy(u))
      .sort((a, b) => {
        const avoidA = need.avoid?.includes(a) ? 1 : 0;
        const avoidB = need.avoid?.includes(b) ? 1 : 0;
        return avoidA - avoidB || (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b);
      });
    for (const u of candidates) {
      if (missing <= 0) break;
      assignments.push({ key: need.key, userId: u });
      load.set(u, (load.get(u) ?? 0) + need.durationMinutes);
      busy.push({ ...need, userId: u });
      missing--;
    }
    if (missing > 0) unfilled.push({ key: need.key, missing });
  }
  return { assignments, unfilled };
}

/** Charge de surveillance (minutes) par surveillant. */
export function supervisionLoad(
  rows: readonly { userId: string; durationMinutes: number }[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.userId, (m.get(r.userId) ?? 0) + r.durationMinutes);
  return m;
}

// ---------------------------------------------------------------------------
// Numéros d'anonymat
// ---------------------------------------------------------------------------

/**
 * Alphabet sans caractères ambigus (ni 0/O, ni 1/I/L, ni U). Sa taille doit rester paire pour
 * que la clé de contrôle détecte toutes les fautes de frappe.
 */
export const ANONYMITY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Caractères aléatoires d'un numéro (30⁶ ≈ 729 millions de combinaisons), plus une clé de contrôle. */
export const ANONYMITY_RANDOM_LENGTH = 6;

/**
 * Clé de contrôle (Luhn mod N) : détecte toute faute de frappe sur un caractère et toute
 * inversion de deux caractères voisins lors de la saisie des notes.
 */
export function anonymityCheckChar(body: string): string {
  const n = ANONYMITY_ALPHABET.length;
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const code = ANONYMITY_ALPHABET.indexOf(body[i]!);
    if (code < 0) throw new RangeError(`Caractère interdit : ${body[i]}`);
    let addend = factor * code;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }
  return ANONYMITY_ALPHABET[(n - (sum % n)) % n]!;
}

/** Normalise une saisie : majuscules, sans espaces ni tirets. */
export function normalizeAnonymityCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

export function isValidAnonymityCode(raw: string): boolean {
  const code = normalizeAnonymityCode(raw);
  if (code.length !== ANONYMITY_RANDOM_LENGTH + 1) return false;
  if (![...code].every((c) => ANONYMITY_ALPHABET.includes(c))) return false;
  return anonymityCheckChar(code.slice(0, -1)) === code.slice(-1);
}

/** Affichage groupé : « K7M4QX9 » → « K7M-4QX9 ». */
export function formatAnonymityCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/**
 * Génère `count` numéros d'anonymat distincts, absents de `taken`. `randomInt(n)` doit renvoyer
 * un entier aléatoire dans [0, n[ tiré d'une source cryptographique (crypto.randomInt côté API) :
 * les numéros ne dépendent ni de l'élève, ni de l'ordre alphabétique, ni de la place.
 */
export function generateAnonymityCodes(
  count: number,
  randomInt: (max: number) => number,
  taken: Iterable<string> = [],
): string[] {
  const used = new Set(taken);
  const result: string[] = [];
  let attempts = 0;
  while (result.length < count) {
    if (++attempts > count * 100 + 1000)
      throw new Error('Impossible de générer des numéros d’anonymat uniques');
    let body = '';
    for (let i = 0; i < ANONYMITY_RANDOM_LENGTH; i++) {
      body += ANONYMITY_ALPHABET[randomInt(ANONYMITY_ALPHABET.length)];
    }
    const code = body + anonymityCheckChar(body);
    if (used.has(code)) continue;
    used.add(code);
    result.push(code);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Résultats
// ---------------------------------------------------------------------------

export interface ExamResultPaper {
  id: string;
  subjectId: string;
  maxScore: number;
  classIds: readonly string[];
}

export interface ExamResultCandidate {
  id: string;
  classId: string;
}

export interface ExamPaperResult {
  paperId: string;
  /** Note sur 20 en centièmes ; `null` si absent, dispensé ou non noté. */
  on20Centi: number | null;
  grade: ParsedGrade;
}

export interface ExamCandidateResult {
  candidateId: string;
  papers: ExamPaperResult[];
  averageCenti: number | null;
  /** Vrai si au moins une note manque encore. */
  incomplete: boolean;
  rank: { rank: number; tied: boolean; ranked: number; label: string } | null;
  appreciation: string | null;
}

/**
 * Moyenne de chaque candidat : Σ(note sur 20 × coefficient) ÷ Σ coefficients, sur les épreuves
 * de sa classe (coefficient de la matière dans la classe, 1 par défaut). Les absences et dispenses
 * sont exclues ; une note manquante rend la moyenne incomplète. Rang avec ex aequo dans la classe.
 */
export function examResults(
  candidates: readonly ExamResultCandidate[],
  papers: readonly ExamResultPaper[],
  grades: ReadonlyMap<string, ParsedGrade>,
  coefficient: (classId: string, subjectId: string) => number | undefined = () => undefined,
): ExamCandidateResult[] {
  const rows = candidates.map((c) => {
    const own = papers.filter((p) => p.classIds.includes(c.classId));
    let incomplete = false;
    const lines = own.map((p) => {
      const grade = grades.get(`${p.id}:${c.id}`) ?? { kind: 'empty' as const };
      if (grade.kind === 'empty' || grade.kind === 'invalid') incomplete = true;
      const on20Centi =
        grade.kind === 'score' ? normalizeTo20(grade.centi, p.maxScore || DEFAULT_MAX_SCORE) : null;
      return {
        paper: p,
        result: { paperId: p.id, on20Centi, grade } satisfies ExamPaperResult,
      };
    });
    const avg = incomplete
      ? null
      : generalAverage(
          lines.map((l) => ({
            coefficient: coefficient(c.classId, l.paper.subjectId) ?? 1,
            averageCenti: l.result.on20Centi,
          })),
        ).averageCenti;
    return { candidate: c, papers: lines.map((l) => l.result), averageCenti: avg, incomplete };
  });
  const byClass = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byClass.get(r.candidate.classId) ?? [];
    list.push(r);
    byClass.set(r.candidate.classId, list);
  }
  const ranks = new Map<string, RankResult>();
  for (const list of byClass.values()) {
    for (const [id, r] of rankWithTies(
      list.map((x) => ({ id: x.candidate.id, valueCenti: x.averageCenti })),
    ))
      ranks.set(id, r);
  }
  return rows.map((r) => {
    const rank = ranks.get(r.candidate.id);
    return {
      candidateId: r.candidate.id,
      papers: r.papers,
      averageCenti: r.averageCenti,
      incomplete: r.incomplete,
      rank: rank ? { ...rank, label: formatRank(rank) } : null,
      appreciation: r.averageCenti === null ? null : appreciation(r.averageCenti),
    };
  });
}

// ---------------------------------------------------------------------------
// Schémas de saisie
// ---------------------------------------------------------------------------

const label = z.string().trim().min(1).max(80);

export const examSessionCreateSchema = z
  .object({
    name: label,
    kind: z.enum(EXAM_KINDS),
    sequenceId: z.string().min(1).optional(),
    startDate: isoDate,
    endDate: isoDate,
    classIds: z.array(z.string().min(1)).min(1),
    mixClasses: z.boolean().default(true),
    supervisorsPerRoom: z.number().int().min(1).max(4).default(1),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'La date de fin doit suivre la date de début',
    path: ['endDate'],
  })
  .refine((v) => v.kind !== 'SEQUENCE' || !!v.sequenceId, {
    message: 'Choisissez la séquence de la composition',
    path: ['sequenceId'],
  });

export const examPaperCreateSchema = z.object({
  subjectId: z.string().min(1),
  date: isoDate,
  startTime: timeOfDay,
  durationMinutes: z.number().int().min(15).max(600),
  maxScore: z.number().int().min(1).max(100).default(20),
  /** Classes qui composent ; par défaut, celles de la session où la matière est enseignée. */
  classIds: z.array(z.string().min(1)).min(1).optional(),
});

export const examRoomAddSchema = z.object({
  roomId: z.string().min(1),
  capacity: z.number().int().min(1).max(500).optional(),
});

export const examSeatMoveSchema = z.object({
  roomId: z.string().min(1),
  seat: z.number().int().min(1),
});

export const examSupervisionSchema = z.object({
  paperId: z.string().min(1),
  roomId: z.string().min(1),
  userId: z.string().min(1),
});

export const examScoresSchema = z.object({
  scores: z
    .array(z.object({ code: z.string().trim().min(1).max(12), value: z.string().max(10) }))
    .min(1),
});

export const examRevealSchema = z.object({ reason: z.string().trim().min(5).max(300) });

export const examTransferSchema = z.object({
  /** Poids de l'évaluation créée dans la grille de la séquence. */
  weight: z.number().int().min(1).max(10).default(1),
});

export const examPublishSchema = examTransferSchema.extend({
  /** Reporter les notes dans les évaluations de la séquence de la session. */
  transferToSequence: z.boolean().default(false),
});
