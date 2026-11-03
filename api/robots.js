"use strict";

module.exports = function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).send("Method Not Allowed");
  }

  const robots = `User-agent: *
Allow: /
Allow: /api/product
Disallow: /api/profile
Disallow: /api/cart
Disallow: /api/addresses
Disallow: /api/checkout
Disallow: /login
Disallow: /signup

Sitemap: https://www.sequize.shop/sitemap.xml
`;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");

  return res.status(200).send(req.method === "HEAD" ? "" : robots);
};
