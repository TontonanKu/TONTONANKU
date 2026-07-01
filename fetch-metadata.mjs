/* =========================================================
   fetch-metadata.mjs — sistem metadata otomatis TONTONANKU
   ---------------------------------------------------------
   Cara pakai (TETAP SAMA, gak berubah):
     1. Tambah judul baru di data.js (di array donghua/anime),
        minimal isi { title: "Judul" }.
     2. Jalankan:  node fetch-metadata.mjs
     3. Selesai — field yang kosong otomatis terisi.

   Yang didukung:
   - Anime Jepang & Donghua China, masing-masing pakai jalur
     pencarian beda (lihat searchAnime() / searchDonghua()),
     dengan sistem FALLBACK kalau sumber pertama gak ketemu:
       Donghua : AniList(CN)  -> Jikan      -> AniList(semua negara)
       Anime   : Jikan        -> AniList(JP) -> AniList(semua negara)
   - aliases.json — dicek PALING AWAL sebelum ke API, buat judul
     donghua yang punya banyak nama (Inggris/pinyin/singkatan).
     Cocok dua arah: baik judul di data.js maupun alias-nya bisa
     saling dipakai buat nyari satu sama lain.
   - Sinopsis otomatis diterjemahkan EN -> ID. Kalau gagal,
     fallback ke sinopsis Inggris asli (tetap lebih baik dari kosong).
   - TMDb dipakai cuma sebagai fallback TERAKHIR buat poster kalau
     AniList & Jikan dua-duanya gak punya gambar, DAN cuma aktif
     kalau kamu isi TMDB_API_KEY (lihat bagian CONFIG di bawah).
     Gak wajib — script tetap jalan normal tanpa TMDb.

   Field yang TIDAK PERNAH ditimpa kalau sudah ada isinya (kecuali
   FORCE_UPDATE = true, lihat CONFIG di bawah): poster, synopsis,
   genres — sisanya (rating, status, year, studio, type, duration,
   score, + field metadata tambahan di bawah) cuma diisi kalau masih
   kosong/gak ada juga.

   FIELD METADATA TAMBAHAN (opsional, otomatis terisi kalau sumbernya
   punya datanya — data lama yang belum punya field ini TETAP AMAN,
   gak akan error karena semuanya dicek "ada/kosong" dulu sebelum dipakai):
     - alternativeTitles: { romaji, english, japanese, chinese, synonyms }
     - themes, demographics, producers  (array)
     - source, country, premiered, aired, contentRating  (string)

   Struktur data.js TIDAK diubah sama sekali — script ini cuma
   nyisip/ganti field per baris, format lain dibiarin apa adanya.
   ========================================================= */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* ===================== CONFIG ===================== */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "data.js");
const ALIASES_FILE = path.join(__dirname, "aliases.json");

const FORCE_UPDATE = true;     // ← set ke true + jalankan node fetch-metadata.mjs untuk re-fetch entri yang sudah dikoreksi anilistId-nya

// PINNED_IDS — ikat judul yang rawan "ketukar entry" ke AniList ID yang pasti benar.
// Kunci bisa berupa title persis (case-insensitive) ATAU pinyin/alias umum.
// Berlaku sebagai last-resort override SEBELUM title-search dijalankan,
// tapi SETELAH anilistId per-entri di data.js sudah dicek terlebih dahulu.
// Tambahkan entry baru di sini kapan saja bila ditemukan judul lain yang bermasalah.
const PINNED_IDS = {
  "way of choices":          199410, // remake 2026; entry lama: 101409 (2015)
  "ze tian ji":              199410,
  "择天记":                   199410,
  // ← tambahkan kasus baru di bawah baris ini bila diperlukan
};
const DELAY_MS = 500;           // jeda antar request (aman buat Jikan & AniList)
const FETCH_TIMEOUT_MS = 10000; // batas waktu tiap request sebelum dianggap gagal
const MAX_RETRIES = 2;          // percobaan ulang kalau request gagal/timeout

// Opsional: isi API key TMDb di sini atau lewat env var TMDB_API_KEY
// kalau mau TMDb dipakai sebagai fallback poster paling akhir.
// Daftar gratis di https://www.themoviedb.org/settings/api
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";

const JIKAN_BASE = "https://api.jikan.moe/v4";
const ANILIST_BASE = "https://graphql.anilist.co";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TRANSLATE_BASE = "https://translate.googleapis.com/translate_a/single";

/* ===================== UTIL DASAR ===================== */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** retryFetch() — fetch dengan timeout + retry otomatis + backoff */
async function retryFetch(url, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        // kena rate limit -> tunggu lebih lama lalu coba lagi
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) return null; // nyerah, biar caller handle null
      await sleep(500 * Math.pow(2, attempt)); // exponential backoff
    }
  }
  return null;
}

