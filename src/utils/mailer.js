// src/utils/mailer.js
// Email შეტყობინებები — Brevo HTTP API (არა SMTP!)
//
// რატომ Brevo API და არა nodemailer/SMTP:
// Render-ის უფასო გეგმა 2025 წლის სექტემბრიდან ბლოკავს ყველა გამავალ SMTP
// პორტს (25, 465, 587) — ანუ Gmail SMTP აღარასდროს იმუშავებს უფასო
// Render სერვისიდან, პაროლის მიუხედავად (Connection timeout). Brevo-ს
// API HTTPS (443) პორტზე მუშაობს, რომელიც არასდროს იბლოკება.
//
// საჭირო ENV ცვლადები:
//   BREVO_API_KEY — Brevo dashboard → Settings → SMTP & API → API Keys
//   EMAIL_USER    — შენი გამომგზავნი მისამართი (Brevo-ში Single Sender
//                   Verification-ით დადასტურებული, მაგ. Gmail მისამართი)
'use strict';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function isConfigured() {
  return !!(process.env.BREVO_API_KEY && process.env.EMAIL_USER);
}

// ── ბაზის ფუნქცია — html email გაგზავნა Brevo API-ით ──────────
async function sendMail({ to, subject, html }) {
  if (!isConfigured() || !to) return { sent: false };

  try {
    const res = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sender:  { name: 'GamerBazar.ge', email: process.env.EMAIL_USER },
        to:      [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      console.error('brevo send error:', res.status, errText);
      return { sent: false, error: errText };
    }
    return { sent: true };
  } catch (err) {
    console.error('mail send error:', err.message);
    return { sent: false, error: err.message };
  }
}

// ── HTML wrapper — ერთიანი თემა ──────────────────────────────
function wrap(title, bodyHtml, ctaText, ctaUrl) {
  const cta = ctaUrl
    ? `<a href="${ctaUrl}" style="display:inline-block;margin-top:18px;padding:11px 22px;background:#7c5cff;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">${ctaText || 'გახსნა'}</a>`
    : '';
  return `
  <div style="font-family:Arial,sans-serif;background:#0d0f17;padding:30px 0">
    <div style="max-width:480px;margin:0 auto;background:#161925;border-radius:14px;padding:28px;color:#e6e8f0">
      <div style="font-size:20px;font-weight:700;margin-bottom:4px">🎮 GamerBazar.ge</div>
      <div style="height:1px;background:#2a2d3d;margin:14px 0"></div>
      <div style="font-size:16px;font-weight:600;margin-bottom:10px">${title}</div>
      <div style="font-size:14px;line-height:1.6;color:#b6bacb">${bodyHtml}</div>
      ${cta}
      <div style="height:1px;background:#2a2d3d;margin:22px 0 14px"></div>
      <div style="font-size:11px;color:#6b7080">
        თუ არ გსურს ამ ტიპის შეტყობინებების მიღება, შეგიძლია გათ. შეიცვალო პროფილის პარამეტრებში.
      </div>
    </div>
  </div>`;
}

const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:3000';

// ══════════════════════════════════════════════════════════════
// OTP EMAIL — Email + OTP შესვლა/რეგისტრაცია
// ══════════════════════════════════════════════════════════════
async function sendOtpEmail(email, code, ttlMinutes) {
  return sendMail({
    to: email,
    subject: `🔐 შენი GamerBazar კოდია: ${code}`,
    html: wrap(
      'შესვლის კოდი',
      `შენი ერთჯერადი კოდია:<br><br>
       <div style="font-size:32px;font-weight:700;letter-spacing:6px;color:#fff;text-align:center;
                   background:#0d0f17;border-radius:10px;padding:16px 0;margin:10px 0">${code}</div>
       <br>კოდი მოქმედია <b>${ttlMinutes || 5} წუთი</b>. არავის გაუზიარო ეს კოდი — GamerBazar.ge-ის
       გუნდი არასდროს მოგთხოვს მას სატელეფონო ან ჩატის საშუალებით.`
    ),
  });
}

