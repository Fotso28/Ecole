import { Body, Controller, Get, Module, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  id,
  libraryBookSchema,
  libraryCopiesSchema,
  libraryLoanSchema,
  libraryReturnSchema,
  librarySettingsSchema,
  paginationSchema,
  stockAllocationSchema,
  stockInventorySchema,
  stockItemSchema,
  stockPurchaseSchema,
  stockReversalSchema,
  stockSaleSchema,
  creditNoteSchema,
} from '@ecole/shared';
import { z } from 'zod';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { FinanceModule } from '../finance/finance.module';
import { LibraryService } from './library.service';
import { StockService } from './stock.service';

const bookQuerySchema = paginationSchema.extend({ search: z.string().max(80).optional() });
const loanQuerySchema = paginationSchema.extend({
  filter: z.enum(['active', 'overdue', 'history']).default('active'),
  studentId: id.optional(),
  staffUserId: id.optional(),
  bookId: id.optional(),
});
const movementQuerySchema = paginationSchema.extend({ itemId: id.optional() });

@ApiTags('library')
@ApiBearerAuth()
@RequireModule('library')
@Controller('library')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @RequirePermissions('library.read')
  @Get('settings')
  settings() {
    return this.library.settings();
  }

  @RequirePermissions('library.manage')
  @Put('settings')
  updateSettings(
    @Body(new ZodPipe(librarySettingsSchema)) body: z.infer<typeof librarySettingsSchema>,
  ) {
    return this.library.updateSettings(body);
  }

  @RequirePermissions('library.read')
  @Get('stats')
  stats() {
    return this.library.stats();
  }

  @RequirePermissions('library.read')
  @Get('books')
  books(@Query(new ZodPipe(bookQuerySchema)) q: z.infer<typeof bookQuerySchema>) {
    return this.library.books(q);
  }

  @RequirePermissions('library.manage')
  @Post('books')
  createBook(@Body(new ZodPipe(libraryBookSchema)) body: z.infer<typeof libraryBookSchema>) {
    return this.library.createBook(body);
  }

  @RequirePermissions('library.manage')
  @Post('books/:id/copies')
  addCopies(
    @Param('id') bookId: string,
    @Body(new ZodPipe(libraryCopiesSchema)) body: z.infer<typeof libraryCopiesSchema>,
  ) {
    return this.library.addCopies(bookId, body.count);
  }

  @RequirePermissions('library.manage')
  @Post('copies/:id/withdraw')
  withdraw(@Param('id') copyId: string) {
    return this.library.withdrawCopy(copyId);
  }

  @RequirePermissions('library.loans')
  @Get('readers/staff')
  staffReaders() {
    return this.library.staffReaders();
  }

  @RequirePermissions('library.read')
  @Get('loans')
  loans(@Query(new ZodPipe(loanQuerySchema)) q: z.infer<typeof loanQuerySchema>) {
    return this.library.loans(q);
  }

  @RequirePermissions('library.loans')
  @Post('loans')
  lend(@Body(new ZodPipe(libraryLoanSchema)) body: z.infer<typeof libraryLoanSchema>) {
    return this.library.lend(body);
  }

  @RequirePermissions('library.loans')
  @Post('loans/:id/renew')
  renew(@Param('id') loanId: string) {
    return this.library.renew(loanId);
  }

  @RequirePermissions('library.loans')
  @Post('loans/:id/return')
  giveBack(
    @Param('id') loanId: string,
    @Body(new ZodPipe(libraryReturnSchema)) body: z.infer<typeof libraryReturnSchema>,
  ) {
    return this.library.giveBack(loanId, body);
  }
}

@ApiTags('stock')
@ApiBearerAuth()
@RequireModule('library')
@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @RequirePermissions('stock.read')
  @Get('items')
  items() {
    return this.stock.items();
  }

  @RequirePermissions('stock.read')
  @Get('summary')
  summary() {
    return this.stock.summary();
  }

  @RequirePermissions('stock.write')
  @Post('items')
  createItem(@Body(new ZodPipe(stockItemSchema)) body: z.infer<typeof stockItemSchema>) {
    return this.stock.createItem(body);
  }

  @RequirePermissions('stock.write')
  @Put('items/:id')
  updateItem(
    @Param('id') itemId: string,
    @Body(new ZodPipe(stockItemSchema)) body: z.infer<typeof stockItemSchema>,
  ) {
    return this.stock.updateItem(itemId, body);
  }

  @RequirePermissions('stock.read')
  @Get('movements')
  movements(@Query(new ZodPipe(movementQuerySchema)) q: z.infer<typeof movementQuerySchema>) {
    return this.stock.movements(q);
  }

  @RequirePermissions('stock.write')
  @Post('purchases')
  purchase(@Body(new ZodPipe(stockPurchaseSchema)) body: z.infer<typeof stockPurchaseSchema>) {
    return this.stock.purchase(body);
  }

  @RequirePermissions('stock.write')
  @Post('sales')
  sell(@Body(new ZodPipe(stockSaleSchema)) body: z.infer<typeof stockSaleSchema>) {
    return this.stock.sell(body);
  }

  @RequirePermissions('stock.write')
  @Post('allocations')
  allocate(@Body(new ZodPipe(stockAllocationSchema)) body: z.infer<typeof stockAllocationSchema>) {
    return this.stock.allocate(body);
  }

  @RequirePermissions('stock.write')
  @Post('movements/:id/reverse')
  reverse(
    @Param('id') movementId: string,
    @Body(new ZodPipe(stockReversalSchema)) body: z.infer<typeof stockReversalSchema>,
  ) {
    return this.stock.reverse(movementId, body.reason);
  }

  @RequirePermissions('stock.write')
  @Post('movements/:id/credit')
  credit(
    @Param('id') movementId: string,
    @Body(new ZodPipe(creditNoteSchema)) body: z.infer<typeof creditNoteSchema>,
  ) {
    return this.stock.credit(movementId, body.amount, body.reason);
  }

  @RequirePermissions('stock.inventory')
  @Post('inventories')
  inventory(@Body(new ZodPipe(stockInventorySchema)) body: z.infer<typeof stockInventorySchema>) {
    return this.stock.inventory(body);
  }
}

@Module({
  imports: [FinanceModule],
  controllers: [LibraryController, StockController],
  providers: [LibraryService, StockService],
  exports: [LibraryService, StockService],
})
export class LibraryModule {}
