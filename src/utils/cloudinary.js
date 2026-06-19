// src/utils/cloudinary.js
// სურათების ატვირთვა Cloudinary-ზე — Render-ის ephemeral disk-ის ნაცვლად
// უფასო tier: 25GB storage, 25GB bandwidth/თვე
//
// Setup (ერთჯერადი):
//   1. cloudinary.com → Sign Up → Dashboard-ში Cloud Name, API Key, API Secret
//   2. Render env-ში დაამატე:
//        CLOUDINARY_CLOUD_NAME=...
//        CLOUDINARY_API_KEY=...
//        CLOUDINARY_API_SECRET=...
//
// npm install cloudinary

'use strict';

let cloudinaryConfigured = false;

function getCloudinary() {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return null;

  const cloudinary = require('cloudinary').v2;

  if (!cloudinaryConfigured) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key:    process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure:     true,
    });
    cloudinaryConfigured = true;
  }

  return cloudinary;
}

// ── Buffer/Stream → Cloudinary upload ─────────────────────────
// file: multer file object (buffer ან path)
// folder: 'gamerbazar/avatars' ან 'gamerbazar/listings'
// publicId: optional — null = Cloudinary ავტომ. განსაზ.
async function uploadFile(file, folder = 'gamerbazar', publicId = null) {
  const cld = getCloudinary();

  if (!cld) {
    // Cloudinary არ არის კონფ. — local path ვიყენებთ (dev)
    return null; // caller ამოწმებს და local-ს გამოიყენებს
  }

  return new Promise((resolve, reject) => {
    const opts = {
      folder,
      resource_type: 'image',
      transformation: [
        { quality: 'auto', fetch_format: 'auto' }, // WebP/AVIF ავტო
      ],
    };
    if (publicId) opts.public_id = publicId;

    const stream = cld.uploader.upload_stream(opts, (error, result) => {
      if (error) reject(error);
      else resolve(result.secure_url); // https://res.cloudinary.com/...
    });

    // multer memoryStorage-დან buffer
    if (file.buffer) {
      const { Readable } = require('stream');
      Readable.from(file.buffer).pipe(stream);
    } else if (file.path) {
      // diskStorage-დან path
      const fs = require('fs');
      fs.createReadStream(file.path).pipe(stream);
      // ატვირთვის შემდეგ local ფაილი წაიშლება caller-ში
    } else {
      reject(new Error('file has neither buffer nor path'));
    }
  });
}

// ── Cloudinary URL-ის წაშლა ────────────────────────────────────
async function deleteFile(url) {
  const cld = getCloudinary();
  if (!cld || !url || !url.includes('cloudinary.com')) return;

  try {
    // URL-დან public_id ამოვიღოთ
    // მაგ: https://res.cloudinary.com/demo/image/upload/v123/gamerbazar/listings/abc.webp
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
    if (match) {
      await cld.uploader.destroy(match[1]);
    }
  } catch (e) {
    console.error('cloudinary delete error:', e.message);
  }
}

module.exports = { uploadFile, deleteFile, getCloudinary };