// ══════════════════════════════════════════════════════════════
// ORDER EMAILS
// ══════════════════════════════════════════════════════════════
async function sendOrderCreatedEmail(seller, order, listing) {
  if (!seller.notif_email || !seller.email) return;
  return sendMail({
    to: seller.email,
    subject: `🛒 ახალი შეკვეთა — ${listing.title}`,
    html: wrap(
      'ახალი შეკვეთა მიგიღია!',
      `განცხადებაზე <b>${listing.title}</b> (₾${Number(order.amount_gel).toFixed(2)}) ახალი შეკვეთა შემოვიდა.
       თანხა Escrow-ში გაიყინა. გადაამოწმე შეკვეთა და დაუკავშირდი მყიდველს ჩატში.`,
      'შეკვეთის ნახვა', `${FRONTEND}/?order=${order.id}`
    ),
  });
}

async function sendOrderConfirmedEmail(seller, order, listing) {
  if (!seller.notif_email || !seller.email) return;
  return sendMail({
    to: seller.email,
    subject: `✅ შეკვეთა დადასტ. — ${listing.title}`,
    html: wrap(
      'მყიდველმა შეკვეთა დაადასტურა',
      `<b>${listing.title}</b>-ის შეკვეთა დადასტურდა. ₾${Number(order.seller_receives).toFixed(2)}
       ჩარიცხულია შენს ბალანსზე (5% საკომისიოს გამოკლებით).`,
      'ბალანსის ნახვა', `${FRONTEND}/?page=wallet`
    ),
  });
}

async function sendOrderCancelledEmail(buyer, order, listing, reason) {
  if (!buyer.notif_email || !buyer.email) return;
  return sendMail({
    to: buyer.email,
    subject: `↩️ შეკვეთა გაუქმდა — ${listing.title}`,
    html: wrap(
      'შეკვეთა გაუქმდა და თანხა დაბრუნდა',
      `<b>${listing.title}</b>-ის შეკვეთა გაუქმდა. ₾${Number(order.amount_gel).toFixed(2)} დაბრუნდა
       შენს ბალანსზე.${reason ? `<br><br>მიზეზი: ${reason}` : ''}`,
      'ბალანსის ნახვა', `${FRONTEND}/?page=wallet`
    ),
  });
}

async function sendOrderExpiredEmail(buyer, order, listing) {
  if (!buyer.notif_email || !buyer.email) return;
  return sendMail({
    to: buyer.email,
    subject: `⏰ შეკვეთის ვადა გავიდა — ${listing.title}`,
    html: wrap(
      'შეკვეთა ავტომატურად გაუქმდა',
      `<b>${listing.title}</b>-ის შეკვეთაზე 48 საათში დადასტურება არ მოხდა,
       ამიტომ ის ავტომატურად გაუქმდა და ₾${Number(order.amount_gel).toFixed(2)} დაბრუნდა შენს ბალანსზე.`,
      'ბალანსის ნახვა', `${FRONTEND}/?page=wallet`
    ),
  });
}

// ══════════════════════════════════════════════════════════════
// DELIVERY EMAILS
// ══════════════════════════════════════════════════════════════
async function sendDeliveredEmail(buyer, order, listing, deadline) {
  if (!buyer.notif_email || !buyer.email) return;
  const deadlineStr = new Date(deadline).toLocaleString('ka-GE', {
    dateStyle: 'medium', timeStyle: 'short',
  });
  return sendMail({
    to: buyer.email,
    subject: `📦 ნივთი გადაგეცათ — ${listing.title}`,
    html: wrap(
      'გამყიდველმა ნივთი გადასცა',
      `<b>${listing.title}</b>-ის გამყიდველმა ნივთი/მონაცემები გადაგცათ.<br><br>
       თქვენ გაქვთ <b>48 საათი</b> (ვადა: ${deadlineStr}) შეამოწმოთ და:
       <ul style="margin:10px 0;padding-left:18px">
         <li>დაადასტუროთ მიღება — ფული გამყიდველს გადაეცემა</li>
         <li>გახსნათ დავა — თუ რამე პრობლემაა, მოგვაწოდეთ სქრინშოტი/ვიდეო</li>
       </ul>
       <b>48 საათის შემდეგ სისტემა ავტომატურად დაადასტ. შეკვეთას.</b>`,
      'შეკვეთის ნახვა', `${FRONTEND}/?order=${order.id}`
    ),
  });
}

