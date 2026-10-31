// api/admin/productData.js
//
// One function for two admin resources:
//   /api/admin/productData?resource=products
//   /api/admin/productData?resource=discounts
//
// PUBLIC:
//   GET ?resource=discounts[&email=...]
//
// ADMIN (Authorization: Bearer ADMIN_API_KEY):
//   Everything else.
//
// PRICE TOGGLE (products resource, PUT/POST):
//   { "action": "togglePrices" }      -> reduced? restore : reduce by 70%
//   { "action": "reduceAllPrices" }   -> reduce only
//   { "action": "restoreAllPrices" }  -> restore only
//
// Reduced prices are written as plain normal prices. NOTHING is marked
// on the product objects (no flags, no discountPercentage changes).
// Original prices are kept in separate private paths:
//   adminPriceBackup/{productId}
//   adminPriceState
// Nothing else in your app reads these paths.
//
// CATEGORY SPECIFICATIONS:
//   Products can carry a "specifications" object, e.g.
//   { "Processor": "Snapdragon 680", "RAM": "6 GB" }
//   Labels and values are plain strings (sanitised by cleanSpecs below).
//
// Environment variables:
//   ADMIN_API_KEY
//   FIREBASE_SERVICE_ACCOUNT

"use strict";

const admin = require("firebase-admin");
const crypto = require("crypto");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const DISCOUNTS_PATH = "discounts";

const ID_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9]{40}$/;

/* ---------------- PRICE REDUCTION CONFIG ---------------- */

const PRICE_REDUCTION_PERCENT = 70;
const PRICE_REMAINING = 1 - PRICE_REDUCTION_PERCENT / 100;

// Every reduced price stays below 30000.
const MAX_PRODUCT_PRICE_INR = 29999;

// Same conversion rate used by the cart API.
const USD_TO_INR = 85;

const MAX_PRODUCT_PRICE_USD = MAX_PRODUCT_PRICE_INR / USD_TO_INR;

// Private paths (not on product objects).
const PRICE_BACKUP_PATH = "adminPriceBackup";
const PRICE_STATE_PATH = "adminPriceState";

// Fields an older version of this API may have written on products.
const LEGACY_MARKER_FIELDS = [
  "priceReduction70Applied",
  "priceReduction70Percent",
  "priceReduction70At"
];

/* ---------------- Firebase ---------------- */

function initializeFirebase() {
  if (admin.apps.length) return admin.database();

  const value = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!value) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT environment variable is missing."
    );
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(value);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT must contain valid JSON.");
  }

  if (serviceAccount.private_key) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL
  });

  return admin.database();
}

/* ---------------- Helpers ---------------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

function isAuthorized(req) {
  const expected = process.env.ADMIN_API_KEY;

  if (!expected) {
    throw new HttpError(500, "ADMIN_API_KEY is not configured on the server.");
  }

  const header = String(req.headers.authorization || "");

  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  const a = Buffer.from(token);
  const b = Buffer.from(expected);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function generateProductId() {
  const bytes = crypto.randomBytes(40);

  let id = "";

  for (let i = 0; i < 40; i++) {
    id += ID_CHARS[bytes[i] % ID_CHARS.length];
  }

  return id;
}

function str(value, max, label, required = false) {
  const s = value == null ? "" : String(value).trim();

  if (required && !s) {
    throw new HttpError(400, label + " is required.");
  }

  if (s.length > max) {
    throw new HttpError(400, label + " is too long (max " + max + ").");
  }

  return s;
}

function num(
  value,
  label,
  { min = 0, max = Infinity, integer = false, fallback = 0 } = {}
) {
  if (value === "" || value == null) return fallback;

  const n = Number(value);

  if (
    !Number.isFinite(n) ||
    n < min ||
    n > max ||
    (integer && !Number.isInteger(n))
  ) {
    throw new HttpError(400, label + " is invalid.");
  }

  return n;
}

function list(value, max, itemMax, label) {
  let arr = value;

  if (typeof arr === "string") {
    arr = arr.split(/[\n,]+/);
  }

  if (!Array.isArray(arr)) return [];

  const out = arr
    .map(x => String(x == null ? "" : x).trim())
    .filter(Boolean);

  if (out.length > max) {
    throw new HttpError(400, "Too many items in " + label + ".");
  }

  out.forEach(x => {
    if (x.length > itemMax) {
      throw new HttpError(
        400,
        label + " contains a value that is too long."
      );
    }
  });

  return out;
}

function urlOrEmpty(value, label) {
  const s = str(value, 2000, label);

  if (s && !/^https?:\/\//i.test(s)) {
    throw new HttpError(400, label + " must start with http:// or https://");
  }

  return s;
}

function roundPrice(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/* Category specifications: { label: value }.
   Firebase keys cannot contain . # $ [ ] / so those are replaced. */
