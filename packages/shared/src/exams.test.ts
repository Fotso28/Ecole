import { describe, expect, it } from 'vitest';
import {
  ANONYMITY_ALPHABET,
  anonymityCheckChar,
  assignSeats,
  assignSupervisors,
  examPaperCreateSchema,
  examResults,
  examSessionCreateSchema,
  findExamConflicts,
  formatAnonymityCode,
  generateAnonymityCodes,
  isValidAnonymityCode,
  normalizeAnonymityCode,
  SeatingCapacityError,
  slotEndTime,
  slotsOverlap,
  supervisionLoad,
  validateSeating,
  type ExamPaperSlot,
  type SeatCandidate,
} from './exams';
import type { ParsedGrade } from './grades';

const paper = (id: string, over: Partial<ExamPaperSlot> = {}): ExamPaperSlot => ({
  id,
  sessionId: 's1',
  date: '2026-11-16',
  startTime: '08:00',
  durationMinutes: 120,
  classIds: ['4A'],
  roomIds: ['B12'],
  ...over,
});

describe('créneaux', () => {
  it('détecte le chevauchement à la minute près', () => {
    const a = { date: '2026-11-16', startTime: '08:00', durationMinutes: 120 };
    expect(slotsOverlap(a, { ...a, startTime: '09:59' })).toBe(true);
    expect(slotsOverlap(a, { ...a, startTime: '10:00' })).toBe(false);
    expect(slotsOverlap(a, { ...a, startTime: '07:00', durationMinutes: 60 })).toBe(false);
    expect(slotsOverlap(a, { ...a, startTime: '07:00', durationMinutes: 61 })).toBe(true);
    expect(slotsOverlap(a, { ...a, date: '2026-11-17' })).toBe(false);
  });

  it('calcule l’heure de fin', () => {
    expect(slotEndTime({ startTime: '10:00', durationMinutes: 150 })).toBe('12:30');
    expect(slotEndTime({ startTime: '07:45', durationMinutes: 15 })).toBe('08:00');
  });

  it('refuse une durée nulle ou une date invalide', () => {
    const a = { date: '2026-11-16', startTime: '08:00', durationMinutes: 0 };
    expect(() => slotsOverlap(a, a)).toThrow(RangeError);
    expect(() =>
      slotsOverlap({ ...a, durationMinutes: 60, date: 'demain' }, { ...a, durationMinutes: 60 }),
    ).toThrow(RangeError);
  });
});

describe('conflits du calendrier', () => {
  it('signale une classe qui compose deux épreuves en même temps', () => {
    const conflicts = findExamConflicts([
      paper('maths'),
      paper('francais', { startTime: '09:00', classIds: ['4A', '4B'], roomIds: [] }),
      paper('anglais', { startTime: '11:00' }),
    ]);
    expect(conflicts).toEqual([{ kind: 'class', ids: ['maths', 'francais'], targetId: '4A' }]);
  });

  it('accepte des classes différentes dans la même salle pour une même session', () => {
    expect(findExamConflicts([paper('maths4'), paper('francais6', { classIds: ['6A'] })])).toEqual(
      [],
    );
  });

  it('signale une salle occupée par deux sessions au même moment', () => {
    const conflicts = findExamConflicts([
      paper('a'),
      paper('b', { sessionId: 's2', classIds: ['6A'], startTime: '09:30' }),
    ]);
    expect(conflicts).toEqual([{ kind: 'room', ids: ['a', 'b'], targetId: 'B12' }]);
  });

  it('signale un surveillant dans deux salles au même moment, pas dans la même salle', () => {
    const papers = [paper('maths'), paper('francais', { classIds: ['6A'] })];
    expect(
      findExamConflicts(papers, [
        { id: 'x', paperId: 'maths', roomId: 'B12', userId: 'paul' },
        { id: 'y', paperId: 'francais', roomId: 'B12', userId: 'paul' },
      ]),
    ).toEqual([]);
    expect(
      findExamConflicts(papers, [
        { id: 'x', paperId: 'maths', roomId: 'B12', userId: 'paul' },
        { id: 'y', paperId: 'francais', roomId: 'B14', userId: 'paul' },
        { id: 'z', paperId: 'francais', roomId: 'B14', userId: 'rose' },
      ]),
    ).toEqual([{ kind: 'supervisor', ids: ['x', 'y'], targetId: 'paul' }]);
  });

  it('ignore un surveillant sur deux épreuves successives', () => {
    const papers = [paper('maths'), paper('francais', { startTime: '10:00' })];
    expect(
      findExamConflicts(papers, [
        { id: 'x', paperId: 'maths', roomId: 'B12', userId: 'paul' },
        { id: 'y', paperId: 'francais', roomId: 'B14', userId: 'paul' },
      ]),
    ).toEqual([]);
  });
});