/* ===================== ALIASES ===================== */
async function loadAliases() {
  try {
    const raw = await readFile(ALIASES_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** buildSearchCandidates() — buat daftar judul kandidat, urut dari paling akurat.
 *  Sumber:
 *  1. alternativeTitles yang sudah ada di baris data.js (Chinese/Pinyin untuk donghua
 *     ditambahkan lebih awal biar API dicoba dengan judul asli yang lebih unik)
 *  2. aliases.json (mapping manual)
 *  3. Judul utama dari data.js
 *
 *  Untuk Donghua: Chinese title & Pinyin dimasukkan SEBELUM English title,
 *  karena AniList & Jikan lebih akurat menemukan donghua via judul aslinya
 *  daripada via terjemahan Inggris yang mungkin ambigu.
 */
function buildSearchCandidates(title, aliases, cat, rest = "") {
  // --- 1. Ekstrak dari alternativeTitles yang sudah ada di entry ---
  const existing = {};
  const altMatch = rest.match(/alternativeTitles\s*:\s*\{([^{}]*)\}/);
  if (altMatch) {
    for (const [, key, val] of altMatch[1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) {
      if (val && key !== "synonyms") existing[key] = val;
    }
    const synMatch = altMatch[1].match(/synonyms\s*:\s*\[([^\]]*)\]/);
    if (synMatch) {
      existing._synonyms = [...synMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    }
  }

  const candidates = [];
  const seen = new Set();
  const add = (v) => { if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); candidates.push(v); } };

  // Untuk Donghua: coba Chinese title & Pinyin DULU karena lebih spesifik
  if (cat === "donghua") {
    add(existing.chinese);  // 汉字 — paling spesifik, hampir mustahil ambigu

    // FIX: Data lama mungkin menyimpan Chinese characters di field "japanese"
    // karena MAL/Jikan menyebut native title sebagai title_japanese tanpa
    // membedakan apakah bahasa aslinya JP atau CN. Kalau existing.chinese kosong
    // tapi existing.japanese berisi aksara CJK → pakai sebagai kandidat Chinese.
    // existing.japanese diisi oleh parseAniListItem/queryJikan dari field native title.
    // Tapi karena altM parsing extract dari JSON (key dikuote), existing.japanese
    // sudah berisi VALUE-nya saja (tanpa quote key) — cukup test CJK-nya langsung.
    if (!existing.chinese) {
      const legacyJp = existing.japanese || "";
      if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(legacyJp)) add(legacyJp);
    }

    add(existing.romaji);   // Pinyin (AniList menyimpan Pinyin di field romaji untuk CN)
    add(title);             // baru judul utama di data.js
    add(existing.english);
    (existing._synonyms || []).forEach(add);
  } else {
    add(title);
    add(existing.romaji);   // romaji untuk anime JP
    add(existing.japanese);
    add(existing.english);
    (existing._synonyms || []).forEach(add);
  }

  // --- 2. Tambah dari aliases.json ---
  for (const [key, val] of Object.entries(aliases)) {
    if (key.toLowerCase() === title.toLowerCase()) add(val);
    if (val.toLowerCase() === title.toLowerCase()) add(key);
  }

  // Pastikan title utama selalu ada (kalau belum masuk lewat existing)
  add(title);

  return candidates;
}

/* ===================== NORMALISASI HASIL ===================== */
// Semua fungsi pencarian (Jikan/AniList) mengembalikan bentuk seragam ini,
// biar bagian penyimpanan (saveMetadata) gak perlu peduli sumbernya dari mana.
function emptyMeta() {
  return {
    anilistId: null,  // ID numerik AniList — disimpan ke data.js buat direct lookup di run berikutnya
    poster: "", synopsisEn: "", genres: [], score: null,
    status: "", year: null, studio: "", type: "", duration: "", episodes: null,
    // --- field tambahan (opsional, dibiarkan kosong kalau sumbernya gak punya) ---
    themes: [], demographics: [], producers: [], source: "", country: "",
    premiered: "", aired: "", contentRating: "",
    titleRomaji: "", titleEnglish: "", titleJapanese: "", titleChinese: "", synonyms: [],
  };
}

function mapAniListStatus(s) {
  return { FINISHED: "Completed", RELEASING: "Ongoing", NOT_YET_RELEASED: "Upcoming",
    CANCELLED: "Cancelled", HIATUS: "Hiatus" }[s] || "Unknown";
}
function mapJikanStatus(s) {
  if (!s) return "Unknown";
  if (/currently airing/i.test(s)) return "Ongoing";
  if (/finished airing/i.test(s)) return "Completed";
  if (/not yet aired/i.test(s)) return "Upcoming";
  return "Unknown";
}

/* ===================== SUMBER: JIKAN (MyAnimeList) ===================== */
/** pickBestJikanResult() — scoring sederhana untuk milih hasil terbaik dari
 *  max-5 hasil pencarian Jikan. Tanpa ini, Jikan sering mengembalikan Anime
 *  Jepang di posisi pertama padahal yang dicari adalah Donghua.
 *  Skor lebih tinggi = lebih diutamakan. */
function pickBestJikanResult(results, cat, candidates) {
  if (!results.length) return null;
  const norm = (s) => (s || "").toLowerCase().trim();
  const candNorm = candidates.map(norm);

  const scored = results.map(item => {
    let score = 0;

    // Cocokkan semua judul yang ada di item dengan kandidat kita
    const itemTitles = [
      item.title, item.title_english, item.title_japanese,
      ...(item.titles || []).map(t => t.title),
      ...(item.title_synonyms || []),
    ].filter(Boolean).map(norm);

    for (const cand of candNorm) {
      for (const t of itemTitles) {
        if (t === cand) { score += 20; break; }           // exact match
        if (t.includes(cand) || cand.includes(t)) { score += 8; break; } // partial
      }
    }

    // Preferensi berdasarkan country of origin
    if (cat === "donghua") {
      // Donghua: cek apakah ada producer/licensor yang identik China
      const allOrgs = [
        ...(item.studios || []), ...(item.producers || []), ...(item.licensors || [])
      ].map(o => norm(o.name));
      const cnKeywords = /bilibili|iqiyi|tencent|youku|foch|ruo hong|sparkly|original force|motion magic|motion magic|wonder cat|qingxiang/;
      if (allOrgs.some(o => cnKeywords.test(o))) score += 12;
      // item dengan type ONA lebih mungkin donghua
      if (norm(item.type) === "ona") score += 4;
      // Hindari item yang punya "Doraemon", "One Piece" dll (anime populer JP yg mungkin top result)
      if (/doraemon|one piece|naruto|dragon ball|detective conan/i.test(item.title)) score -= 30;
    } else {
      // Anime JP: pilih yang source-nya JP
      const allOrgs = [
        ...(item.studios || []), ...(item.producers || [])
      ].map(o => norm(o.name));
      // Type TV biasanya anime JP mainstream
      if (norm(item.type) === "tv") score += 4;
    }

    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].item;
}

async function queryJikan(title, cat /* "anime" | "donghua" */, candidates = [title]) {
  const url = `${JIKAN_BASE}/anime?q=${encodeURIComponent(title)}&limit=5`;
  const res = await retryFetch(url);
  if (!res) return null;
  const json = await res.json().catch(() => null);
  const results = json?.data;
  if (!results?.length) return null;

  const item = pickBestJikanResult(results, cat, candidates);

  const meta = emptyMeta();
  meta.poster = item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || "";
  meta.synopsisEn = (item.synopsis || "").replace(/\s*\[Written by MAL Rewrite\]\s*$/i, "").trim();
  // genres LENGKAP — Jikan udah ngembaliin semua genre yang ada di MAL,
  // gak dipotong/dibatasi jumlahnya di sini.
  meta.genres = (item.genres || []).map((g) => g.name);
  meta.score = typeof item.score === "number" ? item.score : null;
  meta.status = mapJikanStatus(item.status);
  meta.year = item.year || item.aired?.prop?.from?.year || null;
  meta.studio = (item.studios && item.studios[0]?.name) || "";
  meta.type = item.type || "";
  meta.duration = item.duration || "";
  meta.episodes = item.episodes || null;

  // --- field tambahan, semua opsional ---
  meta.themes = (item.themes || []).map((t) => t.name);
  meta.demographics = (item.demographics || []).map((d) => d.name);
  meta.producers = (item.producers || []).map((p) => p.name);
  meta.source = item.source || "";
  meta.premiered = item.season && item.year ? `${capitalize(item.season)} ${item.year}` : "";
  meta.aired = item.aired?.string || "";
  meta.contentRating = item.rating || "";

  // alternative titles: Jikan ngasih array "titles" dengan beberapa tipe
  // (Default/Synonym/Japanese/English), plus title_english/title_japanese
  // langsung sebagai shortcut.
  const titleSynonyms = (item.titles || [])
    .filter((t) => t.type === "Synonym")
    .map((t) => t.title);
  if (!titleSynonyms.length && Array.isArray(item.title_synonyms)) {
    titleSynonyms.push(...item.title_synonyms);
  }
  meta.titleRomaji = item.title || (item.titles || []).find((t) => t.type === "Default")?.title || "";
  meta.titleEnglish = item.title_english || (item.titles || []).find((t) => t.type === "English")?.title || "";
  // Field "title_japanese" di MAL/Jikan sebenarnya cuma berarti "judul bahasa
  // asli/native" — buat anime Jepang itu memang huruf Jepang, tapi buat
  // donghua (asal China) isinya justru huruf Mandarin. Makanya dipetakan
  // sesuai kategori (cat) biar Alternative Titles gak salah label.
  const nativeTitle = item.title_japanese || (item.titles || []).find((t) => t.type === "Japanese")?.title || "";
  if (cat === "donghua") {
    meta.titleChinese = nativeTitle;
  } else {
    meta.titleJapanese = nativeTitle;
  }
  meta.synonyms = titleSynonyms;
  return meta;
}
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/* ===================== SUMBER: ANILIST ===================== */
const ANILIST_FIELDS = `
    id
    title { romaji english native }
    synonyms
    coverImage { extraLarge large }
    description(asHtml: false)
    genres
    tags { name category isGeneralSpoiler }
    averageScore
    status
    startDate { year }
    endDate { year }
    studios { nodes { name isAnimationStudio } }
    format
    duration
    episodes
    source
    countryOfOrigin
    season
    seasonYear
`;

const ANILIST_QUERY = `
query ($search: String, $country: CountryOfOrigin) {
  Media(search: $search, type: ANIME, countryOfOrigin: $country) {
    ${ANILIST_FIELDS}
  }
}`;

const ANILIST_QUERY_BY_ID = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    ${ANILIST_FIELDS}
  }
}`;

/** queryAniListById() — ambil metadata berdasarkan AniList ID yang eksplisit.
 *  Solusi untuk kasus Donghua yang namanya mirip Anime Jepang sehingga
 *  pencarian berbasis judul sering salah cocok. Dengan ID numerik yang unik,
 *  hasilnya pasti tepat tanpa resiko pertukaran data. */
async function queryAniListById(anilistId, cat) {
  const res = await retryFetch(ANILIST_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: ANILIST_QUERY_BY_ID, variables: { id: anilistId } }),
  });
  if (!res) return null;
  const json = await res.json().catch(() => null);
  const item = json?.data?.Media;
  if (!item) return null;
  return parseAniListItem(item, cat);
}

/** queryAniList() — pencarian berbasis judul (fallback kalau gak ada ID) */
async function queryAniList(title, country /* "JP" | "CN" | null */, cat) {
  const res = await retryFetch(ANILIST_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query: ANILIST_QUERY,
      variables: { search: title, country: country || undefined },
    }),
  });
  if (!res) return null;
  const json = await res.json().catch(() => null);
  const item = json?.data?.Media;
  if (!item) return null;
  return parseAniListItem(item, cat || (country === "CN" ? "donghua" : "anime"));
}

/** parseAniListItem() — parse satu item dari AniList API response ke emptyMeta().
 *  Dipakai bersama oleh queryAniList() (title search) dan queryAniListById() (ID lookup). */
function parseAniListItem(item, cat) {
  const meta = emptyMeta();

  // ID numerik AniList — disimpan ke data.js buat direct lookup di run berikutnya,
  // jadi gak perlu title search lagi (lebih akurat, gak ada resiko salah cocok).
  meta.anilistId = item.id || null;

  meta.poster = item.coverImage?.extraLarge || item.coverImage?.large || "";
  meta.synopsisEn = (item.description || "").replace(/<[^>]+>/g, "").trim();
  meta.genres = item.genres || [];
  meta.score = typeof item.averageScore === "number" ? Math.round(item.averageScore) / 10 : null;
  meta.status = mapAniListStatus(item.status);
  meta.year = item.startDate?.year || null;

  // Studios dari AniList sekarang tanpa filter "isMain:true" di query, jadi
  // kita bisa pisah sendiri: isAnimationStudio=true → studio utama,
  // isAnimationStudio=false → producers / licensor / dll.
  const allStudios = item.studios?.nodes || [];
  const mainStudios = allStudios.filter(n => n.isAnimationStudio).map(n => n.name);
  const otherStudios = allStudios.filter(n => !n.isAnimationStudio).map(n => n.name);
  meta.studio = mainStudios[0] || allStudios[0]?.name || "";
  meta.producers = otherStudios;

  meta.type = item.format || "";
  meta.duration = item.duration ? `${item.duration} min` : "";
  meta.episodes = item.episodes || null;

  // --- field tambahan ---
  meta.source = mapAniListSource(item.source);
  const originCountry = item.countryOfOrigin;
  meta.country = mapAniListCountry(originCountry);
  meta.premiered = item.season && item.seasonYear
    ? `${capitalize((item.season || "").toLowerCase())} ${item.seasonYear}` : "";

  // Tags dari AniList dipetakan ke themes dan demographics secara terpisah.
  // isGeneralSpoiler=true difilter agar tag yang bersifat spoiler tidak ditampilkan.
  const tags = item.tags || [];
  meta.themes = tags
    .filter(t => !t.isGeneralSpoiler && t.category === "Theme-Other")
    .map(t => t.name);
  meta.demographics = tags
    .filter(t => !t.isGeneralSpoiler && t.category === "Demographic")
    .map(t => t.name);

  meta.titleRomaji = item.title?.romaji || "";
  meta.titleEnglish = item.title?.english || "";
  const isDonghua = cat === "donghua" || originCountry === "CN";
  if (isDonghua) {
    meta.titleChinese = item.title?.native || "";
  } else {
    meta.titleJapanese = item.title?.native || "";
  }
  meta.synonyms = item.synonyms || [];
  return meta;
}
function mapAniListSource(s) {
  if (!s) return "";
  return s.split("_").map((w) => capitalize(w.toLowerCase())).join(" ");
}
function mapAniListCountry(c) {
  return { JP: "Japan", CN: "China", KR: "South Korea", TW: "Taiwan" }[c] || c || "";
}

/* ===================== SUMBER: TMDb (fallback poster terakhir) ===================== */
/** fetchPoster() — cuma dipanggil kalau AniList & Jikan dua-duanya gak ada poster
 *  DAN TMDB_API_KEY diisi. TMDb gak punya database anime selengkap AniList/MAL,
 *  jadi ini murni fallback darurat, bukan sumber utama. */
async function fetchPoster(title) {
  if (!TMDB_API_KEY) return "";
  const url = `${TMDB_BASE}/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
  const res = await retryFetch(url);
  if (!res) return "";
  const json = await res.json().catch(() => null);
  const item = json?.results?.[0];
  if (!item?.poster_path) return "";
  return `https://image.tmdb.org/t/p/original${item.poster_path}`;
}

