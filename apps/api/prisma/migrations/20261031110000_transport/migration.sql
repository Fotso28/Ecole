-- CreateEnum
CREATE TYPE "TransportDirection" AS ENUM ('OUTBOUND', 'RETURN', 'BOTH');

-- CreateEnum
CREATE TYPE "TripDirection" AS ENUM ('OUTBOUND', 'RETURN');

-- CreateEnum
CREATE TYPE "TransportSubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterEnum
ALTER TYPE "StaffRole" ADD VALUE 'TRANSPORT';

-- CreateTable
CREATE TABLE "TransportVehicle" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "insuranceExpiresOn" DATE,
    "inspectionExpiresOn" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransportVehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportLine" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vehicleId" TEXT,
    "fee" INTEGER NOT NULL,
    "oneWayFee" INTEGER NOT NULL,
    "staffUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransportLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportStop" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "morningTime" TEXT,
    "eveningTime" TEXT,

    CONSTRAINT "TransportStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportSubscription" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "direction" "TransportDirection" NOT NULL,
    "fee" INTEGER NOT NULL,
    "invoiceLineId" TEXT,
    "status" "TransportSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "TransportSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportTrip" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "direction" "TripDirection" NOT NULL,
    "takenById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportTripRecord" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "boarded" BOOLEAN,
    "alighted" BOOLEAN,
    "boardedAt" TIMESTAMP(3),
    "alightedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "TransportTripRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransportVehicle_schoolId_plate_key" ON "TransportVehicle"("schoolId", "plate");

-- CreateIndex
CREATE UNIQUE INDEX "TransportLine_schoolId_name_key" ON "TransportLine"("schoolId", "name");

-- CreateIndex
CREATE INDEX "TransportStop_schoolId_idx" ON "TransportStop"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportStop_lineId_order_key" ON "TransportStop"("lineId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "TransportSubscription_invoiceLineId_key" ON "TransportSubscription"("invoiceLineId");

-- CreateIndex
CREATE INDEX "TransportSubscription_schoolId_lineId_status_idx" ON "TransportSubscription"("schoolId", "lineId", "status");

-- CreateIndex
CREATE INDEX "TransportSubscription_schoolId_studentId_idx" ON "TransportSubscription"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "TransportTrip_schoolId_date_idx" ON "TransportTrip"("schoolId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TransportTrip_lineId_date_direction_key" ON "TransportTrip"("lineId", "date", "direction");

-- CreateIndex
CREATE INDEX "TransportTripRecord_schoolId_studentId_idx" ON "TransportTripRecord"("schoolId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportTripRecord_tripId_studentId_key" ON "TransportTripRecord"("tripId", "studentId");

-- AddForeignKey
ALTER TABLE "TransportLine" ADD CONSTRAINT "TransportLine_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "TransportVehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportStop" ADD CONSTRAINT "TransportStop_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "TransportLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportSubscription" ADD CONSTRAINT "TransportSubscription_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "TransportLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportSubscription" ADD CONSTRAINT "TransportSubscription_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "TransportStop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTripRecord" ADD CONSTRAINT "TransportTripRecord_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "TransportTrip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
