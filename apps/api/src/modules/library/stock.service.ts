import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  belowThreshold,
  canIssue,
  inventoryGaps,
  signedStockQuantity,
  STOCK_MOVEMENT_LABELS,
  stockAllocationSchema,
  stockBySize,
  stockInventorySchema,
  stockItemSchema,
  stockPurchaseSchema,
  stockSaleSchema,
  stockValuation,
  MAX_AMOUNT_FCFA,
} from '@ecole/shared';
import { Prisma, StockItem } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentActorId, currentSchoolId } from '../../common/context';
import { todayInCameroon } from '../../common/dates';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { FinanceService } from '../finance/finance.service';

type ItemInput = z.infer<typeof stockItemSchema>;
type PurchaseInput = z.infer<typeof stockPurchaseSchema>;
type SaleInput = z.infer<typeof stockSaleSchema>;
type AllocationInput = z.infer<typeof stockAllocationSchema>;
type InventoryInput = z.infer<typeof stockInventorySchema>;

const sizeLabel = (size: string) => (size ? ` (taille ${size})` : '');

/**
 * Stock de fournitures et d'uniformes. Les mouvements sont en ajout seul (déclencheur en base) :
 * une erreur se corrige par un mouvement inverse. Le stock ne devient jamais négatif.
 */