/* ===================== PENCARIAN PER KATEGORI (+ FALLBACK) ===================== */

/** resolvePinnedId() — cek apakah salah satu kandidat judul cocok di PINNED_IDS.
 *  Mengembalikan numeric ID kalau ada, atau null kalau tidak ada yang cocok.
 *  Prioritas: anilistId eksplisit dari data.js > PINNED_IDS > title-search. */
function resolvePinnedId(candidates, explicitId) {
  if (explicitId) return explicitId; // ID manual di data.js selalu menang
  for (const t of candidates) {
    const pinned = PINNED_IDS[t.toLowerCase().trim()];
    if (pinned) return pinned;
  }
  return null;
}

/** searchDonghua() — urutan: ID-lookup (pinned/explicit) → AniList(CN) → AniList(all, divalidasi negara)
 *  Kalau anilistId=null, ID lookup dilewati (sudah dicoba di main sebelum fungsi ini dipanggil). */
async function searchDonghua(candidates, anilistId) {
  // ID lookup hanya kalau anilistId bukan null (berarti belum dicoba di main)
  if (anilistId !== null) {
    const resolvedId = resolvePinnedId(candidates, anilistId);
    if (resolvedId) {
      console.log(`    → using AniList ID ${resolvedId} (${resolvedId === anilistId ? "per-entry pin" : "PINNED_IDS"})`);
      const meta = await queryAniListById(resolvedId, "donghua");
      if (meta) return meta;
      await sleep(DELAY_MS);
    }
  }

  // 2. Title-search dengan validasi negara ketat — tolak hasil dari Jepang.
  for (const title of candidates) {
    let meta = await queryAniList(title, "CN", "donghua");
    if (meta) return meta;
    await sleep(DELAY_MS);

    meta = await queryAniList(title, null, "donghua");
    // Validasi: tolak kalau hasilnya dari Jepang (mencegah ketukar entry seperti sebelumnya).
    if (meta && meta.country === "Japan") { meta = null; }
    if (meta) return meta;
    await sleep(DELAY_MS);
  }
  return null;
}

