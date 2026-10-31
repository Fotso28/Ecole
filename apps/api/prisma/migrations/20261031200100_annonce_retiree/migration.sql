-- Annonce retirée par la direction (erreur de destinataire…) : plus visible sur le portail.
ALTER TABLE "Announcement" ADD COLUMN "withdrawnAt" TIMESTAMP(3);
ALTER TABLE "Announcement" ADD COLUMN "withdrawnById" TEXT;
