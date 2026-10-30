import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  id,
  isoDate,
  TRIP_DIRECTIONS,
  transportLineSchema,
  transportRollCallSchema,
  transportSettingsSchema,
  transportStopSchema,
  transportSubscriptionSchema,
  transportVehicleSchema,
} from '@ecole/shared';
import { z } from 'zod';
import { parentContext, runAsSystem } from '../../common/context';
import { ParentRoute, RequireModule, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';
import { FinanceModule } from '../finance/finance.module';
import { TransportService } from './transport.service';

const subscriptionFilterSchema = z.object({ lineId: id.optional(), studentId: id.optional() });
const tripQuerySchema = z.object({
  lineId: id,
  date: isoDate,
  direction: z.enum(TRIP_DIRECTIONS),
});
const cancelSchema = z.object({ reason: z.string().trim().min(3, 'Motif obligatoire').max(200) });
const changeStopSchema = z.object({ stopId: id });

@ApiTags('transport')
@ApiBearerAuth()
@RequireModule('transport')
@Controller('transport')
export class TransportController {
  constructor(private readonly transport: TransportService) {}

  @RequirePermissions('transport.read')
  @Get('settings')
  settings() {
    return this.transport.settings();
  }

  @RequirePermissions('transport.manage')
  @Put('settings')
  updateSettings(
    @Body(new ZodPipe(transportSettingsSchema)) body: z.infer<typeof transportSettingsSchema>,
  ) {
    return this.transport.updateSettings(body);
  }

  @RequirePermissions('transport.read')
  @Get('vehicles')
  vehicles() {
    return this.transport.vehicles();
  }

  @RequirePermissions('transport.manage')
  @Post('vehicles')
  createVehicle(
    @Body(new ZodPipe(transportVehicleSchema)) body: z.infer<typeof transportVehicleSchema>,
  ) {
    return this.transport.createVehicle(body);
  }

  @RequirePermissions('transport.manage')
  @Put('vehicles/:id')
  updateVehicle(
    @Param('id') vehicleId: string,
    @Body(new ZodPipe(transportVehicleSchema)) body: z.infer<typeof transportVehicleSchema>,
  ) {
    return this.transport.updateVehicle(vehicleId, body);
  }

  @RequirePermissions('transport.read')
  @Get('staff')
  staff() {
    return this.transport.transportStaff();
  }

  @RequirePermissions('transport.read')
  @Get('lines')
  lines() {
    return this.transport.lines();
  }

  @RequirePermissions('transport.manage')
  @Post('lines')
  createLine(@Body(new ZodPipe(transportLineSchema)) body: z.infer<typeof transportLineSchema>) {
    return this.transport.createLine(body);
  }

  @RequirePermissions('transport.manage')
  @Put('lines/:id')
  updateLine(
    @Param('id') lineId: string,
    @Body(new ZodPipe(transportLineSchema)) body: z.infer<typeof transportLineSchema>,
  ) {
    return this.transport.updateLine(lineId, body);
  }

  @RequirePermissions('transport.manage')
  @Post('lines/:id/stops')
  addStop(
    @Param('id') lineId: string,
    @Body(new ZodPipe(transportStopSchema)) body: z.infer<typeof transportStopSchema>,
  ) {
    return this.transport.addStop(lineId, body);
  }

  @RequirePermissions('transport.manage')
  @Put('stops/:id')
  updateStop(
    @Param('id') stopId: string,
    @Body(new ZodPipe(transportStopSchema)) body: z.infer<typeof transportStopSchema>,
  ) {
    return this.transport.updateStop(stopId, body);
  }

  @RequirePermissions('transport.manage')
  @Delete('stops/:id')
  deleteStop(@Param('id') stopId: string) {
    return this.transport.deleteStop(stopId);
  }

  @RequirePermissions('transport.read')
  @Get('subscriptions')
  subscriptions(
    @Query(new ZodPipe(subscriptionFilterSchema)) q: z.infer<typeof subscriptionFilterSchema>,
  ) {
    return this.transport.subscriptions(q);
  }

  @RequirePermissions('transport.manage')
  @Post('subscriptions')
  subscribe(
    @Body(new ZodPipe(transportSubscriptionSchema))
    body: z.infer<typeof transportSubscriptionSchema>,
  ) {
    return this.transport.subscribe(body);
  }

  @RequirePermissions('transport.manage')
  @Patch('subscriptions/:id')
  changeStop(
    @Param('id') subscriptionId: string,
    @Body(new ZodPipe(changeStopSchema)) body: z.infer<typeof changeStopSchema>,
  ) {
    return this.transport.changeStop(subscriptionId, body.stopId);
  }

  @RequirePermissions('transport.manage')
  @Post('subscriptions/:id/cancel')
  cancel(
    @Param('id') subscriptionId: string,
    @Body(new ZodPipe(cancelSchema)) body: z.infer<typeof cancelSchema>,
  ) {
    return this.transport.cancel(subscriptionId, body.reason);
  }

  @RequirePermissions('transport.rollcall')
  @Get('my-lines')
  myLines() {
    return this.transport.myLines();
  }

  @RequirePermissions('transport.rollcall')
  @Get('trips')
  trip(@Query(new ZodPipe(tripQuerySchema)) q: z.infer<typeof tripQuerySchema>) {
    return this.transport.trip(q.lineId, q.date, q.direction);
  }

  @RequirePermissions('transport.rollcall')
  @Put('trips')
  saveTrip(
    @Body(new ZodPipe(transportRollCallSchema)) body: z.infer<typeof transportRollCallSchema>,
  ) {
    return this.transport.saveTrip(body);
  }
}

/** Portail des parents : transport de l'enfant, après vérification du lien parent-enfant. */
@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal')
export class TransportPortalController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly transport: TransportService,
  ) {}

  @ParentRoute()
  @Get('children/:id/transport')
  async childTransport(@Param('id') studentId: string) {
    const userId = parentContext().userId;
    const link = await runAsSystem('portal-link', () =>
      this.db.studentGuardian.findFirst({
        where: {
          studentId,
          guardian: { userId },
          student: { deletedAt: null, school: { status: 'ACTIVE', modules: { has: 'portal' } } },
        },
        include: { student: { include: { school: { select: { modules: true } } } } },
      }),
    );
    if (!link) throw new NotFoundException('Enfant introuvable');
    if (!link.student.school.modules.includes('transport'))
      return { enabled: false, subscription: null, today: [] };
    const data = await runAsSystem(
      'portal-transport',
      () => this.transport.forParent(studentId),
      link.schoolId,
    );
    return { enabled: true, ...data };
  }
}

@Module({
  imports: [FinanceModule],
  controllers: [TransportController, TransportPortalController],
  providers: [TransportService],
  exports: [TransportService],
})
export class TransportModule {}
