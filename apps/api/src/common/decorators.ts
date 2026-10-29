import { SetMetadata } from '@nestjs/common';
import type { Module as SchoolModule, Permission } from '@ecole/shared';

export const PUBLIC_KEY = 'ecole:public';
export const PERMISSIONS_KEY = 'ecole:permissions';
export const PARENT_KEY = 'ecole:parent';
export const ACCOUNT_KEY = 'ecole:account';
export const ALLOW_WITHOUT_MFA_KEY = 'ecole:allow-without-mfa';
export const PLATFORM_ADMIN_KEY = 'ecole:platform-admin';
export const MODULE_KEY = 'ecole:module';

/** Route accessible sans authentification. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Route du personnel exigeant toutes les permissions listées. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Route du portail parent. */
export const ParentRoute = () => SetMetadata(PARENT_KEY, true);

/** Route de compte : tout utilisateur connecté (personnel avec ou sans établissement, parent). */
export const AccountRoute = () => SetMetadata(ACCOUNT_KEY, true);

/** Route utilisable avant la configuration obligatoire de la double authentification. */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA_KEY, true);

/** Route réservée au super-administrateur de la plateforme. */
export const PlatformAdminRoute = () => SetMetadata(PLATFORM_ADMIN_KEY, true);

/** Route d'un module activable par abonnement. */
export const RequireModule = (module: SchoolModule) => SetMetadata(MODULE_KEY, module);
