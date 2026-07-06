// src/utils/otp.js
// OTP კოდების გენერაცია/ჰეშირება — Email + OTP შესვლისთვის (პაროლების გარეშე)
'use strict';

const crypto = require('crypto');

const OTP_LENGTH_DEFAULT = 6;          // 6-ნიშნა კოდი (4 ან 6 დასაშვებია — ვირჩევთ უსაფრთხო ვარიანტს)
const OTP_TTL_MINUTES    = 5;          // 5-წუთიანი ვადა
const OTP_MAX_ATTEMPTS   = 5;          // მაქს. მცდელობა კოდის გამოცნობაზე
const OTP_RESEND_COOLDOWN_SECONDS = 60; // მინ. ინტერვალი ხელახლა გაგზავნამდე

// ── შემთხვევითი რიცხვითი კოდის გენერაცია (მოცემული სიგრძით) ──
function generateCode(length = OTP_LENGTH_DEFAULT) {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(length, '0');
}

// ── კოდის ჰეში — plaintext არასდროს ინახება ბაზაში ──
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

module.exports = {
  OTP_LENGTH_DEFAULT,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  generateCode,
  hashCode,
};