function cleanSpecs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const out = {};
  let count = 0;

  Object.keys(value).forEach(k => {
    const key = String(k).replace(/[.#$\[\]\/]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    const val = String(value[k] == null ? "" : value[k]).trim().slice(0, 200);

    if (!key || !val) return;

    if (++count > 40) {
      throw new HttpError(400, "Too many specifications (max 40).");
    }

    out[key] = val;
  });

  return count ? out : null;
}

/* ---------------- Product Validation ---------------- */

function cleanProduct(input) {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, "Product data is missing.");
  }

  const sourceId = String(input.sourceId == null ? "" : input.sourceId).trim();

  if (sourceId && !/^\d+$/.test(sourceId)) {
    throw new HttpError(400, "Source ID must be a number.");
  }

  const images = list(input.images, 30, 2000, "Images");

  images.forEach(u => urlOrEmpty(u, "Image URL"));

  const thumbnail =
    urlOrEmpty(input.thumbnail || input.image, "Thumbnail") ||
    images[0] ||
    "";

  let dimensions = null;

  if (input.dimensions && typeof input.dimensions === "object") {
    const w = input.dimensions.width;
    const h = input.dimensions.height;
    const d = input.dimensions.depth;

    if ([w, h, d].some(v => v !== "" && v != null)) {
      dimensions = {
        width: num(w, "Width"),
        height: num(h, "Height"),
        depth: num(d, "Depth")
      };
    }
  }

  let reviews = [];

  if (Array.isArray(input.reviews)) {
    if (input.reviews.length > 100) {
      throw new HttpError(400, "Too many reviews.");
    }

    reviews = input.reviews
      .filter(r => r && typeof r === "object")
      .map(r => ({
        rating: num(r.rating, "Review rating", { min: 0, max: 5 }),
        comment: str(r.comment, 1000, "Review comment"),
        date: str(r.date, 40, "Review date"),
        reviewerName:
          str(r.reviewerName, 100, "Reviewer name") || "Customer",
        reviewerEmail: str(r.reviewerEmail, 254, "Reviewer email")
      }));
  }

  const price = num(input.price, "Price", { min: 0, max: 1e9 });

  return {
    sourceId: sourceId || null,
    title: str(input.title, 200, "Title", true),
    description: str(input.description, 5000, "Description"),
    category: str(input.category, 100, "Category"),
    brand: str(input.brand, 100, "Brand"),
    price,
    originalPrice: price,
    originalPriceUSD: num(input.originalPriceUSD, "Original price (USD)", {
      min: 0,
      max: 1e9
    }),
    discountPercentage: 0,
    rating: num(input.rating, "Rating", { min: 0, max: 5 }),
    stock: num(input.stock, "Stock", { min: 0, max: 1e9, integer: true }),
    availabilityStatus: str(input.availabilityStatus, 60, "Availability status"),
    thumbnail,
    images,
    tags: list(input.tags, 50, 60, "Tags"),
    sku: str(input.sku, 100, "SKU"),
    weight:
      input.weight === "" || input.weight == null
        ? null
        : num(input.weight, "Weight"),
    dimensions,
    warrantyInformation: str(input.warrantyInformation, 300, "Warranty information"),
    shippingInformation: str(input.shippingInformation, 300, "Shipping information"),
    returnPolicy: str(input.returnPolicy, 300, "Return policy"),
    minimumOrderQuantity: num(
      input.minimumOrderQuantity,
      "Minimum order quantity",
      { min: 1, max: 1e6, integer: true, fallback: 1 }
    ),
    specifications: cleanSpecs(input.specifications),
    reviews
  };
}

