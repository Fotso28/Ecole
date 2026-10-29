-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "requestedLineIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