/** searchAnime() — urutan: ID-lookup (pinned/explicit) → Jikan → AniList(JP) → AniList(all)
 *  Kalau anilistId=null, ID lookup dilewati (sudah dicoba di main sebelum fungsi ini dipanggil). */
async function searchAnime(candidates, anilistId) {
  if (anilistId !== null) {
    const resolvedId = resolvePinnedId(candidates, anilistId);
    if (resolvedId) {
      console.log(`    → using AniList ID ${resolvedId} (${resolvedId === anilistId ? "per-entry pin" : "PINNED_IDS"})`);
      const meta = await queryAniListById(resolvedId, "anime");
      if (meta) return meta;
      await sleep(DELAY_MS);
    }
  }

  for (const title of candidates) {
    let meta = await queryJikan(title, "anime", candidates);
    if (meta) return meta;
    await sleep(DELAY_MS);

    meta = await queryAniList(title, "JP", "anime");
    if (meta) return meta;
    await sleep(DELAY_MS);

    meta = await queryAniList(title, null, "anime");
    if (meta) return meta;
    await sleep(DELAY_MS);
  }
  return null;
}

/* ===================== TERJEMAHAN SINOPSIS ===================== */
/** translateSynopsis() — EN -> ID pakai endpoint Google Translate gratis
 *  (gak resmi/gak butuh API key, tapi bisa berubah sewaktu-waktu).
 *  Kalau gagal, return null -> caller fallback ke teks Inggris asli. */
