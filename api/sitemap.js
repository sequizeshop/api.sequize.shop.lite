// Dynamic XML sitemap for every active 40-character Firebase product ID.
const admin = require("firebase-admin");
const DATABASE_URL = "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";
const PRODUCT_ID_PATTERN = /^[A-Za-z0-9]{40}$/;
const SITE_URL = "https://www.sequize.shop";
function getDatabase() {
  if (admin.apps.length) return admin.database();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is missing.");
  const account = JSON.parse(raw);
  if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(account), databaseURL: DATABASE_URL });
  return admin.database();
}
const xml = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
module.exports = async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).send("Method not allowed"); }
  try {
    const db = getDatabase();
    const [productsSnap, removedSnap] = await Promise.all([db.ref("products").once("value"), db.ref("removedProducts").once("value")]);
    const products = productsSnap.val() || {}; const removed = removedSnap.val() || {};
    const entries = [`<url><loc>${SITE_URL}/</loc></url>`];
    for (const [id, product] of Object.entries(products)) {
      if (!PRODUCT_ID_PATTERN.test(id) || !product || typeof product !== "object" || removed[id]) continue;
      const loc = `${SITE_URL}/product?id=${encodeURIComponent(id)}`;
      const ts = Number(product.updatedAt || product.createdAt || 0);
      const lastmod = ts > 0 && Number.isFinite(ts) ? `<lastmod>${new Date(ts).toISOString()}</lastmod>` : "";
      entries.push(`<url><loc>${xml(loc)}</loc>${lastmod}</url>`);
    }
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=3600");
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>`);
  } catch (error) { console.error("Sitemap generation error:", error); return res.status(500).send("Sitemap could not be generated."); }
};
