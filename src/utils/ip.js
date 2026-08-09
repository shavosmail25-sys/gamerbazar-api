// src/utils/ip.js
// კლიენტის რეალური IP-ის ამოღება — გაზიარებული utility, რომ ერთი და
// იგივე ლოგიკა გამოიყენებოდეს auth.js-შიც და middleware/security.js-შიც
// (ადრე ეს ფუნქცია auth.js-ში ლოკალურად იყო დუბლირებული).
'use strict';

// ── Railway (და უმეტესი PaaS პლატფორმა) ერთ reverse-proxy layer-ს
// იყენებს, ამიტომ X-Forwarded-For-ის პირველი მისამართი კლიენტის
// რეალური IP-ია. ეს header მხოლოდ მაშინაა სანდო, თუ Express-ს
// გამორთული არ აქვს `trust proxy` — იხ. INTEGRATION_NOTES.md,
// აუცილებლად საჭიროა `app.set('trust proxy', 1)` მთავარ app ფაილში,
// წინააღმდეგ შემთხვევაში (ა) ეს header თეორიულად spoof-ვადია
// (ბ) express-rate-limit საერთოდ არ გაეშვება (ისროლის ValidationError-ს).
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ── ლოკალური/კერძო IP დიაპაზონები — dev გარემოსა და
// health-check-ებზე VPN/IP-ლიმიტ შემოწმებებს ვტოვებთ, რომ ლოკალურ
// ტესტირებაზე registration ხელოვნურად არ დაიბლოკოს.
function isPrivateIp(ip) {
  if (!ip || ip === 'unknown') return true;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  return false;
}

module.exports = { getClientIp, isPrivateIp };
