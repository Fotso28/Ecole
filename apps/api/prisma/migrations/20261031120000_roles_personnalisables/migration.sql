-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "customRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "rolesVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RoleOverride" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "added" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "removed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomRole" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "classScoped" BOOLEAN NOT NULL DEFAULT false,
    "lineScoped" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoleOverride_schoolId_role_key" ON "RoleOverride"("schoolId", "role");

-- CreateIndex
CREATE INDEX "CustomRole_schoolId_idx" ON "CustomRole"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomRole_schoolId_name_key" ON "CustomRole"("schoolId", "name");