/* ---------------- Firebase Helpers ---------------- */

function forFirebase(obj) {
  const out = {};

  Object.keys(obj).forEach(k => {
    const v = obj[k];

    out[k] =
      v === undefined ? null : Array.isArray(v) && !v.length ? null : v;
  });

  return out;
}

async function listProducts(db) {
  const snap = await db.ref("products").once("value");

  const raw = snap.val() || {};

  return Object.keys(raw)
    .filter(id => raw[id] && typeof raw[id] === "object")
    .map(id => ({ ...raw[id], id }))
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

async function isPriceReductionActive(db) {
  const snap = await db.ref(PRICE_STATE_PATH).once("value");
  const s = snap.val();
  return !!(s && s.active === true);
}

// Standard response for the products resource.
async function productsPayload(db, extra) {
  return {
    products: await listProducts(db),
    priceReductionActive: await isPriceReductionActive(db),
    ...(extra || {})
  };
}

/* =====================================================
   BULK PRICE REDUCE / RESTORE
   - Reduce: new price written as a normal price, original saved
     in a separate private path. Nothing is marked on products.
   - Restore: original prices come back from that backup.
===================================================== */

async function reduceAllProductPrices(db) {
  if (await isPriceReductionActive(db)) {
    throw new HttpError(
      409,
      "Prices are already reduced. Restore them first."
    );
  }

  const snap = await db.ref("products").once("value");
  const raw = snap.val() || {};

  const updates = {};
  const summary = {
    mode: "reduced",
    totalProducts: 0,
    updatedProducts: 0,
    skippedProducts: 0,
    cappedINRProducts: 0,
    cappedUSDProducts: 0
  };

  const now = Date.now();

  Object.keys(raw).forEach(id => {
    const p = raw[id];

    if (!p || typeof p !== "object") return;

    summary.totalProducts++;

    const oldINR = Number(p.price);

    if (!Number.isFinite(oldINR) || oldINR < 0) {
      summary.skippedProducts++;
      return;
    }

    const reducedINR = oldINR * PRICE_REMAINING;
    const finalINR = Math.min(roundPrice(reducedINR), MAX_PRODUCT_PRICE_INR);

    if (reducedINR > MAX_PRODUCT_PRICE_INR) summary.cappedINRProducts++;

    const backup = {
      price: p.price,
      originalPrice: p.originalPrice == null ? null : p.originalPrice,
      hadUSD: false,
      originalPriceUSD: null,
      reducedPrice: finalINR,
      at: now
    };

    updates["products/" + id + "/price"] = finalINR;
    updates["products/" + id + "/originalPrice"] = finalINR;

    const oldUSD = Number(p.originalPriceUSD);

    if (
      p.originalPriceUSD != null &&
      Number.isFinite(oldUSD) &&
      oldUSD >= 0
    ) {
      const reducedUSD = oldUSD * PRICE_REMAINING;
      const finalUSD = Math.min(
        roundPrice(reducedUSD),
        roundPrice(MAX_PRODUCT_PRICE_USD)
      );

      if (reducedUSD > MAX_PRODUCT_PRICE_USD) summary.cappedUSDProducts++;

      backup.hadUSD = true;
      backup.originalPriceUSD = p.originalPriceUSD;

      updates["products/" + id + "/originalPriceUSD"] = finalUSD;
    }

    // Remove visible markers written by any older version.
    LEGACY_MARKER_FIELDS.forEach(f => {
      if (Object.prototype.hasOwnProperty.call(p, f)) {
        updates["products/" + id + "/" + f] = null;
      }
    });

    updates[PRICE_BACKUP_PATH + "/" + id] = backup;

    summary.updatedProducts++;
  });

  updates[PRICE_STATE_PATH] = { active: true, at: now };

  // One atomic write: all products + backup + state together.
  await db.ref().update(updates);

  return summary;
}

async function restoreAllProductPrices(db) {
  const [backupSnap, productsSnap] = await Promise.all([
    db.ref(PRICE_BACKUP_PATH).once("value"),
    db.ref("products").once("value")
  ]);

  const backups = backupSnap.val() || {};
  const products = productsSnap.val() || {};

  const updates = {};
  const summary = {
    mode: "restored",
    totalProducts: Object.keys(backups).length,
    updatedProducts: 0,
    skippedProducts: 0
  };

  Object.keys(backups).forEach(id => {
    const b = backups[id];
    const p = products[id];

    // Always clear the backup entry.
    updates[PRICE_BACKUP_PATH + "/" + id] = null;

    if (!b || !p || typeof p !== "object") {
      summary.skippedProducts++;
      return;
    }

    // If the price was edited after the reduction, keep the edit.
    if (Number(p.price) !== Number(b.reducedPrice)) {
      summary.skippedProducts++;
      return;
    }

    updates["products/" + id + "/price"] = b.price;
    updates["products/" + id + "/originalPrice"] =
      b.originalPrice == null ? b.price : b.originalPrice;

    if (b.hadUSD) {
      updates["products/" + id + "/originalPriceUSD"] = b.originalPriceUSD;
    }

    summary.updatedProducts++;
  });

  updates[PRICE_STATE_PATH] = null;

  await db.ref().update(updates);

  return summary;
}

/* ---------------- Discounts ---------------- */

function cleanDiscount(input) {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, "Discount data is missing.");
  }

  const scope = input.scope === "user" ? "user" : "all";

  const percent = Number(input.percent);

  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new HttpError(400, "Discount must be between 0 and 100%.");
  }

  let userEmail = "";

  if (scope === "user") {
    userEmail = str(input.userEmail, 254, "Customer email", true).toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) {
      throw new HttpError(400, "Enter a valid customer email.");
    }
  }

  return {
    title: str(input.title, 60, "Title", true),
    scope,
    percent,
    userEmail
  };
}

