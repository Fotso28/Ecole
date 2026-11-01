import { Search } from 'lucide-react';

/**
 * Saisie d'un code de vérification (imprimé sous le QR) : simple formulaire, utilisable sans
 * JavaScript. Majuscules, minuscules et espaces sont acceptées.
 */
export function VerifyCodeForm({ defaultValue = '' }: { defaultValue?: string }) {
  return (
    <form action="/verifier" method="get" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="verify-code" className="text-sm font-semibold text-ink">
          Code du document
        </label>
        <input
          id="verify-code"
          name="code"
          required
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          defaultValue={defaultValue}
          placeholder="Par exemple MXHE RZZB 6PEM"
          aria-describedby="verify-code-hint"
          className="h-12 w-full rounded-[10px] border border-line-strong bg-white px-3 text-base tracking-wide text-ink uppercase placeholder:normal-case placeholder:tracking-normal placeholder:text-[#6b7190]"
        />
        <span id="verify-code-hint" className="text-[13px] text-muted">
          Le code figure sous le QR code, en bas du document.
        </span>
      </div>
      <button
        type="submit"
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[10px] bg-primary px-4 text-[15px] font-semibold text-white hover:bg-primary-hover"
      >
        <Search className="size-4" aria-hidden />
        Vérifier le document
      </button>
    </form>
  );
}
