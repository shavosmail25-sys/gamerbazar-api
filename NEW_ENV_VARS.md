# ახალი ENV ცვლადები — Cloudinary Migration

ეს ცვლადები დაამატე **Render Dashboard → შენი სერვისი → Environment** ტაბში
(არა `.env` ფაილით — production-ზე `.env` არ გამოიყენება).

```env
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

## საიდან მოვიტანო ეს მონაცემები

1. დარეგისტრირდი (უფასოდ, 25GB) → https://cloudinary.com
2. შესვლის შემდეგ Dashboard-ის თავში ჩანს სამივე მნიშვნელობა:
   - **Cloud name**
   - **API Key**
   - **API Secret** (თავდაპირველად დამალულია, "Reveal"-ზე დააჭირე)
3. დააკოპირე ზუსტად ისე, როგორც ჩანს (whitespace-ის გარეშე)

## Deploy ნაბიჯები

1. ეს 3 ცვლადი დაამატე Render Environment tab-ში → Save
2. ახალი `package.json`-ის push-ის შემდეგ Render გაუშვებს `npm install`-ს
   და `cloudinary` პაკეტი ავტომატურად დაყენდება
3. Restart/redeploy-ის შემდეგ ახალი listing/avatar ატვირთვები
   პირდაპირ Cloudinary-ში წავა — აღარ წაიშლება restart-ზე

## რა შეიცვალა კოდში

- **ახალი ფაილი:** `src/utils/cloudinary.js` — კონფიგი + `uploadBuffer()` / `destroyByUrl()` დამხმარეები
- **`src/routes/listings.js`** — `POST /:id/images` და `DELETE /:id/images`
  ახლა `multer.memoryStorage()`-ს იყენებენ დისკის მაგივრად, ფაილები პირდაპირ
  Cloudinary-ში იტვირთება (`gamerbazar/listings/` ფოლდერში)
- **`src/routes/users.js`** — `POST /me/avatar` იგივე პრინციპით,
  ოღონდ public_id ყოველთვის `avatar_{user_id}` + `overwrite:true` —
  ანუ ყოველი ახალი ატვირთვა თვითონ ანაცვლებს ძველს Cloudinary-ში,
  ცალკე disk cleanup აღარაა საჭირო
- **`package.json`** — დაემატა `cloudinary` დამოკიდებულება

## შენიშვნა — ძველი სურათები

ძველი listing/avatar ჩანაწერები DB-ში, რომლებსაც `images`/`avatar_url`
ჯერ კიდევ `/uploads/...` ბმული აქვთ — ეს ფაილები Render-ის restart-ებზე
უკვე წაშლილია (ანუ "broken image" ისედაც ჩანდა). ახალი ატვირთვები
გამოასწორებს ამას თანდათან, თუმცა თუ გინდა, შეგვიძლია დავწეროთ პატარა
one-off სკრიპტი, რომელიც ასეთ ჩანაწერებს `images=NULL`/ცარიელ მასივად
დააყენებს, რომ frontend-ზე "broken icon" აღარ გამოჩნდეს ცარიელის მაგივრად.

## შენიშვნა — `/uploads` static serving

`src/index.js`-ში `app.use('/uploads', express.static(...))` და
`UPLOAD_DIR` ჯერ კიდევ რჩება კოდში — აღარაფერს აზიანებს, უბრალოდ
ამიერიდან არც listings და არც avatars აღარ წერენ იქ. შეგიძლია ეს
მოგვიანებით საერთოდ ამოშალო, თუ აღარაფერი სხვა მას არ იყენებს.
