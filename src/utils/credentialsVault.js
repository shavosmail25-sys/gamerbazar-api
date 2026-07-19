// src/utils/credentialsVault.js
// ══════════════════════════════════════════════════════════════
// ანგარიშის მონაცემების (email+პაროლი) დაშიფვრა/გაშიფვრა —
// "Credentials Vault" ანტი-სქემ ფუნქციის ბირთვი.
//
// ⚠️ რატომ დაშიფვრა და არა plain-text: მონაცემები ინახება
// ორდერის მწკრივში (orders.credentials_secret). თუ ბაზა ოდესმე
// გაჟონავს (backup ჩამორთმევა, SQL injection სხვაგან, და ა.შ.),
// plain-text პაროლები დაუყოვნებლივ ექსპლუატირებადი იქნებოდა ყველა
// გაყიდულ ანგარიშზე. AES-256-GCM-ით შიფრაცია ამას გამორიცხავს
// (encryption key მხოლოდ სერვერის env-ში ინახება, ბაზაში არასდროს).
//
// გასაღები: CREDENTIALS_VAULT_KEY env ცვლადიდან (რეკომენდებულია —
// გენერირება: `openssl rand -hex 32`). თუ არ არის მითითებული,
// გასაღები დერივირდება JWT_SECRET-იდან (scrypt, ფიქსირებული salt-ით),
// რომ არსებული deployment-ი ახალი env ცვლადის გარეშეც იმუშაოს —
// მაგრამ production-ში მაინც ღირს ცალკე CREDENTIALS_VAULT_KEY დაყენება,
// რომ ორი სრულიად განსხვავებული დანიშნულების საიდუმლო (auth ტოკენები
// vs ანგარიშის მონაცემები) არასდროს იზიარებდეს ერთსა და იმავე გასაღებს.
// ══════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');

const ALGO        = 'aes-256-gcm';
const IV_LENGTH   = 12; // GCM-ისთვის რეკომენდებული 96-ბიტიანი IV

let cachedKey = null;
let warned    = false;

function getKey() {
  if (cachedKey) return cachedKey;

  const explicit = process.env.CREDENTIALS_VAULT_KEY;
  if (explicit) {
    // 64-hex-სიმბოლო (32 ბაიტი) მოსალოდნელია; თუ სხვა ფორმატია,
    // scrypt-ით მაინც ვამზადებთ ზუსტ 32-ბაიტიან გასაღებს.
    cachedKey = /^[0-9a-f]{64}$/i.test(explicit)
      ? Buffer.from(explicit, 'hex')
      : crypto.scryptSync(explicit, 'gamerbazar-credentials-vault', 32);
    return cachedKey;
  }

  if (!warned) {
    console.warn(
      '⚠️  CREDENTIALS_VAULT_KEY არ არის დაყენებული — Credentials Vault ' +
      'დროებით JWT_SECRET-იდან დერივირებულ გასაღებს იყენებს. ' +
      'რეკომენდებულია production-ში ცალკე გასაღების დაყენება ' +
      '(`openssl rand -hex 32` → CREDENTIALS_VAULT_KEY env ცვლადში).'
    );
    warned = true;
  }
  if (!process.env.JWT_SECRET) {
    throw new Error('vault_key_missing: CREDENTIALS_VAULT_KEY ან JWT_SECRET სავალდებულოა');
  }
  cachedKey = crypto.scryptSync(process.env.JWT_SECRET, 'gamerbazar-credentials-vault', 32);
  return cachedKey;
}

// ── დაშიფვრა — { email, password } ობიექტს აქცევს ერთ
// "iv:authTag:ciphertext" hex-სტრინგად, ბაზაში ჩასაწერად. ──
function encryptCredentials(payload) {
  const key   = getKey();
  const iv    = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const json = JSON.stringify(payload);
  const enc  = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag  = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

// ── გაშიფვრა — obratan აბრუნებს { email, password } ობიექტს. ──
function decryptCredentials(blob) {
  if (!blob) return null;
  const [ivHex, tagHex, dataHex] = String(blob).split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('invalid_vault_blob');

  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(dec.toString('utf8'));
}

module.exports = { encryptCredentials, decryptCredentials };
