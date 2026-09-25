import { describe, expect, it } from 'vitest';
import { SENSITIVE_PATTERNS, isSensitiveName, matchSensitive } from '../src/sensitive.js';

// One positive example per pattern: bare, prefixed and suffixed.
const EXAMPLES: Record<(typeof SENSITIVE_PATTERNS)[number], string[]> = {
  password: ['password', 'user_password', 'password_hash'],
  passwd: ['passwd', 'old_passwd'],
  secret: ['secret', 'client_secret', 'secret_value'],
  token: ['token', 'refresh_token', 'token_hash'],
  api_key: ['api_key', 'stripe_api_key', 'api_key_hash'],
  apikey: ['apikey', 'service_apikey'],
  ssn: ['ssn', 'customer_ssn'],
  email: ['email', 'user_email', 'EMAIL_Address'],
  phone: ['phone', 'phone_number', 'home_phone'],
  mobile: ['mobile', 'mobile_number'],
  iban: ['iban', 'payout_iban'],
  card_number: ['card_number', 'masked_card_number'],
  cvv: ['cvv', 'card_cvv'],
  dob: ['dob', 'user_dob'],
  birth_date: ['birth_date', 'customer_birth_date'],
  address: ['address', 'shipping_address', 'address_line1'],
  ip_address: ['ip_address', 'last_ip_address'],
  tc_kimlik: ['tc_kimlik', 'tc_kimlik_no'],
  tckn: ['tckn', 'musteri_tckn'],
  kimlik_no: ['kimlik_no', 'eski_kimlik_no'],
  vergi_no: ['vergi_no', 'firma_vergi_no'],
  salary: ['salary', 'base_salary'],
  maas: ['maas', 'net_maas'],
};

describe('sensitive column detection', () => {
  for (const pattern of SENSITIVE_PATTERNS) {
    it(`matches pattern "${pattern}"`, () => {
      for (const name of EXAMPLES[pattern]) {
        expect(isSensitiveName(name), name).toBe(true);
      }
      expect(matchSensitive(pattern)).toBe(pattern);
    });
  }

  it('does not match a pattern that is only part of a word', () => {
    for (const name of [
      'tokens_used_count',
      'emailed_at',
      'phones',
      'addressee',
      'dobby',
      'secretary_id',
      'api',
      'key',
      'card',
      'number',
      'birth',
      'kimlik',
      'vergi',
      'ip',
      'created_at',
      'id',
    ]) {
      expect(isSensitiveName(name), name).toBe(false);
    }
  });

  it('requires multi-part patterns to be consecutive', () => {
    expect(isSensitiveName('api_secondary_key')).toBe(false);
    expect(isSensitiveName('card_last_number')).toBe(false);
    expect(isSensitiveName('birth_place_date')).toBe(false);
  });
});