async function translateSynopsis(text) {
  if (!text) return null;
  try {
    const url = `${TRANSLATE_BASE}?client=gtx&sl=en&tl=id&dt=t&q=${encodeURIComponent(text)}`;
    const res = await retryFetch(url, {}, 1);
    if (!res) return null;
    const json = await res.json().catch(() => null);
    if (!json || !Array.isArray(json[0])) return null;
    return json[0].map((chunk) => chunk[0]).join("").trim() || null;
  } catch {
    return null;
  }
}

/* ===================== PARSING & PENYIMPANAN data.js ===================== */
// Cuma proses baris satu-liner berbentuk { title: "...", ... }.
// Entri kompleks (pakai "seasons:" / generateEpisodes()) dilewatin
// biar struktur khususnya gak rusak.
const LINE_RE = /^(\s*)\{\s*title:\s*"((?:[^"\\]|\\.)*)"(.*)\},?\s*$/;

function fieldPattern(field, kind) {
  if (kind === "array") return new RegExp(field + "\\s*:\\s*(\\[[^\\]]*\\])");
  if (kind === "object") return new RegExp(field + "\\s*:\\s*(\\{[^{}]*\\})");
  if (kind === "number") return new RegExp(field + "\\s*:\\s*(-?\\d+(?:\\.\\d+)?)");
  return new RegExp(field + "\\s*:\\s*(\"(?:[^\"\\\\]|\\\\.)*\")");
}

function hasField(rest, field, kind) {
  const m = rest.match(fieldPattern(field, kind));
  if (!m) return { present: false };
  const empty = m[1] === '""' || m[1] === "[]" || m[1] === "{}";
  return { present: true, empty, raw: m[0] };
}

function serializeValue(value, kind) {
  if (kind === "number") return String(value);
  return JSON.stringify(value); // string & array sama-sama lewat JSON.stringify
}

/** saveMetadata() — terapkan metadata ke satu baris entri.
 *  - FORCE_UPDATE=false (default): cuma isi field yang masih kosong,
 *    TANPA pernah menimpa field yang sudah ada isinya (perilaku lama).
 *  - FORCE_UPDATE=true: field metadata (poster, synopsis, genres, score,
 *    rating, status, year, studio, type, duration) SELALU ditimpa dengan
 *    hasil terbaru dari API. Field manual (title, eps, season, releaseDay,
 *    episodes, videoUrl, dll) tetap tidak pernah disentuh karena memang
 *    tidak pernah masuk daftar `apply()` di bawah ini. */