async function send24hReminderEmail(buyer, order, listing) {
  if (!buyer.notif_email || !buyer.email) return;
  return sendMail({
    to: buyer.email,
    subject: `⏰ შეახსენება — 24 საათი დარჩა · ${listing.title}`,
    html: wrap(
      'შეახსენება: 24 საათი დარჩა',
      `<b>${listing.title}</b>-ის შეკვეთაზე <b>დარჩა მხოლოდ 24 საათი</b>.<br><br>
       დაადასტ. მიღება ან გახსენი დავა (სქრინშოტით/ვიდეოთი), წინააღმდეგ შემთხვევაში
       ფული ავტომატურად გამყიდველს გადაეცემა.`,
      'შეკვეთის ნახვა', `${FRONTEND}/?order=${order.id}`
    ),
  });
}

// ══════════════════════════════════════════════════════════════
// DISPUTE EMAILS
// ══════════════════════════════════════════════════════════════
async function sendDisputeOpenedEmail(recipient, dispute, order, listing) {
  if (!recipient.notif_email || !recipient.email) return;
  return sendMail({
    to: recipient.email,
    subject: `⚠️ დავა გაიხსნა — ${listing.title}`,
    html: wrap(
      'შეკვეთაზე დავა გაიხსნა',
      `<b>${listing.title}</b>-ის შეკვეთაზე (₾${Number(order.amount_gel).toFixed(2)}) დავა გაიხსნა.<br><br>
       მიზეზი: <b>${dispute.reason}</b><br>
       აღწერა: ${dispute.description}<br><br>
       ადმინისტრაცია მალე გადასინჯავს საკითხს.`,
      'დავის ნახვა', `${FRONTEND}/?dispute=${dispute.id}`
    ),
  });
}

async function sendDisputeResolvedEmail(recipient, dispute, order, listing, outcome) {
  if (!recipient.notif_email || !recipient.email) return;
  const outcomeText = outcome === 'release'
    ? 'თანხა გადაირიცხა გამყიდველზე'
    : 'თანხა დაუბრუნდა მყიდველს';
  return sendMail({
    to: recipient.email,
    subject: `🛡️ დავა გადაწყდა — ${listing.title}`,
    html: wrap(
      'დავა გადაწყდა',
      `<b>${listing.title}</b>-ის შეკვეთაზე გახსნილი დავა ადმინისტრაციამ გადაწყვიტა.<br><br>
       გადაწყვეტილება: <b>${outcomeText}</b>${dispute.admin_note ? `<br><br>კომენტარი: ${dispute.admin_note}` : ''}`,
      'შეკვეთის ნახვა', `${FRONTEND}/?order=${order.id}`
    ),
  });
}

// ══════════════════════════════════════════════════════════════
// LISTING MODERATION EMAILS — მოხსნა / უარყოფა (+ ჩატის მიზეზი)
// ══════════════════════════════════════════════════════════════
async function sendListingRemovedEmail(seller, listing, reason) {
  if (!seller.notif_email || !seller.email) return;
  return sendMail({
    to: seller.email,
    subject: `🚫 განცხადება მოხსნილია — ${listing.title}`,
    html: wrap(
      'თქვენი განცხადება მოხსნილია',
      `თქვენი განცხადება <b>${listing.title}</b> ადმინისტრაციის მიერ საიტიდან მოიხსნა.<br><br>
       მიზეზი: <b>${reason}</b><br><br>
       იგივე შეტყობინება ასევე გაქვთ მიღებული საიტის ჩატში. კითხვების შემთხვევაში
       დაგვიკავშირდით მხარდაჭერის ჩატის საშუალებით.`,
      'პროფილის ნახვა', `${FRONTEND}/?page=profile`
    ),
  });
}

