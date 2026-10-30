const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)$/i;

/**
 * En-têtes à transmettre à l'API pour un appel fait par le serveur du site au nom d'un visiteur.
 * Nginx renseigne `X-Real-IP` avec l'adresse réelle (le visiteur ne peut pas l'imposer) ; sans
 * elle, l'API verrait l'adresse du serveur du site pour tous les visiteurs, qui partageraient
 * alors une seule limite de débit.
 */
export function forwardedFor(realIp: string | null | undefined): Record<string, string> {
  const ip = realIp?.trim();
  return ip && IP.test(ip) ? { 'x-forwarded-for': ip } : {};
}
