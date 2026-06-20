// src/utils/cloudinary.js
// Cloudinary კონფიგ. + დამხმარე ფუნქციები სურათების ასატვირთად.
// Render-ის filesystem ephemeral-ია (deploy/restart/sleep შემდეგ ყველაფერი იშლება),
// ამიტომ ყველა listing/avatar სურათი ახლა პირდაპირ Cloudinary-ში იტვირთება.
//
// საჭირო ENV ცვლადები (.env ლოკალურად / Render → Environment tab production-ში):
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
// (იხ. NEW_ENV_VARS.md)

'use strict';

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

// ── კონფიგურაციის შემოწმება ─────────────────────────────────
// route-ებში გამოვიყენებთ, რომ ნათელი 503 დავაბრუნოთ env vars-ის
// დადგენამდე (cloudinary-ის SDK-ი ჩუმად "ვერაფერს ვშლი/ვტვირთავ"
// აბრუნებს, ეს ცუდი UX იქნებოდა debug-ისთვის)
function isConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

// ── ბუფერის ატვირთვა (multer memoryStorage-დან) ──────────────
// არ ვწერთ დისკზე საერთოდ — file.buffer პირდაპირ stream-დება Cloudinary-ში
function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}

// ── public_id-ის ამოღება secure_url-დან (წასაშლელად საჭირო) ──
// მაგ: https://res.cloudinary.com/demo/image/upload/v1718000000/gamerbazar/listings/listing_x.jpg
//   →  gamerbazar/listings/listing_x
function publicIdFromUrl(url) {
  const m = String(url).match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+(?:\?.*)?$/);
  return m ? m[1] : null;
}

// ── URL-ით წაშლა ──────────────────────────────────────────────
async function destroyByUrl(url) {
  const publicId = publicIdFromUrl(url);
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (e) {
    console.error('cloudinary destroy error:', e.message);
  }
}

module.exports = { cloudinary, isConfigured, uploadBuffer, publicIdFromUrl, destroyByUrl };
