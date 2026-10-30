import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { env } from './config/env';
import { AuthGuard } from './common/auth.guard';
import { CoreModule } from './common/core.module';
import { ErrorsFilter } from './common/errors.filter';
import { PrismaModule } from './common/prisma';
import { HealthController } from './health.controller';
import { AcademicModule } from './modules/academic/academic.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CommunicationModule } from './modules/communication/communication.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DevModule } from './modules/dev/dev.module';
import { FilesModule } from './modules/files/files.module';
import { FinanceModule } from './modules/finance/finance.module';
import { GradesModule } from './modules/grades/grades.module';
import { LessonsModule } from './modules/lessons/lessons.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PlatformModule } from './modules/platform/platform.module';
import { PortalModule } from './modules/portal/portal.module';
import { ReportCardsModule } from './modules/report-cards/report-cards.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StaffModule } from './modules/staff/staff.module';
import { StudentsModule } from './modules/students/students.module';
import { TeacherModule } from './modules/teacher/teacher.module';
import { TimetableModule } from './modules/timetable/timetable.module';
import { TranscriptsModule } from './modules/transcripts/transcripts.module';
import { VerifyModule } from './modules/verify/verify.module';
import { DisciplineModule } from './modules/discipline/discipline.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { ReenrollmentModule } from './modules/reenrollment/reenrollment.module';

@Module({
  imports: [
    PrismaModule,
    CoreModule,
    NotificationsModule,
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
        skipIf: () => env().NODE_ENV === 'test',
      }),
    }),
    AuthModule,
    PlatformModule,
    AcademicModule,
    StaffModule,
    StudentsModule,
    AttendanceModule,
    GradesModule,
    ReportCardsModule,
    FinanceModule,
    DashboardModule,
    PortalModule,
    TeacherModule,
    CommunicationModule,
    AuditModule,
    SettingsModule,
    TimetableModule,
    VerifyModule,
    TranscriptsModule,
    DevModule,
    DocumentsModule,
    DisciplineModule,
    ReenrollmentModule,
    FilesModule,
    LessonsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorsFilter },
  ],
})
export class AppModule {}