async function sendListingRejectedEmail(seller, listing, reason) {
  if (!seller.notif_email || !seller.email) return;
  return sendMail({
    to: seller.email,
    subject: `❌ განცხადება უარყოფილია — ${listing.title}`,
    html: wrap(
      'თქვენი განცხადება უარყოფილია მოდერაციაში',
      `თქვენი განცხადება <b>${listing.title}</b> მოდერაციამ ვერ დაადასტურა და ის აქტიური არ გახდება.<br><br>
       მიზეზი: <b>${reason}</b><br><br>
       შეგიძლიათ განცხადება შეასწოროთ და ხელახლა გაგზავნოთ მოდერაციაზე პროფილიდან.
       იგივე შეტყობინება ასევე გაქვთ მიღებული საიტის ჩატში.`,
      'პროფილის ნახვა', `${FRONTEND}/?page=profile`
    ),
  });
}

// ══════════════════════════════════════════════════════════════
// WALLET EMAILS — ადმინს შეტყობინება
// ══════════════════════════════════════════════════════════════
async function sendDepositRequestEmail(adminEmail, user, amount, ref) {
  return sendMail({
    to: adminEmail,
    subject: `💰 შეტანის მოთხ. — @${user.username} — ₾${Number(amount).toFixed(2)}`,
    html: wrap(
      `შეტანის მოთხოვნა — ₾${Number(amount).toFixed(2)}`,
      `მომხმარებელი <b>@${user.username}</b> (${user.email}) ითხოვს ₾${Number(amount).toFixed(2)}-ის ბალანსზე შეტანას.<br><br>
       REF კოდი: <b style="font-family:monospace;color:#7c5cff">${ref}</b><br><br>
       გადაამოწმე BOG-ში გადარიცხვა და ადმინ პანელში დაადასტ. ან უარყავი.`,
      'ადმინ პანელი', `${FRONTEND}/admin.html`
    ),
  });
}

async function sendWithdrawRequestEmail(adminEmail, user, amount, iban) {
  return sendMail({
    to: adminEmail,
    subject: `📤 გამოტანის მოთხ. — @${user.username} — ₾${Number(amount).toFixed(2)}`,
    html: wrap(
      `გამოტანის მოთხოვნა — ₾${Number(amount).toFixed(2)}`,
      `მომხმარებელი <b>@${user.username}</b> (${user.email}) ითხოვს ₾${Number(amount).toFixed(2)}-ის გამოტანას.<br><br>
       IBAN: <b style="font-family:monospace">${iban}</b><br><br>
       გადარიცხე BOG-ით და ადმინ პანელში დაადასტ.`,
      'ადმინ პანელი', `${FRONTEND}/admin.html`
    ),
  });
}

// ══════════════════════════════════════════════════════════════
// WALLET DECISION EMAILS — ადმინის დამტკიცება/უარყოფა → მომხმარებელს
//
// UX FIX: საფულის ტრანზაქციების ისტორია (frontend) ახლა მხოლოდ
// სუფთა "დამტკიცებულია / უარყოფილია" ბეჯს აჩვენებს — ადმინის
// დეტალური შენიშვნა (მიზეზი) იქ აღარასდროს ჩანს. სრული დეტალი
// ამ ოთხი ფუნქციით პირდაპირ მომხმარებლის ელ-ფოსტაზე იგზავნება.
// ══════════════════════════════════════════════════════════════
async function sendDepositApprovedEmail(user, amount, ref) {
  if (!user.notif_email || !user.email) return;
  return sendMail({
    to: user.email,
    subject: `✅ ბალანსი შეივსო — ₾${Number(amount).toFixed(2)}`,
    html: wrap(
      'ბალანსის შეტანა დადასტურდა',
      `თქვენი ბალანსის შევსების მოთხოვნა (REF: <b style="font-family:monospace;color:#7c5cff">${ref || '—'}</b>) წარმატებით დადასტურდა.<br><br>
       <div style="font-size:24px;font-weight:800;color:#4ade80;text-align:center;background:#0d0f17;border-radius:10px;padding:14px 0;margin:10px 0">
         +₾${Number(amount).toFixed(2)}
       </div>
       დაემატა თქვენს ბალანსზე და უკვე ხელმისაწვდომია გამოსაყენებლად. მადლობა რომ სარგებლობთ GamerBazar.ge-ით!`,
      'საფულის ნახვა', `${FRONTEND}/?page=wallet`
    ),
  });
}

