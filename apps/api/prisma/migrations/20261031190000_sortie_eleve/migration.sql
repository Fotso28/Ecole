-- Sortie d'un élève en cours d'année (transfert ou sortie) : date, motif et établissement d'accueil.
-- La table "Enrollment" est déjà cloisonnée (Row-Level Security) : rien à ajouter pour ces colonnes.
ALTER TABLE "Enrollment" ADD COLUMN     "destinationSchool" TEXT,
ADD COLUMN     "exitDate" DATE,
ADD COLUMN     "exitReason" TEXT;
