-- CreateEnum
CREATE TYPE "YearEndDecisionType" AS ENUM ('PROMOTED', 'PROMOTED_BY_COUNCIL', 'REPEAT', 'EXCLUDED_WORK', 'EXCLUDED_CONDUCT');

-- AlterTable
ALTER TABLE "CouncilDecision" ADD COLUMN     "yearEndDecision" "YearEndDecisionType";

-- AlterTable
ALTER TABLE "ReportCard" ADD COLUMN     "annualAverageCenti" INTEGER,
ADD COLUMN     "annualRank" INTEGER;
