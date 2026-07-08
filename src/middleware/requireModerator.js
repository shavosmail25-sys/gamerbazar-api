// src/middleware/requireModerator.js
// დამატებითი middleware მოდერატორების სისტემისთვის.
//
// ⚠️ მნიშვნელოვანი: ეს ფაილი არ ცვლის და არ ეხება არსებულ
// src/middleware/auth.js-ს (requireAuth/requireAdmin) — მთლიანად
// ცალკე, additive ფაილია. გამოიყენება ყოველთვის requireAuth-ის
// შემდეგ, რომელიც req.user-ს ავსებს (მოსალოდნელია req.user.role).
'use strict';

// მოდერატორი ან ადმინი — ორივეს შეუძლია pending listing-ების
// დამტკიცება/უარყოფა და დავების გარჩევა.
function requireModerator(req, res, next) {
  if (!req.user || !['moderator', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden', message: 'მოდერატორის ან ადმინის უფლება საჭიროა' });
  }
  next();
}

module.exports = { requireModerator };