async function listDiscounts(db) {
  const snap = await db.ref(DISCOUNTS_PATH).once("value");

  const raw = snap.val();

  if (!raw || typeof raw !== "object") {
    return [];
  }

  const rows = Array.isArray(raw)
    ? raw.map(
        (d, i) =>
          d && {
            ...d,
            id: String(d.id || i)
          }
      )
    : Object.keys(raw).map(
        id =>
          raw[id] &&
          typeof raw[id] === "object" && {
            ...raw[id],
            id
          }
      );

  return rows
    .filter(Boolean)
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

async function handleDiscounts(db, method, body) {
  if (method === "GET") {
    return { discounts: await listDiscounts(db) };
  }

  const action = String(body.action || "");

  const ref = db.ref(DISCOUNTS_PATH);

  if (action === "add") {
    const clean = cleanDiscount(body);

    await ref.push({
      ...clean,
      createdAt: Date.now()
    });
  } else if (action === "remove") {
    const id = String(body.id || "");

    if (!id || /[.#$\[\]\/]/.test(id)) {
      throw new HttpError(400, "A valid discount ID is required.");
    }

    await ref.child(id).remove();
  } else {
    throw new HttpError(400, "Unknown action. Use add or remove.");
  }

  return { discounts: await listDiscounts(db) };
}

/* ---------------- Products ---------------- */

async function handleProducts(db, method, body) {
  if (method === "GET") {
    // Plain read. No price changes happen here.
    return productsPayload(db);
  }

  const action = String(body.action || "");

  if (
    action === "togglePrices" ||
    action === "reduceAllPrices" ||
    action === "restoreAllPrices"
  ) {
    let priceChange;

    if (action === "reduceAllPrices") {
      priceChange = await reduceAllProductPrices(db);
    } else if (action === "restoreAllPrices") {
      priceChange = await restoreAllProductPrices(db);
    } else {
      priceChange = (await isPriceReductionActive(db))
        ? await restoreAllProductPrices(db)
        : await reduceAllProductPrices(db);
    }

    return productsPayload(db, { priceChange });
  }

  if (action === "add") {
    const clean = cleanProduct(body);

    let id = generateProductId();

    while ((await db.ref("products").child(id).once("value")).exists()) {
      id = generateProductId();
    }

    const now = Date.now();

    await db.ref("products").child(id).set(
      forFirebase({
        ...clean,
        createdAt: now,
        updatedAt: now
      })
    );
  } else if (action === "update") {
    const id = String(body.id || "");

    if (!PRODUCT_ID_PATTERN.test(id)) {
      throw new HttpError(400, "A valid product ID is required.");
    }

    const ref = db.ref("products").child(id);

    if (!(await ref.once("value")).exists()) {
      throw new HttpError(404, "Product not found.");
    }

    const clean = cleanProduct(body);

    delete clean.sourceId;

    // update() merges, so a changed specifications object must replace the
    // old one completely (otherwise removed fields would stay behind).
    await ref.child("specifications").remove();

    await ref.update(
      forFirebase({
        ...clean,
        updatedAt: Date.now()
      })
    );
  } else if (action === "remove") {
    const id = String(body.id || "");

    if (!PRODUCT_ID_PATTERN.test(id)) {
      throw new HttpError(400, "A valid product ID is required.");
    }

    await db.ref("products").child(id).remove();

    // Drop any saved original price for this product.
    await db.ref(PRICE_BACKUP_PATH).child(id).remove();

    // Prevent deleted products from being imported again.
    await db.ref("removedProducts").child(id).set(true);
  } else {
    throw new HttpError(
      400,
      "Unknown action. Use add, update, remove or togglePrices."
    );
  }

  return productsPayload(db);
}

/* ---------------- Main Handler ---------------- */

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const resource = String((req.query && req.query.resource) || "products");

    if (resource !== "products" && resource !== "discounts") {
      throw new HttpError(400, "Unknown resource. Use products or discounts.");
    }

    const publicDiscountRead =
      req.method === "GET" && resource === "discounts";

    const authorized = isAuthorized(req);

    if (!authorized && !publicDiscountRead) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized."
      });
    }

    /* Public discount read */

    if (publicDiscountRead && !authorized) {
      const db = initializeFirebase();

      const email = String((req.query && req.query.email) || "")
        .trim()
        .toLowerCase();

      const all = await listDiscounts(db);

      const discounts = all
        .filter(d => {
          const p = Number(d.percent);

          if (!(p > 0 && p <= 100)) {
            return false;
          }

          const scope = d.scope || "all";

          if (scope === "all") {
            return true;
          }

          return (
            scope === "user" &&
            email !== "" &&
            String(d.userEmail || "").trim().toLowerCase() === email
          );
        })
        .map(d => ({
          id: d.id,
          title: d.title,
          percent: Number(d.percent),
          scope: d.scope || "all"
        }));

      return res.status(200).json({
        success: true,
        discounts
      });
    }

    if (!["GET", "PUT", "POST"].includes(req.method)) {
      res.setHeader("Allow", "GET, PUT, POST, OPTIONS");

      return res.status(405).json({
        success: false,
        message: "Method not allowed."
      });
    }

    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }

    if (req.method !== "GET" && (!body || typeof body !== "object")) {
      throw new HttpError(400, "Invalid request body.");
    }

    const db = initializeFirebase();

    const result =
      resource === "discounts"
        ? await handleDiscounts(db, req.method, body || {})
        : await handleProducts(db, req.method, body || {});

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({
        success: false,
        message: error.message
      });
    }

    console.error("Admin productData API error:", error);

    return res.status(500).json({
      success: false,
      message:
        "Server error: " +
        (error && error.message ? error.message : "unknown")
    });
  }
};
