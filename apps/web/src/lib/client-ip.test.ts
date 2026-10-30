import { describe, expect, it } from 'vitest';
import { forwardedFor } from './client-ip';

describe('forwardedFor', () => {
  it('relaie l’adresse du visiteur fournie par Nginx', () => {
    expect(forwardedFor('102.244.12.7')).toEqual({ 'x-forwarded-for': '102.244.12.7' });
    expect(forwardedFor('2c0f:f0f8::1')).toEqual({ 'x-forwarded-for': '2c0f:f0f8::1' });
  });

  it('ne relaie rien sans adresse valide (développement, valeur inattendue)', () => {
    expect(forwardedFor(null)).toEqual({});
    expect(forwardedFor('')).toEqual({});
    expect(forwardedFor('1.2.3.4, 5.6.7.8')).toEqual({});
  });
});
