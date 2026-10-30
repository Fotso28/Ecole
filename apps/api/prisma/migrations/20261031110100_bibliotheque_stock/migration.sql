-- CreateEnum
CREATE TYPE "BorrowerType" AS ENUM ('STUDENT', 'STAFF');

-- CreateEnum
CREATE TYPE "LibraryCopyStatus" AS ENUM ('AVAILABLE', 'LOANED', 'LOST', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "StockCategory" AS ENUM ('SUPPLY', 'UNIFORM');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('PURCHASE', 'SALE', 'ALLOCATION', 'ADJUSTMENT', 'REVERSAL');

-- CreateTable
CREATE TABLE "LibraryBook" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isbn" TEXT,
    "callNumber" TEXT,
    "publisher" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryCopy" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "LibraryCopyStatus" NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryCopy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryLoan" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "copyId" TEXT NOT NULL,
    "borrowerType" "BorrowerType" NOT NULL,
    "studentId" TEXT,
    "staffUserId" TEXT,
    "loanedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" DATE NOT NULL,
    "renewals" INTEGER NOT NULL DEFAULT 0,
    "returnedAt" TIMESTAMP(3),
    "lost" BOOLEAN NOT NULL DEFAULT false,
    "lastReminderOn" DATE,
    "penaltyAmount" INTEGER,
    "penaltyInvoiceLineId" TEXT,
    "loanedById" TEXT,
    "returnedById" TEXT,

    CONSTRAINT "LibraryLoan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockItem" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "StockCategory" NOT NULL,
    "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unitPrice" INTEGER NOT NULL,
    "alertThreshold" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "size" TEXT NOT NULL DEFAULT '',
    "type" "StockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" INTEGER,
    "unitPrice" INTEGER,
    "supplier" TEXT,
    "reference" TEXT,
    "studentId" TEXT,
    "reason" TEXT,
    "requestId" TEXT,
    "reversesId" TEXT,
    "invoiceLineId" TEXT,
    "inventoryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockInventory" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "note" TEXT,
    "lines" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockInventory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibraryBook_schoolId_title_idx" ON "LibraryBook"("schoolId", "title");

-- CreateIndex
CREATE INDEX "LibraryBook_schoolId_isbn_idx" ON "LibraryBook"("schoolId", "isbn");

-- CreateIndex
CREATE INDEX "LibraryCopy_bookId_idx" ON "LibraryCopy"("bookId");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryCopy_schoolId_code_key" ON "LibraryCopy"("schoolId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryLoan_penaltyInvoiceLineId_key" ON "LibraryLoan"("penaltyInvoiceLineId");

-- CreateIndex
CREATE INDEX "LibraryLoan_schoolId_returnedAt_dueDate_idx" ON "LibraryLoan"("schoolId", "returnedAt", "dueDate");

-- CreateIndex
CREATE INDEX "LibraryLoan_schoolId_studentId_idx" ON "LibraryLoan"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "LibraryLoan_schoolId_staffUserId_idx" ON "LibraryLoan"("schoolId", "staffUserId");

-- CreateIndex
CREATE UNIQUE INDEX "StockItem_schoolId_name_key" ON "StockItem"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_reversesId_key" ON "StockMovement"("reversesId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_invoiceLineId_key" ON "StockMovement"("invoiceLineId");

-- CreateIndex
CREATE INDEX "StockMovement_schoolId_itemId_idx" ON "StockMovement"("schoolId", "itemId");

-- CreateIndex
CREATE INDEX "StockMovement_schoolId_createdAt_idx" ON "StockMovement"("schoolId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_schoolId_requestId_key" ON "StockMovement"("schoolId", "requestId");

-- CreateIndex
CREATE INDEX "StockInventory_schoolId_createdAt_idx" ON "StockInventory"("schoolId", "createdAt");

-- AddForeignKey
ALTER TABLE "LibraryCopy" ADD CONSTRAINT "LibraryCopy_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "LibraryBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryLoan" ADD CONSTRAINT "LibraryLoan_copyId_fkey" FOREIGN KEY ("copyId") REFERENCES "LibraryCopy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StockItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "StockInventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Mouvements de stock en ajout seul : une correction passe par un mouvement inverse.
CREATE OR REPLACE FUNCTION forbid_stock_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Les mouvements de stock ne peuvent être ni modifiés ni supprimés (créer un mouvement inverse)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StockMovement_immutable"
  BEFORE UPDATE OR DELETE ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION forbid_stock_mutation();
