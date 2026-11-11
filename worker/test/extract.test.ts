// HTML extraction: the cases of tests/test_crawler.py, plus fixtures checked against the DOM port of the
// lxml rules (extract_dom.ts), so the streaming extractor provably follows the same rules.
import { describe, expect, it } from "vitest";
import { extract } from "../src/crawler/extract";
import { extractDom } from "./reference/extract_dom";
import { FIXTURES, page } from "./fixtures/html";

const SITE = "https://www.shop.test";


describe("extract (auto)", () => {
  it("removes chrome and keeps small facts", async () => {
    const html = page("ASICS - Mall", "<p>Sports shoes.</p><div><span>Located on</span><span>Second Floor</span></div><div>10:00 AM to 10:00 PM</div>");
    const out = await extract(html, SITE + "/shop/asics/");
    expect(out.title).toBe("ASICS - Mall");
    expect(out.text).toContain("Second Floor");
    expect(out.text).toContain("10:00 AM to 10:00 PM");
    for (const junk of ["GLOBAL HEADER", "Copyright footer", "var x", "Menu Shop Dine"]) expect(out.text).not.toContain(junk);
  });

  it("drops call-to-action links", async () => {
    const html = page(
      "Movies",
      "<div>Zootopia 2</div><div><a>Know More »</a></div><div>Dheeram</div><div><a>View Store ›</a></div><div>Read more</div><div>View Website</div><div>Located on</div><div>Second Floor</div>",
    );
    const text = (await extract(html, SITE + "/movies/")).text;
    expect(text.split("\n")).toEqual(["Movies", "Zootopia 2", "Dheeram", "Located on", "Second Floor"]);
  });

  it("labels icon details and decodes protected emails", async () => {
    const html = `<html><body><main><h1>SKECHERS</h1><ul>
      <li class="elementor-icon-list-item"><span class="elementor-icon-list-icon"><svg class="e-font-icon-svg e-fas-phone-square-alt"></svg></span>
          <span class="elementor-icon-list-text">4055877 </span></li>
      <li class="elementor-icon-list-item"><span class="elementor-icon-list-icon"><svg class="e-font-icon-svg e-fas-envelope"></svg></span>
          <span class="elementor-icon-list-text"><a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="94f8e1f8e1b9fffbf7fcfdb9fdfaf0d4e7fff1f7fcf1e6e7baf7fbf9">[email&#160;protected]</a></span></li>
      <li><i class="fa fa-clock"></i> 10:00 AM to 10:00 PM</li>
      <li>Shop Timings <i class="fa fa-clock"></i> 9 to 5</li>
      </ul><p>Call <a href="tel:+914842727776">+91 4842727776</a> or write to <a href="mailto:info@example.com">info@example.com</a></p></main></body></html>`;
    const text = (await extract(html, "https://mall.test/shop/skechers/")).text;
    expect(text).toContain("Phone: 4055877");
    expect(text).toContain("Email: lulu-kochi-ind@skechers.com");
    expect(text).not.toContain("protected]");
    expect(text).toContain("Opening hours: 10:00 AM to 10:00 PM");
    expect(text).toContain("Shop Timings");
    expect(text).not.toContain("Opening hours: Shop Timings"); // already labelled: left alone
    expect(text).toContain("Phone: +91 4842727776");
    expect(text).toContain("Email: info@example.com");
  });

  it("keeps the page description for JavaScript-built sites", async () => {
    const html = `<html><head><title>TaxLead</title><meta name="description" content="Business services and consulting in Kochi: GST, income tax and compliance.">
    </head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
    expect((await extract(html, "https://taxlead.test/")).text).toBe("Business services and consulting in Kochi: GST, income tax and compliance.");
    const p = "<html><head><meta name='description' content='Shoes and more'></head><body><main><p>Shoes and more</p></main></body></html>";
    const text = (await extract(p, "https://x.test/")).text;
    expect(text.split("Shoes and more").length - 1).toBe(1); // not repeated when already in the text
  });

  it("collects links (with <base>) and decodes entities", async () => {
    const html = `<html><head><base href="/sub/"><title>A &amp; B</title></head><body><p>Fish &amp; chips &ndash; &#8377;250</p>
      <a href="x.html?a=1&amp;b=2">x</a><a href="#top">t</a><a href="mailto:a@b.c">m</a><a href="https://other.test/">o</a></body></html>`;
    const out = await extract(html, "https://s.test/page/");
    expect(out.title).toBe("A & B");
    expect(out.text).toContain("Fish & chips – ₹250");
    expect(out.links).toEqual(["https://s.test/sub/x.html?a=1&b=2", "https://other.test/"]);
  });

  it("applies implied end tags (lists, paragraphs, tables)", async () => {
    const html = "<body><ul><li>One<li>Two</ul><p>First<p>Second<table><tr><td>A<td>B<tr><td>C</table><dl><dt>Term<dd>Def</dl></body>";
    expect((await extract(html, "https://s.test/")).text.split("\n")).toEqual(["One", "Two", "First", "Second", "A | B", "C", "Term", "Def"]);
  });

  it("returns nothing for an empty page", async () => {
    expect(await extract("", "https://s.test/")).toEqual({ title: "", text: "", links: [] });
  });
});

describe("streaming extractor matches the DOM port of the lxml rules", () => {
  for (const [name, html] of Object.entries(FIXTURES)) {
    it(name, async () => {
      const streamed = await extract(html, "https://fixture.test/page/");
      const dom = extractDom(html, "https://fixture.test/page/");
      expect(streamed.text).toBe(dom.text);
      expect(streamed.title).toBe(dom.title);
      expect(streamed.links).toEqual(dom.links);
    });
  }
});

describe("extract (main_content)", () => {
  it("keeps the article and drops the chrome", async () => {
    const body = "<article><h2>Our story</h2>" + "<p>We have served Kochi since 1998 with fresh coffee and friendly service, every single day of the week.</p>".repeat(6) + "</article>";
    const out = await extract(page("About", body), SITE + "/about/", "main_content");
    expect(out.text).toContain("We have served Kochi since 1998");
    expect(out.text).not.toContain("Copyright footer");
  });
});
