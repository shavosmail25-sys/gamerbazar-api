// src/utils/moderation.js
// ══════════════════════════════════════════════════════════════
// ANTI-SCAM / ESCROW PROTECTION FILTER
//
// Regex-based auto-moderation for the pre-purchase buyer↔seller chat
// (src/routes/chat.js). Goal: keep negotiation *inside* the platform's
// Escrow flow by detecting and masking the three main ways scammers try
// to move a deal off-platform before an order/escrow ever exists:
//   1) external links / social handles (Discord, Telegram, WhatsApp,
//      Viber, Facebook, Instagram, Snapchat, Skype)
//   2) phone numbers (Georgian-format first, generic international as
//      a fallback)
//   3) "let's just deal directly / pay outside the site" keywords
//      (Georgian + English)
//
// This is a heuristic first line of defense, not a guarantee — it is
// meant to make casual scam attempts inconvenient and to leave an
// audit trail (message_flags table) for human review in Watchtower,
// not to be a perfect classifier. Tune the RULES below as real abuse
// patterns are observed.
//
// Usage:
//   const { moderateMessage } = require('../utils/moderation');
//   const { clean, flagged, categories } = moderateMessage(rawContent);
//   // `clean` is what gets stored/broadcast; `flagged`/`categories`
//   // decide whether to also write a message_flags row for admin review.
// ══════════════════════════════════════════════════════════════
'use strict';

const REDACTION = '[⚠ დაფარულია უსაფრთხოებისთვის]';

// ── წესები — თითოეული გამოსცდის მთელ ტექსტს და ემთხვევა ნაწილებს
// REDACTION-ით ანაცვლებს. რიგი მნიშვნელოვანია: ჯერ სრული URL-ები
// და ცნობილი დომენები, შემდეგ პლატფორმის სახელები/handle-ები,
// შემდეგ ტელეფონები, ბოლოს — "გვერდის ავლის" საკვანძო სიტყვები. ──
const RULES = [
  // 1) სრული http(s) ბმულები — ნებისმ. საიტი, არა მხოლოდ სოც. ქსელები
  {
    category: 'link',
    re: /\bhttps?:\/\/\S+/gi,
  },

  // 2) ცნობილი დომენები schema-ს გარეშე (მაგ. "t.me/username",
  //    "discord.gg/abc123", "wa.me/995555..." ჩვეულ ტექსტში)
  {
    category: 'link',
    re: /\b(discord\.gg|discordapp\.com|t\.me|telegram\.me|telegram\.org|wa\.me|whatsapp\.com|instagram\.com|facebook\.com|fb\.com|fb\.me|snapchat\.com|skype\.com)\/\S+/gi,
  },

  // 3) Discord-ის კლასიკური "username#1234" ტეგი (URL/სახელის გარეშეც) —
  //    წინ დგას შემდეგ წესზე, რომ "discord: coolguy#1234" მთლიანად
  //    ერთხელ დაიფაროს, ნაცვლად იმისა, რომ #1234 ცალკე გამოჩნდეს.
  {
    category: 'social_handle',
    re: /\b[a-zA-Z0-9_.]{2,32}#\d{4}\b/g,
  },

  // 4) პლატფორმის სახელის ხსენება + შესაძლო handle (URL-ის გარეშეც) —
  //    "დამიწერე discord-ზე", "ჩემი ტელეგრამი: @user", "Insta: nickname",
  //    "skype me at live:xyz" და მისთ.
  {
    category: 'social_handle',
    re: /\b(discord|telegram|whats\s*app|viber|facebook|instagram|insta|snapchat|skype)\b[\s:=\-]{0,5}(@?[\w.\-]{2,40})?/gi,
  },

  // 5) ქართული მობილურის ნომერი — არასავალდებულო +995 პრეფიქსით,
  //    5XX XX XX XX ფორმატით (spaces/dashes ან მათ გარეშე)
  {
    category: 'phone',
    re: /(\+?995[\s\-]?)?5\d{2}[\s\-]?\d{2}[\s\-]?\d{2}[\s\-]?\d{2}\b/g,
  },

  // 6) გენერიკული საერთაშ. ტელეფონის ნომერი — fallback ნებისმ. სხვა
  //    ქვეყნის ფორმატისთვის (7+ ციფრი, space/dash-ებით შეიძლება გაყოფილი)
  {
    category: 'phone',
    re: /\+?\d[\d\s\-]{6,16}\d\b/g,
  },

  // 7) "გვერდის ავლის" საკვანძო ფრაზები — ქართული + ინგლ.
  {
    category: 'bypass_keyword',
    re: /(პირდაპირ\s*გადმ?ირიცხ\w*|საიტის\s*გარეთ|პლატფორმის\s*გარეთ|ვაჭრობა\s*გვერდით|ქეშით\s*გადახდა|cash\s*app|cashapp|paypal|revolut|iban|venmo|off[\s\-]?platform|outside\s*(the\s*)?platform|pay\s*directly|direct(ly)?\s*payment|deal\s*directly|meet\s*(up\s*)?in\s*person)/gi,
  },
];

/**
 * ტექსტში სკანირებს ზემოთა RULES-ს, პოულობს/ფარავს საეჭვო ნაწილებს.
 * იდემპოტენტურია და გვერდითი ეფექტების გარეშე (წმინდა ფუნქცია).
 *
 * @param {string} rawText - მომხმარებლის მიერ გაგზავნილი ნედლი ტექსტი
 * @returns {{clean: string, flagged: boolean, categories: string[]}}
 *   clean      - დაფარული ვერსია (ეს ინახება/broadcast-დება ჩატში)
 *   flagged    - true, თუ რომელიმე წესი ამოქმედდა
 *   categories - რომელი კატეგორიები ამოქმედდა (დუბლიკატების გარეშე),
 *                მაგ. ['link','phone']
 */
function moderateMessage(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { clean: rawText || '', flagged: false, categories: [] };
  }

  let clean = rawText;
  const categoriesHit = new Set();

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(clean)) categoriesHit.add(rule.category);
    rule.re.lastIndex = 0;
    clean = clean.replace(rule.re, REDACTION);
  }

  return { clean, flagged: categoriesHit.size > 0, categories: [...categoriesHit] };
}

/**
 * message_flags.redacted_snippet-ისთვის მოკლე, უკვე დაფარული ამონარიდის
 * აგება — ორიგინალი (დაუფარავი) ტექსტი ადმინის აუდიტ ცხრილშიც არასდროს
 * ინახება, მხოლოდ უკვე მასკირებული `clean` ვერსიის ამონარიდი.
 *
 * @param {string} cleanText - moderateMessage(...).clean
 * @param {number} [maxLen=200]
 */
function buildSnippet(cleanText, maxLen = 200) {
  const t = String(cleanText || '');
  return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
}

module.exports = { moderateMessage, buildSnippet, REDACTION };