// Field-field ini SELALU ditimpa saat FORCE_UPDATE=true, karena data API
// lebih akurat dari data lama (terutama poster URL yang bisa berubah di CDN).
const FORCE_FIELDS = new Set([
  "poster", "alternativeTitles", "score", "rating", "studio", "genres",
  "synopsis", "producers", "source", "aired", "contentRating", "duration", "type",
]);

function saveMetadata(rest, meta, synopsisId) {
  let newRest = rest;
  const toInsert = [];
  const filledFields = [];

  const apply = (field, kind, value) => {
    if (value === null || value === undefined || value === "") return;
    if (Array.isArray(value) && value.length === 0) return;
    if (kind === "object" && (!value || Object.keys(value).length === 0)) return;

    const info = hasField(rest, field, kind);
    // Lewati kalau field sudah ada DAN:
    //   - FORCE_UPDATE=false (perilaku lama, tidak pernah menimpa field yang terisi)
    //   - ATAU FORCE_UPDATE=true TAPI field ini tidak masuk FORCE_FIELDS
    const shouldForce = FORCE_UPDATE && FORCE_FIELDS.has(field);
    if (info.present && !info.empty && !shouldForce) return;

    const serialized = `${field}: ${serializeValue(value, kind)}`;
    if (info.present) {
      // PENTING: gunakan function replacer — bukan string literal — agar karakter
      // khusus dalam replacement string ($&, $1, $$, $`, $') tidak salah
      // diinterpretasi oleh JavaScript. Bug ini yang menyebabkan poster URL lama
      // terkadang tidak terganti meski FORCE_UPDATE=true.
      newRest = newRest.replace(info.raw, () => serialized);
    } else {
      toInsert.push(serialized);
    }
    filledFields.push(field);
  };

  // anilistId: tulis sekali kalau belum ada, ATAU timpa kalau nilai yang ada
  // di data.js BERBEDA dari yang baru dikembalikan API (artinya entry sebelumnya
  // kebetulan resolve ke ID yang salah, mis. 101409 vs 199410 untuk Ze Tian Ji).
  // Kalau sama persis, tidak perlu ditimpa — tidak ada perubahan nyata.
  if (meta.anilistId) {
    const existing = hasField(rest, "anilistId", "number");
    const existingVal = existing.present ? parseInt((existing.raw || "").replace(/[^0-9]/g, ""), 10) : null;
    if (!existing.present || existing.empty || existingVal !== meta.anilistId) {
      apply("anilistId", "number", meta.anilistId);
    }
  }

  apply("poster", "string", meta.poster);
  apply("synopsis", "string", synopsisId || meta.synopsisEn);
  apply("genres", "array", meta.genres);
  apply("score", "number", meta.score);
  apply("rating", "number", meta.score);
  apply("status", "string", meta.status);
  apply("year", "number", meta.year);
  apply("studio", "string", meta.studio || "Unknown");
  apply("type", "string", meta.type);
  apply("duration", "string", meta.duration);

  // --- field tambahan ---
  apply("themes", "array", meta.themes);
  apply("demographics", "array", meta.demographics);
  apply("producers", "array", meta.producers);
  apply("source", "string", meta.source);
  apply("country", "string", meta.country);
  apply("premiered", "string", meta.premiered);
  apply("aired", "string", meta.aired);
  apply("contentRating", "string", meta.contentRating);

  const alternativeTitles = {};
  if (meta.titleRomaji) alternativeTitles.romaji = meta.titleRomaji;
  if (meta.titleEnglish) alternativeTitles.english = meta.titleEnglish;
  if (meta.titleJapanese) alternativeTitles.japanese = meta.titleJapanese;
  if (meta.titleChinese) alternativeTitles.chinese = meta.titleChinese;
  if (meta.synonyms && meta.synonyms.length) alternativeTitles.synonyms = meta.synonyms;
  apply("alternativeTitles", "object", alternativeTitles);

  if (toInsert.length) {
    newRest = newRest.replace(/\s*$/, "") + ", " + toInsert.join(", ");
  }
  return { newRest, changed: filledFields.length > 0, writtenFields: filledFields };
}

/** hasCategoryMismatch() — deteksi data lama yang labelnya salah karena
 *  MAL/Jikan menyimpan native title (Mandarin) di field "title_japanese".
 *
 *  Konkret: donghua seperti "Way Of Choices" punya alternativeTitles.japanese
 *  berisi "择天记" (aksara Mandarin) padahal seharusnya alternativeTitles.chinese.
 *  Ini terjadi sebelum bug-fix label diterapkan, dan karena poster/synopsis/genres
 *  sudah terisi, entryNeedsWork() lama tidak mendeteksinya → entry di-skip selamanya.
 *
 *  Dengan deteksi ini, entry yang punya CJK di field "japanese" tanpa field "chinese"
 *  (untuk donghua) atau sebaliknya (untuk anime) akan di-flag sebagai "perlu kerja"
 *  sehingga alternativeTitles-nya di-refetch dan di-relabel dengan benar. */
function hasCategoryMismatch(rest, cat) {
  const altM = rest.match(/alternativeTitles\s*:\s*\{([^{}]*)\}/);
  if (!altM) return false;
  const inner = altM[1];
  if (cat === "donghua") {
    // Kunci dalam alternativeTitles pakai JSON format → "key":"value" (dikuote),
    // bukan plain JS object keys. Regex harus sertakan quote di sekeliling key-nya.
    const hasChinese = /"chinese"\s*:/.test(inner);
    if (hasChinese) return false; // sudah benar, tidak perlu relabel
    const jpM = inner.match(/"japanese"\s*:\s*"([^"]+)"/);
    // "japanese" berisi aksara CJK (Mandarin) → sebenarnya Chinese title, perlu relabel
    return !!(jpM && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(jpM[1]));
  }
  return false;
}

