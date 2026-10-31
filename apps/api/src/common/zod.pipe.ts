import { describeIssues } from '@ecole/shared';
import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Valide et transforme le corps ou les paramètres avec un schéma Zod partagé. Le message dit quel
 * champ est en cause et pourquoi ; le détail de chaque erreur reste dans `errors`.
 */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        // Champ et raison de la première erreur (« Montant : Montant trop élevé… »).
        message: describeIssues(result.error.issues),
        errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}