@Injectable()
export class StockService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly finance: FinanceService,
  ) {}

  private sizesOf(item: Pick<StockItem, 'sizes'>): string[] {
    return item.sizes.length > 0 ? item.sizes : [''];
  }

  private assertSize(item: StockItem, size: string) {
    if (!this.sizesOf(item).includes(size))
      throw new BadRequestException(
        item.sizes.length > 0
          ? `Taille inconnue pour « ${item.name} » : ${item.sizes.join(', ')}`
          : `« ${item.name} » n’a pas de taille`,
      );
  }

  /** Articles avec stock par taille, seuil d'alerte et valorisation au coût moyen pondéré. */
  async items() {
    const items = await this.db.stockItem.findMany({
      include: {
        movements: { select: { size: true, type: true, quantity: true, unitCost: true } },
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return items.map((item) => {
      const bySize = stockBySize(item.movements);
      const valuation = stockValuation(item.movements);
      const sizes = this.sizesOf(item).map((size) => {
        const onHand = bySize.get(size) ?? 0;
        return { size, onHand, low: belowThreshold(onHand, item.alertThreshold) };
      });
      return {
        id: item.id,
        name: item.name,
        category: item.category,
        sizes,
        unitPrice: item.unitPrice,
        alertThreshold: item.alertThreshold,
        active: item.active,
        onHand: valuation.onHand,
        averageCost: valuation.averageCost,
        value: valuation.value,
        low: sizes.some((s) => s.low),
      };
    });
  }

  async summary() {
    const items = await this.items();
    return {
      items: items.length,
      value: items.reduce((s, i) => s + i.value, 0),
      lowStock: items.filter((i) => i.low).length,
    };
  }

  async createItem(input: ItemInput) {
    if (await this.db.stockItem.findFirst({ where: { name: input.name } }))
      throw new ConflictException('Un article porte déjà ce nom');
    const item = await this.db.stockItem.create({
      data: {
        schoolId: currentSchoolId(),
        name: input.name,
        category: input.category,
        sizes: [...new Set(input.sizes)],
        unitPrice: input.unitPrice,
        alertThreshold: input.alertThreshold,
      },
    });
    await this.audit.log({
      action: 'stock.item_created',
      entity: 'StockItem',
      entityId: item.id,
      after: input,
    });
    return item;
  }

  /** Prix, seuil et tailles (une taille déjà mouvementée ne peut pas disparaître). */
  async updateItem(id: string, input: ItemInput) {
    const before = await this.db.stockItem.findUnique({
      where: { id },
      include: { movements: { select: { size: true } } },
    });
    if (!before) throw new NotFoundException('Article introuvable');
    if (await this.db.stockItem.findFirst({ where: { name: input.name, id: { not: id } } }))
      throw new ConflictException('Un article porte déjà ce nom');
    const sizes = [...new Set(input.sizes)];
    const used = new Set(before.movements.map((m) => m.size));
    const kept = sizes.length > 0 ? sizes : [''];
    if ([...used].some((s) => !kept.includes(s)))
      throw new ConflictException('Une taille déjà mouvementée ne peut pas être retirée');
    const item = await this.db.stockItem.update({
      where: { id },
      data: {
        name: input.name,
        category: input.category,
        sizes,
        unitPrice: input.unitPrice,
        alertThreshold: input.alertThreshold,
      },
    });
    await this.audit.log({
      action: 'stock.item_updated',
      entity: 'StockItem',
      entityId: id,
      before: { ...before, movements: undefined },
      after: input,
    });
    return item;
  }

  /** Verrouille l'article et renvoie son stock par taille. */
  private async lockItem(tx: Tx, itemId: string) {
    await tx.$queryRaw`SELECT "id" FROM "StockItem" WHERE "id" = ${itemId} AND "schoolId" = ${currentSchoolId()} FOR UPDATE`;
    const item = await tx.stockItem.findUnique({
      where: { id: itemId },
      include: { movements: { select: { size: true, type: true, quantity: true } } },
    });
    if (!item) throw new NotFoundException('Article introuvable');
    return { item, bySize: stockBySize(item.movements) };
  }

  private assertIssue(item: StockItem, bySize: Map<string, number>, size: string, qty: number) {
    const onHand = bySize.get(size) ?? 0;
    if (!canIssue(onHand, qty))
      throw new ConflictException(
        `Stock insuffisant pour « ${item.name} »${sizeLabel(size)} : ${onHand} disponible(s)`,
      );
  }

  async purchase(input: PurchaseInput) {
    return this.db.$transaction(async (tx) => {
      const { item } = await this.lockItem(tx, input.itemId);
      this.assertSize(item, input.size);
      const m = await tx.stockMovement.create({
        data: {
          schoolId: currentSchoolId(),
          itemId: item.id,
          size: input.size,
          type: 'PURCHASE',
          quantity: signedStockQuantity('PURCHASE', input.quantity),
          unitCost: input.unitCost,
          supplier: input.supplier,
          reference: input.reference || null,
          createdById: currentActorId() ?? null,
        },
      });
      await this.audit.log(
        { action: 'stock.purchase', entity: 'StockMovement', entityId: m.id, after: input },
        tx,
      );
      return m;
    });
  }

  /**
   * Vente à un élève, facturée par la scolarité. La clé `requestId` rend l'opération rejouable :
   * un nouvel envoi renvoie la vente déjà enregistrée sans nouvelle facture.
   */
  async sell(input: SaleInput) {
    const replay = await this.db.stockMovement.findFirst({ where: { requestId: input.requestId } });
    if (replay) return replay;
    const student = await this.db.student.findUnique({ where: { id: input.studentId } });
    if (!student || student.deletedAt) throw new NotFoundException('Élève introuvable');
    const schoolId = currentSchoolId();
    try {
      return await this.db.$transaction(async (tx) => {
        const { item, bySize } = await this.lockItem(tx, input.itemId);
        const done = await tx.stockMovement.findFirst({ where: { requestId: input.requestId } });
        if (done) return done;
        this.assertSize(item, input.size);
        this.assertIssue(item, bySize, input.size, input.quantity);
        const amount = item.unitPrice * input.quantity;
        if (amount > MAX_AMOUNT_FCFA)
          throw new BadRequestException('Montant de la vente trop élevé');
        let invoiceLineId: string | null = null;
        if (amount > 0) {
          const year = await this.scope.currentYear(tx);
          const line = await this.finance.addExtraCharge(
            {
              studentId: input.studentId,
              academicYearId: year.id,
              label: `${item.name}${sizeLabel(input.size)} × ${input.quantity}`,
              amount,
              dueDate: todayInCameroon(),
            },
            tx,
          );
          invoiceLineId = line.id;
        }
        const m = await tx.stockMovement.create({
          data: {
            schoolId,
            itemId: item.id,
            size: input.size,
            type: 'SALE',
            quantity: signedStockQuantity('SALE', input.quantity),
            unitPrice: item.unitPrice,
            studentId: input.studentId,
            requestId: input.requestId,
            invoiceLineId,
            createdById: currentActorId() ?? null,
          },
        });
        await this.audit.log(
          {
            action: 'stock.sale',
            entity: 'StockMovement',
            entityId: m.id,
            after: { ...input, amount, invoiceLineId },
          },
          tx,
        );
        return m;
      });
    } catch (e) {
      // Deux envois simultanés de la même vente : le second renvoie la première.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const first = await this.db.stockMovement.findFirst({
          where: { requestId: input.requestId },
        });
        if (first) return first;
      }
      throw e;
    }
  }

  async allocate(input: AllocationInput) {
    return this.db.$transaction(async (tx) => {
      const { item, bySize } = await this.lockItem(tx, input.itemId);
      this.assertSize(item, input.size);
      this.assertIssue(item, bySize, input.size, input.quantity);
      const m = await tx.stockMovement.create({
        data: {
          schoolId: currentSchoolId(),
          itemId: item.id,
          size: input.size,
          type: 'ALLOCATION',
          quantity: signedStockQuantity('ALLOCATION', input.quantity),
          reason: input.reason,
          createdById: currentActorId() ?? null,
        },
      });
      await this.audit.log(
        { action: 'stock.allocation', entity: 'StockMovement', entityId: m.id, after: input },
        tx,
      );
      return m;
    });
  }

  /**
   * Correction d'un mouvement par un mouvement inverse (une seule fois). Une vente annulée reçoit
   * automatiquement un avoir sur sa ligne de facture, à hauteur du reste dû ; la part déjà payée est
   * reportée sur les autres échéances impayées de l'élève (`carriedOver`), et ce qui ne trouve
   * aucune échéance à couvrir est à rendre en espèces par la caisse (`notCredited`).
   */
  async reverse(movementId: string, reason: string) {
    return this.db.$transaction(async (tx) => {
      const original = await tx.stockMovement.findUnique({ where: { id: movementId } });
      if (!original) throw new NotFoundException('Mouvement introuvable');
      if (original.type === 'REVERSAL' || original.type === 'ADJUSTMENT')
        throw new ConflictException('Ce mouvement ne se corrige pas : saisissez un inventaire');
      const { item, bySize } = await this.lockItem(tx, original.itemId);
      if (await tx.stockMovement.findFirst({ where: { reversesId: original.id } }))
        throw new ConflictException('Ce mouvement a déjà été corrigé');
      if (original.quantity > 0) this.assertIssue(item, bySize, original.size, original.quantity);
      const m = await tx.stockMovement.create({
        data: {
          schoolId: currentSchoolId(),
          itemId: original.itemId,
          size: original.size,
          type: 'REVERSAL',
          quantity: -original.quantity,
          unitCost: original.unitCost,
          unitPrice: original.unitPrice,
          studentId: original.studentId,
          reason,
          reversesId: original.id,
          createdById: currentActorId() ?? null,
        },
      });
      await this.audit.log(
        {
          action: 'stock.reversal',
          entity: 'StockMovement',
          entityId: m.id,
          before: { movementId: original.id, type: original.type, quantity: original.quantity },
          reason,
        },
        tx,
      );
      let credited = 0;
      let carriedOver = 0;
      let notCredited = 0;
      if (original.type === 'SALE' && original.invoiceLineId) {
        const amount = (original.unitPrice ?? 0) * Math.abs(original.quantity);
        const { applied } = await this.finance.creditNote(
          {
            lineId: original.invoiceLineId,
            amount,
            reason: `vente annulée : ${reason}`,
            source: 'stock',
          },
          tx,
        );
        credited = applied;
        notCredited = amount - applied;
        // Part déjà payée : reportée sur les prochaines échéances de l'élève, rien à rembourser.
        if (notCredited > 0 && original.studentId) {
          const report = await this.finance.carryOverCredit(
            {
              studentId: original.studentId,
              amount: notCredited,
              reason: `report de la vente annulée (déjà payée) : ${reason}`,
              excludeLineId: original.invoiceLineId,
            },
            tx,
          );
          carriedOver = report.carriedOver;
          notCredited = report.toRefund;
        }
      }
      return {
        ...m,
        invoiced: original.invoiceLineId !== null,
        credited,
        carriedOver,
        notCredited,
      };
    });
  }

  /**
   * Avoir partiel sur la facture d'une vente (geste commercial, article défectueux), par le
   * gestionnaire du stock : limité à la ligne de cette vente et à son reste dû.
   */
  async credit(movementId: string, amount: number, reason: string) {
    const m = await this.db.stockMovement.findUnique({ where: { id: movementId } });
    if (!m || m.type !== 'SALE') throw new NotFoundException('Vente introuvable');
    if (!m.invoiceLineId) throw new ConflictException('Cette vente n’a pas été facturée');
    const lineId = m.invoiceLineId;
    return this.db.$transaction(async (tx) => {
      const { applied } = await this.finance.creditNote(
        { lineId, amount, reason, source: 'stock', strict: true },
        tx,
      );
      await this.audit.log(
        {
          action: 'stock.credited',
          entity: 'StockMovement',
          entityId: movementId,
          after: { invoiceLineId: lineId, amount: applied },
          reason,
        },
        tx,
      );
      return { credited: applied };
    });
  }

  /** Historique des mouvements (le plus récent d'abord). */
  async movements(q: { itemId?: string; page: number; pageSize: number }) {
    const where: Prisma.StockMovementWhereInput = q.itemId ? { itemId: q.itemId } : {};
    const [total, rows] = await Promise.all([
      this.db.stockMovement.count({ where }),
      this.db.stockMovement.findMany({
        where,
        include: { item: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const studentIds = [...new Set(rows.map((r) => r.studentId).filter((x): x is string => !!x))];
    const students = await this.db.student.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    const reversed = new Set(
      (
        await this.db.stockMovement.findMany({
          where: { reversesId: { in: rows.map((r) => r.id) } },
          select: { reversesId: true },
        })
      ).map((r) => r.reversesId),
    );
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((m) => {
        const s = students.find((x) => x.id === m.studentId);
        return {
          id: m.id,
          item: m.item,
          size: m.size,
          type: m.type,
          typeLabel: STOCK_MOVEMENT_LABELS[m.type],
          quantity: m.quantity,
          unitCost: m.unitCost,
          unitPrice: m.unitPrice,
          supplier: m.supplier,
          reference: m.reference,
          reason: m.reason,
          student: s ? { id: s.id, name: `${s.lastName} ${s.firstName}` } : null,
          invoiced: m.invoiceLineId !== null,
          reversible: m.type !== 'REVERSAL' && m.type !== 'ADJUSTMENT' && !reversed.has(m.id),
          createdAt: m.createdAt,
        };
      }),
    };
  }

  /** Inventaire physique : chaque écart, justifié, devient un mouvement d'ajustement. */
  async inventory(input: InventoryInput) {
    const schoolId = currentSchoolId();
    return this.db.$transaction(async (tx) => {
      const itemIds = [...new Set(input.lines.map((l) => l.itemId))].sort();
      const expected = new Map<string, number>();
      const items = new Map<string, StockItem>();
      for (const itemId of itemIds) {
        const { item, bySize } = await this.lockItem(tx, itemId);
        items.set(itemId, item);
        for (const size of this.sizesOf(item))
          expected.set(`${itemId}|${size}`, bySize.get(size) ?? 0);
      }
      for (const l of input.lines) this.assertSize(items.get(l.itemId)!, l.size);
      const { gaps, missingReasons } = inventoryGaps(expected, input.lines);
      if (missingReasons.length > 0)
        throw new BadRequestException({
          message: 'Justifiez chaque écart d’inventaire',
          errors: missingReasons.map((m) => ({
            path: `${m.itemId}|${m.size}`,
            message: `Écart à justifier : ${items.get(m.itemId)?.name ?? ''}${sizeLabel(m.size)}`,
          })),
        });
      const reasons = new Map(input.lines.map((l) => [`${l.itemId}|${l.size}`, l.reason ?? null]));
      const inventory = await tx.stockInventory.create({
        data: {
          schoolId,
          note: input.note || null,
          lines: input.lines.map((l) => {
            const exp = expected.get(`${l.itemId}|${l.size}`) ?? 0;
            return { ...l, expected: exp, gap: l.counted - exp };
          }) as Prisma.InputJsonValue,
          createdById: currentActorId() ?? null,
        },
      });
      for (const g of gaps) {
        await tx.stockMovement.create({
          data: {
            schoolId,
            itemId: g.itemId,
            size: g.size,
            type: 'ADJUSTMENT',
            quantity: g.gap,
            reason: reasons.get(`${g.itemId}|${g.size}`) ?? null,
            inventoryId: inventory.id,
            createdById: currentActorId() ?? null,
          },
        });
      }
      await this.audit.log(
        {
          action: 'stock.inventory',
          entity: 'StockInventory',
          entityId: inventory.id,
          after: { gaps },
        },
        tx,
      );
      return { id: inventory.id, gaps };
    });
  }
}