async function sendDepositRejectedEmail(user, amount, reason, ref) {
  if (!user.notif_email || !user.email) return;
  return sendMail({
    to: user.email,
    subject: `❌ ბალანსის შეტანა ვერ დადასტურდა — REF ${ref || ''}`,
    html: wrap(
      'ბალანსის შეტანა ვერ დადასტურდა',
      `თქვენი ბალანსის შევსების მოთხოვნა (REF: <b style="font-family:monospace;color:#7c5cff">${ref || '—'}</b>) ₾${Number(amount).toFixed(2)}-ის ოდენობით ვერ დამუშავდა.<br><br>
       ${reason ? `<b>მიზეზი:</b> ${reason}` : 'ადმინისტრაციამ დაზუსტებული მიზეზი არ მიუთითა — სავარაუდოდ გადარიცხვა ვერ მოიძებნა ან თანხა არ ემთხვევა.'}<br><br>
       საკითხის გადასაჭრელად დაგვიკავშირდით: <b style="color:#7c5cff">support@gamerbazar.ge</b>`,
      'საფულის ნახვა', `${FRONTEND}/?page=wallet`
    ),
  });
}

async function sendWithdrawApprovedEmail(user, netAmount) {
  if (!user.notif_email || !user.email) return;
  return sendMail({
    to: user.email,
    subject: `✅ გამოტანა დადასტურდა — ₾${Number(netAmount).toFixed(2)}`,
    html: wrap(
      'თანხის გამოტანა დადასტურდა',
      `თქვენი გამოტანის მოთხოვნა დამუშავდა და <b style="color:#4ade80">₾${Number(netAmount).toFixed(2)}</b> გადაირიცხა თქვენს საბანკო ანგარიშზე.<br><br>
       გადარიცხვის ასახვას თქვენს ბანკში შესაძლოა 1-2 სამუშაო დღე დასჭირდეს.`,
      'საფულის ნახვა', `${FRONTEND}/?page=wallet`
    ),
  });
}

async function sendWithdrawRejectedEmail(user, refundAmount, reason) {
  if (!user.notif_email || !user.email) return;
  return sendMail({
    to: user.email,
    subject: `↩️ გამოტანა უარყოფილია — თანხა დაბრუნდა`,
    html: wrap(
      'თანხის გამოტანა უარყოფილია',
      `თქვენი გამოტანის მოთხოვნა ვერ დამუშავდა და <b style="color:#4ade80">₾${Number(refundAmount).toFixed(2)}</b> უკან დაბრუნდა თქვენს GamerBazar ბალანსზე.<br><br>
       ${reason ? `<b>მიზეზი:</b> ${reason}` : 'ადმინისტრაციამ დაზუსტებული მიზეზი არ მიუთითა.'}<br><br>
       საკითხის გადასაჭრელად დაგვიკავშირდით: <b style="color:#7c5cff">support@gamerbazar.ge</b>`,
      'საფულის ნახვა', `${FRONTEND}/?page=wallet`
    ),
  });
}

module.exports = {
  sendMail,
  sendOtpEmail,
  sendOrderCreatedEmail,
  sendOrderConfirmedEmail,
  sendOrderCancelledEmail,
  sendOrderExpiredEmail,
  sendDeliveredEmail,
  send24hReminderEmail,
  sendDisputeOpenedEmail,
  sendDisputeResolvedEmail,
  sendListingRemovedEmail,
  sendListingRejectedEmail,
  sendDepositRequestEmail,
  sendWithdrawRequestEmail,
  sendDepositApprovedEmail,
  sendDepositRejectedEmail,
  sendWithdrawApprovedEmail,
  sendWithdrawRejectedEmail,
};
