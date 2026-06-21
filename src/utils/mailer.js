// src/utils/mailer.js
// Email შეტყობინებები — nodemailer + Gmail SMTP
'use strict';

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_USER, SMTP_PASS, SMTP_HOST, SMTP_PORT } = process.env;
  if (!SMTP_USER || !SMTP_PASS) return null; // არ არის კონფიგ. — silent skip

  transporter = nodemailer.createTransport({
    host: SMTP_HOST || 'smtp.gmail.com',
    port: Number(SMTP_PORT) || 465,
    secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return transporter;
}

// ── ბაზის ფუნქცია — html email გაგზავნა ────────────────────────
async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  if (!t || !to) return { sent: false };

  try {
    await t.sendMail({
      from: `"GamerBazar.ge" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });
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

module.exports = {
  sendMail,
  sendOrderCreatedEmail,
  sendOrderConfirmedEmail,
  sendOrderCancelledEmail,
  sendOrderExpiredEmail,
  sendDeliveredEmail,
  send24hReminderEmail,
  sendDisputeOpenedEmail,
  sendDisputeResolvedEmail,
};