function entryNeedsWork(rest, cat) {
  // Cek field wajib yang masih kosong
  const checks = [
    hasField(rest, "poster", "string"),
    hasField(rest, "synopsis", "string"),
    hasField(rest, "genres", "array"),
  ];
  if (checks.some((c) => !c.present || c.empty)) return true;
  // Tambahan: deteksi label judul yang salah (Chinese chars di field "japanese")
  // — fix untuk entri donghua lama yang lolos karena poster/synopsis/genres sudah terisi.
  if (hasCategoryMismatch(rest, cat)) return true;
  return false;
}

/* ===================== MAIN ===================== */

/** metaIsUsable() — cek apakah meta yang dikembalikan API benar-benar punya data
 *  yang berguna untuk ditulis. AniList kadang mengembalikan entry "stub" untuk
 *  show yang belum rilis (upcoming/not_yet_released) yang punya ID tapi tidak punya
 *  poster, synopsis, atau genres. Kalau itu yang terjadi, jangan tulis apa pun
 *  dan jangan tampilkan ✔ Success — itu menyesatkan. */
function metaIsUsable(meta) {
  return !!(meta.poster || meta.synopsisEn || (meta.genres && meta.genres.length > 0));
}

/** logMetaSummary() — cetak ringkasan isi meta ke stdout.
 *  Aktifkan dengan menjalankan: DEBUG=1 node fetch-metadata.mjs */
function logMetaSummary(title, meta) {
  const short = (s, n = 70) => s ? (s.length > n ? s.slice(0, n) + "…" : s) : "(kosong)";
  console.log(`  [DEBUG] meta untuk "${title}":`);
  console.log(`    anilistId   : ${meta.anilistId ?? "(null)"}`);
  console.log(`    poster      : ${short(meta.poster)}`);
  console.log(`    synopsisEn  : ${short(meta.synopsisEn)}`);
  console.log(`    genres      : ${JSON.stringify(meta.genres)}`);
  console.log(`    score       : ${meta.score ?? "(null)"}`);
  console.log(`    status      : ${meta.status || "(kosong)"}`);
  console.log(`    studio      : ${meta.studio || "(kosong)"}`);
  console.log(`    country     : ${meta.country || "(kosong)"}`);
  console.log(`    titleRomaji : ${meta.titleRomaji || "(kosong)"}`);
  console.log(`    titleChinese: ${meta.titleChinese || "(kosong)"}`);
  console.log(`    titleJapanese:${meta.titleJapanese || "(kosong)"}`);
}

const DEBUG = process.env.DEBUG === "1";