function students(classId: string, n: number): SeatCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${classId}-${String(i + 1).padStart(2, '0')}`,
    classId,
    lastName: `Nom${String(i + 1).padStart(2, '0')}`,
    firstName: 'P',
  }));
}

describe('répartition dans les salles', () => {
  it('refuse si la capacité totale est insuffisante', () => {
    expect(() =>
      assignSeats(students('4A', 31), [{ id: 'B12', capacity: 30 }], { mixClasses: false }),
    ).toThrow(SeatingCapacityError);
  });

  it('respecte les capacités, sans place en double, et place tout le monde', () => {
    const candidates = [...students('4A', 23), ...students('4B', 17), ...students('6A', 9)];
    const rooms = [
      { id: 'B12', capacity: 20 },
      { id: 'B14', capacity: 20 },
      { id: 'Labo', capacity: 15 },
    ];
    for (const mixClasses of [true, false]) {
      const seats = assignSeats(candidates, rooms, { mixClasses });
      expect(seats).toHaveLength(49);
      expect(new Set(seats.map((s) => s.candidateId)).size).toBe(49);
      expect(validateSeating(seats, rooms)).toEqual([]);
      for (const r of rooms) {
        expect(seats.filter((s) => s.roomId === r.id).length).toBeLessThanOrEqual(r.capacity);
      }
    }
  });

  it('équilibre le remplissage selon les capacités', () => {
    const seats = assignSeats(
      students('4A', 30),
      [
        { id: 'B12', capacity: 40 },
        { id: 'B14', capacity: 20 },
      ],
      { mixClasses: false },
    );
    expect(seats.filter((s) => s.roomId === 'B12')).toHaveLength(20);
    expect(seats.filter((s) => s.roomId === 'B14')).toHaveLength(10);
  });

  it('sans mélange, garde les classes groupées par ordre alphabétique', () => {
    const seats = assignSeats(
      [...students('4B', 3), ...students('4A', 3)],
      [{ id: 'B12', capacity: 10 }],
      { mixClasses: false },
    );
    expect(seats.map((s) => s.candidateId)).toEqual([
      '4A-01',
      '4A-02',
      '4A-03',
      '4B-01',
      '4B-02',
      '4B-03',
    ]);
    expect(seats.map((s) => s.seat)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('avec mélange, deux voisins sont de classes différentes quand c’est possible', () => {
    const seats = assignSeats(
      [...students('4A', 10), ...students('4B', 10)],
      [{ id: 'B12', capacity: 20 }],
      { mixClasses: true },
    );
    const classes = seats.map((s) => s.candidateId.slice(0, 2));
    for (let i = 1; i < classes.length; i++) expect(classes[i]).not.toBe(classes[i - 1]);
  });

  it('avec mélange de classes inégales, répartit chaque classe sur toutes les salles', () => {
    const seats = assignSeats(
      [...students('4A', 30), ...students('6A', 10)],
      [
        { id: 'B12', capacity: 20 },
        { id: 'B14', capacity: 20 },
      ],
      { mixClasses: true },
    );
    for (const room of ['B12', 'B14']) {
      const inRoom = seats.filter((s) => s.roomId === room).map((s) => s.candidateId.slice(0, 2));
      expect(inRoom.filter((c) => c === '6A')).toHaveLength(5);
      expect(inRoom.filter((c) => c === '4A')).toHaveLength(15);
    }
  });

  it('valide une répartition modifiée à la main', () => {
    const rooms = [{ id: 'B12', capacity: 2 }];
    expect(
      validateSeating(
        [
          { candidateId: 'a', roomId: 'B12', seat: 1 },
          { candidateId: 'b', roomId: 'B12', seat: 1 },
          { candidateId: 'c', roomId: 'B12', seat: 3 },
          { candidateId: 'd', roomId: 'X', seat: 1 },
        ],
        rooms,
      ),
    ).toHaveLength(3);
  });
});

describe('affectation des surveillants', () => {
  const need = (key: string, over = {}) => ({
    key,
    roomId: 'B12',
    sessionId: 's1',
    date: '2026-11-16',
    startTime: '08:00',
    durationMinutes: 120,
    needed: 1,
    ...over,
  });

  it('équilibre la charge entre enseignants', () => {
    const needs = [
      need('maths-B12'),
      need('maths-B14', { roomId: 'B14' }),
      need('fr-B12', { startTime: '10:30' }),
      need('fr-B14', { startTime: '10:30', roomId: 'B14' }),
      need('ang-B12', { startTime: '14:00', durationMinutes: 60 }),
      need('ang-B14', { startTime: '14:00', durationMinutes: 60, roomId: 'B14' }),
    ];
    const { assignments, unfilled } = assignSupervisors(needs, ['a', 'b', 'c']);
    expect(unfilled).toEqual([]);
    expect(assignments).toHaveLength(6);
    const load = supervisionLoad(
      assignments.map((a) => ({
        userId: a.userId,
        durationMinutes: needs.find((n) => n.key === a.key)!.durationMinutes,
      })),
    );
    const values = [...load.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(120);
    expect(load.size).toBe(3);
  });

  it('ne place jamais un enseignant dans deux salles au même moment', () => {
    const { assignments, unfilled } = assignSupervisors(
      [need('m-B12', { needed: 2 }), need('m-B14', { roomId: 'B14', needed: 2 })],
      ['a', 'b', 'c'],
    );
    expect(unfilled).toEqual([{ key: 'm-B14', missing: 1 }]);
    const users = assignments.map((a) => a.userId);
    expect(new Set(users).size).toBe(users.length);
  });

  it('tient compte des surveillances existantes (autre session)', () => {
    const { assignments } = assignSupervisors(
      [need('m-B12')],
      ['a', 'b'],
      [
        {
          userId: 'a',
          roomId: 'Labo',
          sessionId: 's2',
          date: '2026-11-16',
          startTime: '09:00',
          durationMinutes: 60,
        },
      ],
    );
    expect(assignments).toEqual([{ key: 'm-B12', userId: 'b' }]);
  });

  it('évite l’enseignant de la matière tant qu’un autre est libre', () => {
    const { assignments } = assignSupervisors([need('m', { avoid: ['a'] })], ['a', 'b']);
    expect(assignments).toEqual([{ key: 'm', userId: 'b' }]);
    const fallback = assignSupervisors([need('m', { avoid: ['a'], needed: 2 })], ['a', 'b']);
    expect(fallback.assignments.map((x) => x.userId).sort()).toEqual(['a', 'b']);
  });

  it('complète un besoin déjà partiellement pourvu', () => {
    const { assignments } = assignSupervisors(
      [need('m', { needed: 2, assigned: ['a'] })],
      ['a', 'b', 'c'],
    );
    expect(assignments).toEqual([{ key: 'm', userId: 'b' }]);
  });
});

describe('numéros d’anonymat', () => {
  const fakeRandom = (seed: number) => {
    let x = seed;
    return (max: number) => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x % max;
    };
  };

  it('génère des numéros uniques et valides', () => {
    const codes = generateAnonymityCodes(2000, fakeRandom(7));
    expect(new Set(codes).size).toBe(2000);
    for (const c of codes) {
      expect(c).toHaveLength(7);
      expect(isValidAnonymityCode(c)).toBe(true);
    }
  });

  it('n’attribue pas un numéro déjà pris', () => {
    const always = () => 0;
    const first = generateAnonymityCodes(1, always);
    expect(() => generateAnonymityCodes(1, always, first)).toThrow();
  });

  it('dépend uniquement du tirage aléatoire (pas de suite prévisible)', () => {
    const a = generateAnonymityCodes(5, fakeRandom(1));
    const b = generateAnonymityCodes(5, fakeRandom(2));
    expect(a).not.toEqual(b);
    // Deux numéros consécutifs ne sont pas « voisins ».
    expect(a[0]!.slice(0, 5)).not.toBe(a[1]!.slice(0, 5));
  });

  it('détecte une faute de frappe ou une inversion de deux caractères', () => {
    const [code] = generateAnonymityCodes(1, fakeRandom(3));
    const chars = [...code!];
    for (let i = 0; i < chars.length; i++) {
      for (const other of ANONYMITY_ALPHABET) {
        if (other === chars[i]) continue;
        const typo = [...chars];
        typo[i] = other;
        expect(isValidAnonymityCode(typo.join(''))).toBe(false);
      }
    }
    for (let i = 0; i < chars.length - 1; i++) {
      if (chars[i] === chars[i + 1]) continue;
      const swapped = [...chars];
      [swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
      expect(isValidAnonymityCode(swapped.join(''))).toBe(false);
    }
  });

  it('normalise et formate la saisie', () => {
    const body = 'K7M4QX';
    const code = body + anonymityCheckChar(body);
    expect(formatAnonymityCode(code)).toBe(`K7M-4QX${code[6]}`);
    expect(normalizeAnonymityCode(` ${formatAnonymityCode(code).toLowerCase()} `)).toBe(code);
    expect(isValidAnonymityCode(formatAnonymityCode(code))).toBe(true);
    expect(isValidAnonymityCode('K7M4QX')).toBe(false);
    expect(isValidAnonymityCode('O7M4QXA')).toBe(false);
  });
});

describe('résultats d’examen', () => {
  const score = (centi: number): ParsedGrade => ({ kind: 'score', centi });
  const papers = [
    { id: 'maths', subjectId: 'MATH', maxScore: 20, classIds: ['4A', '4B'] },
    { id: 'fr', subjectId: 'FR', maxScore: 40, classIds: ['4A'] },
  ];

  it('calcule la moyenne pondérée et le rang par classe', () => {
    const grades = new Map<string, ParsedGrade>([
      ['maths:a', score(1500)],
      ['fr:a', score(2400)], // 12/20
      ['maths:b', score(1200)],
      ['fr:b', score(3000)], // 15/20
      ['maths:c', score(800)],
    ]);
    const coef = (classId: string, subjectId: string) =>
      classId === '4A' ? ({ MATH: 4, FR: 2 } as Record<string, number>)[subjectId] : undefined;
    const results = examResults(
      [
        { id: 'a', classId: '4A' },
        { id: 'b', classId: '4A' },
        { id: 'c', classId: '4B' },
      ],
      papers,
      grades,
      coef,
    );
    const a = results.find((r) => r.candidateId === 'a')!;
    const b = results.find((r) => r.candidateId === 'b')!;
    const c = results.find((r) => r.candidateId === 'c')!;
    expect(a.averageCenti).toBe(1400); // (15×4 + 12×2) ÷ 6
    expect(b.averageCenti).toBe(1300); // (12×4 + 15×2) ÷ 6
    expect(a.rank?.label).toBe('1er');
    expect(b.rank?.label).toBe('2e');
    expect(c.averageCenti).toBe(800);
    expect(c.rank).toEqual({ rank: 1, tied: false, ranked: 1, label: '1er' });
    expect(c.papers.map((p) => p.paperId)).toEqual(['maths']);
    expect(a.appreciation).toBe('Bien');
  });

  it('exclut absences et dispenses, signale une note manquante', () => {
    const results = examResults(
      [
        { id: 'a', classId: '4A' },
        { id: 'b', classId: '4A' },
      ],
      papers,
      new Map<string, ParsedGrade>([
        ['maths:a', score(1500)],
        ['fr:a', { kind: 'absent' }],
        ['maths:b', score(1000)],
      ]),
    );
    expect(results[0]!.averageCenti).toBe(1500);
    expect(results[0]!.papers[1]!.on20Centi).toBeNull();
    expect(results[1]!.incomplete).toBe(true);
    expect(results[1]!.averageCenti).toBeNull();
    expect(results[1]!.rank).toBeNull();
  });

  it('classe les ex aequo au même rang', () => {
    const results = examResults(
      [
        { id: 'a', classId: '4B' },
        { id: 'b', classId: '4B' },
        { id: 'c', classId: '4B' },
      ],
      papers,
      new Map<string, ParsedGrade>([
        ['maths:a', score(1250)],
        ['maths:b', score(1250)],
        ['maths:c', score(900)],
      ]),
    );
    expect(results.map((r) => r.rank?.label)).toEqual(['1er ex', '1er ex', '3e']);
  });
});

describe('schémas de saisie', () => {
  it('exige une séquence pour une composition de séquence', () => {
    const base = {
      name: 'Composition',
      kind: 'SEQUENCE',
      startDate: '2026-11-16',
      endDate: '2026-11-18',
      classIds: ['4A'],
    };
    expect(examSessionCreateSchema.safeParse(base).success).toBe(false);
    expect(examSessionCreateSchema.safeParse({ ...base, sequenceId: 'seq' }).success).toBe(true);
    expect(
      examSessionCreateSchema.safeParse({ ...base, kind: 'MOCK', endDate: '2026-11-15' }).success,
    ).toBe(false);
  });

  it('borne la durée d’une épreuve', () => {
    const base = { subjectId: 'm', date: '2026-11-16', startTime: '08:00' };
    expect(examPaperCreateSchema.safeParse({ ...base, durationMinutes: 120 }).success).toBe(true);
    expect(examPaperCreateSchema.safeParse({ ...base, durationMinutes: 5 }).success).toBe(false);
    expect(
      examPaperCreateSchema.safeParse({ ...base, durationMinutes: 60, startTime: '8h' }).success,
    ).toBe(false);
  });
});
