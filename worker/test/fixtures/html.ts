// HTML fixtures for the extractor cross-check (typical page-builder, shop and table markup).
export const FIXTURES: Record<string, string> = {
  "elementor shop page": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>NIKE - Lulu Mall</title>
<meta property="og:title" content="NIKE | Lulu Mall Kochi"><meta name="description" content="Nike store at Lulu Mall: shoes, apparel &amp; gear.">
<style>.x{color:red}</style><script>window.dataLayer=[];</script></head>
<body class="page">
<div data-elementor-type="header"><nav><a href="/">Home</a><a href="/shops/">Shops</a></nav></div>
<div class="cookie-banner">We use cookies <button>Accept</button></div>
<main><section><div class="elementor-widget-container"><h1>NIKE</h1>
<p>The latest gear to take on sports.</p>
<ul class="elementor-icon-list-items">
<li class="elementor-icon-list-item"><span class="elementor-icon-list-icon"><i aria-hidden="true" class="fas fa-map-marker-alt"></i></span><span class="elementor-icon-list-text">Ground Floor, Shop G-12</span></li>
<li class="elementor-icon-list-item"><span class="elementor-icon-list-icon"><i aria-hidden="true" class="fas fa-phone-alt"></i></span><span class="elementor-icon-list-text">0484 2727 776</span></li>
<li class="elementor-icon-list-item"><span class="elementor-icon-list-icon"><i aria-hidden="true" class="far fa-clock"></i></span><span class="elementor-icon-list-text">10:00 AM - 10:00 PM</span></li>
</ul>
<a href="/shops/nike/offers/?utm_source=x" class="btn">View Offers »</a>
<span class="screen-reader-text">Skip</span>
</div></section></main>
<aside>Related shops</aside>
<footer><p>&copy; 2026 Lulu</p></footer>
</body></html>`,

  "table and definition list": `<html><body><h2>Opening hours</h2>
<table><thead><tr><th>Day</th><th>Hours</th></tr></thead>
<tbody><tr><td>Mon&ndash;Fri</td><td>9:00 &ndash; 18:00</td></tr><tr><td>Sat</td><td>10:00 &ndash; 14:00</td></tr></tbody></table>
<dl><dt>Address</dt><dd>12 MG Road<br>Kochi 682016</dd><dt>Email</dt><dd><a href="mailto:hello@cafe.test">hello@cafe.test</a></dd></dl>
<form><input name="q"><button>Search</button></form>
</body></html>`,

  "contact block with labels": `<html><head><title>Contact us</title></head><body>
<div class="contact"><p><strong>Phone:</strong> <a href="tel:+914842000000">+91 484 2000000</a></p>
<p>Write to <a href="mailto:info@shop.test">info@shop.test</a> or call <a href="tel:0484123">0484 123</a></p>
<p><span class="icon icon-location"></span> Near Edappally Junction</p>
<div><span><svg class="icon-whatsapp"><use href="#wa"></use></svg></span><span>98950 12345</span></div>
<div role="dialog">Newsletter popup</div><div aria-hidden="true">hidden text</div>
</div><a href="/cdn-cgi/l/email-protection#94f8e1f8e1b9fffbf7fcfdb9fdfaf0d4e7fff1f7fcf1e6e7baf7fbf9">[email protected]</a>
</body></html>`,

  "malformed and nested": `<body><div>Intro text <b>bold <i>both</i></b> tail
<div>Inner<p>Para one<p>Para two</div> after inner
<ul><li>A <ul><li>A1<li>A2</ul><li>B</ul>
<h3>Heading</h3>Loose text<br>next line<hr>Read more »
<template><p>tmpl</p></template><noscript>enable js</noscript>
</div></body>`,

  "malayalam and hindi text": `<html><head><title>കൊച്ചി | Lulu</title></head><body><main>
<h1>സ്വാഗതം</h1><p>ഞങ്ങളുടെ കട രാവിലെ 10 മണിക്ക് തുറക്കും.</p><p>हमारी दुकान सुबह 10 बजे खुलती है।</p>
<p>Prices from &#x20B9;499 &mdash; offer ends soon</p></main></body></html>`,
};

/** A page with the usual chrome around ``body`` (tests/test_crawler.py: page()). */
export function page(title: string, body: string, links: string[] = []): string {
  const nav = links.map((href) => `<a href="${href}">${href}</a>`).join("");
  return (
    `<html><head><title>${title}</title></head><body>` +
    `<header><nav><a href="/">Home</a> Menu Shop Dine</nav></header>` +
    `<div data-elementor-type="header">GLOBAL HEADER</div>` +
    `<main><h1>${title}</h1>${body}<div>${nav}</div></main>` +
    `<footer>Copyright footer text</footer><script>var x = 1;</script></body></html>`
  );
}