async function main() {
  const [original, aliases] = await Promise.all([
    readFile(DATA_FILE, "utf-8"),
    loadAliases(),
  ]);
  const lines = original.split("\n");

  let context = null; // "donghua" | "anime" | null
  let success = 0, failed = 0, skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "donghua: [") { context = "donghua"; continue; }
    if (trimmed === "anime: [") { context = "anime"; continue; }
    if (trimmed === "};") { context = null; continue; }

    const match = lines[i].match(LINE_RE);
    if (!match || !context) continue;

    const [, indent, title, rest] = match;
    if (/seasons\s*:|generateEpisodes\s*\(/.test(rest)) continue; // entri kompleks, skip

    if (!FORCE_UPDATE && !entryNeedsWork(rest, context)) { skipped++; continue; }

    // anilistId per-entri: field opsional yang bisa ditambahkan manual ke data.js
    // untuk memaksa lookup berdasarkan ID AniList yang pasti benar, bukan
    // title-matching yang rawan salah (khususnya untuk Donghua).
    // Contoh: { title: "Legend Of Martial Immortal", anilistId: 152889, eps: 127, ... }
    const anilistIdMatch = rest.match(/\banilistId\s*:\s*(\d+)/);
    const anilistId = anilistIdMatch ? parseInt(anilistIdMatch[1], 10) : null;

    const candidates = buildSearchCandidates(title, aliases, context, rest);

    // ---------- ID lookup (per-entry anilistId atau PINNED_IDS) ----------
    // Dipisah dari searchDonghua/searchAnime agar kita bisa logging hasilnya
    // sebelum melanjutkan ke title-search jika ID lookup gagal.
    const resolvedId = resolvePinnedId(candidates, anilistId);
    let meta = null;

    if (resolvedId) {
      console.log(`    → AniList ID ${resolvedId} (${resolvedId === anilistId ? "per-entry pin" : "PINNED_IDS"})`);
      const byId = await (context === "donghua"
        ? queryAniListById(resolvedId, "donghua")
        : queryAniListById(resolvedId, "anime"));

      if (!byId) {
        // ID ditemukan tapi API gagal / entry tidak exist di AniList
        console.log(`\x1b[33m    ⚠  queryAniListById(${resolvedId}) mengembalikan null.\x1b[0m`);
        console.log(`       Kemungkinan: ID tidak valid, entry di-unpublish, atau timeout.`);
        console.log(`       Melanjutkan ke title-search sebagai fallback…`);
      } else if (!metaIsUsable(byId)) {
        // ID valid, entry ada di AniList, tapi datanya kosong (stub/upcoming)
        console.log(`\x1b[33m    ⚠  AniList ID ${resolvedId} mengembalikan data stub (tidak ada poster/synopsis/genres).\x1b[0m`);
        console.log(`       Entry mungkin belum diterbitkan resmi di AniList (status: ${byId.status || "?"}).`);
        console.log(`       Melanjutkan ke title-search sebagai fallback…`);
        if (DEBUG) logMetaSummary(title, byId);
      } else {
        meta = byId;
      }
      await sleep(DELAY_MS);
    }

    // ---------- title-search fallback jika ID lookup tidak menghasilkan data ----------
    if (!meta) {
      meta = context === "donghua"
        ? await searchDonghua(candidates, null)   // null = skip ID lookup di dalam searchDonghua (sudah dicoba di atas)
        : await searchAnime(candidates, null);
    }

    // fallback terakhir: kalau ketemu cuma kurang poster, coba TMDb
    if (meta && !meta.poster && TMDB_API_KEY) {
      meta.poster = await fetchPoster(title);
    }

    if (!meta) {
      console.log(`\x1b[31m✖ Metadata not found : ${title}\x1b[0m`);
      failed++;
      await sleep(DELAY_MS);
      continue;
    }

    // Cek apakah meta punya data yang berguna — kalau tidak, jangan tulis apa pun
    // dan jangan cetak ✔ (yang menyesatkan). Ini terjadi kalau AniList ID valid
    // tapi entry masih stub/upcoming tanpa poster, synopsis, atau genres.
    if (!metaIsUsable(meta)) {
      console.log(`\x1b[31m✖ Data tidak berguna : ${title}\x1b[0m`);
      console.log(`   Semua sumber (AniList/Jikan) tidak mengembalikan poster, synopsis, atau genres.`);
      if (meta.anilistId) {
        console.log(`   AniList ID ${meta.anilistId} ada tapi datanya kosong — cek apakah show ini sudah tayang.`);
      }
      if (DEBUG) logMetaSummary(title, meta);
      failed++;
      await sleep(DELAY_MS);
      continue;
    }

    if (DEBUG) logMetaSummary(title, meta);

    let synopsisId = null;
    if (meta.synopsisEn) {
      synopsisId = await translateSynopsis(meta.synopsisEn);
    }

    // FIX: kalau entry ini di-flag karena label salah (CJK di "japanese" untuk donghua),
    // hapus dulu alternativeTitles lama dari rest sebelum saveMetadata() menulis ulang
    // dengan label yang benar — kalau tidak, apply() akan skip karena field sudah ada.
    let effectiveRest = rest;
    const needsRelabel = !FORCE_UPDATE && hasCategoryMismatch(rest, context);
    if (needsRelabel) {
      effectiveRest = rest.replace(/,\s*alternativeTitles\s*:\s*\{[^{}]*\}/, "");
      // Info ke user: poster/synopsis lama dipertahankan (sudah ada isinya).
      // Kalau poster masih terlihat salah, jalankan ulang dengan FORCE_UPDATE=true.
      console.log(`\x1b[33m⚠  ${title}: alternativeTitles akan direlabel (chinese ← japanese). Jalankan FORCE_UPDATE=true jika poster/synopsis juga perlu diperbarui.\x1b[0m`);
    }

    const { newRest, changed, writtenFields } = saveMetadata(effectiveRest, meta, synopsisId);
    if (changed) {
      lines[i] = `${indent}{ title: "${title}"${newRest} },`;

      // Bedakan antara "hanya anilistId yang ditulis" vs "data metadata sungguhan ditulis".
      // Kalau cuma anilistId → ini bukan kesuksesan sejati, mungkin berarti semua
      // field lain sudah ada isinya dan FORCE_UPDATE=false, atau meta terlalu minim.
      const realFields = writtenFields.filter(f => f !== "anilistId");
      if (realFields.length === 0) {
        console.log(`\x1b[33m⚠  ${title}: hanya anilistId yang ditulis (${meta.anilistId})\x1b[0m`);
        console.log(`   Field lain sudah terisi atau meta terlalu minim. Jalankan DEBUG=1 untuk detail.`);
      } else {
        console.log(`\x1b[32m✔ ${title}\x1b[0m`);
        if (DEBUG) console.log(`   Field ditulis: ${writtenFields.join(", ")}`);
      }
      success++;
    } else {
      if (DEBUG) {
        console.log(`  [SKIP] ${title}: tidak ada field yang berubah`);
        console.log(`   (Semua field sudah terisi & FORCE_UPDATE=false, atau semua value dari API kosong)`);
      }
      skipped++;
    }

    await sleep(DELAY_MS);
  }

  await writeFile(DATA_FILE, lines.join("\n"), "utf-8");

  console.log("\n========================");
  console.log(`Success : ${success}`);
  console.log(`Failed  : ${failed}`);
  console.log(`Skipped : ${skipped}`);
  console.log("========================");
  if (!TMDB_API_KEY) {
    console.log("(Info: TMDB_API_KEY belum diisi — fallback poster TMDb gak dipakai. Opsional, lihat bagian CONFIG di atas file ini.)");
  }
}

main().catch((err) => {
  console.error("Script gagal jalan:", err);
  process.exit(1);
});
