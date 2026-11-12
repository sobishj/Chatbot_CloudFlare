import { useCallback, useEffect, useState } from "react";
import { api, type Job } from "../../api";
import { JobProgress } from "../../components/JobProgress";
import { Alert, Button, Card, Empty, Field, Loading, Modal, useAction } from "../../components/ui";
import { num, relative } from "../../format";
import type { TabProps } from "./ClientDetail";

interface PageRow { id: number; url: string; title: string | null; crawled_at: string; characters: number; chunks: number }

export function WebsiteTab({ client, reload, isSuper }: TabProps) {
  const crawlJob = client.active_jobs?.find((j) => j.type === "crawl");
  const [jobId, setJobId] = useState<number | null>(crawlJob?.id ?? null);
  const { busy, run } = useAction();
  const [pagesKey, setPagesKey] = useState(0);

  const crawl = () => run(async () => {
    const { job } = await api<{ job: Job }>(`/api/admin/clients/${client.client_id}/crawl`, { method: "POST" });
    setJobId(job.id);
  });

  return (
    <div className="stack">
      <Card
        title="Crawl"
        subtitle={client.website_url ? <>Reads <strong>{client.website_url}</strong> (sitemaps first, otherwise links), respects robots.txt, and only re-indexes pages that changed.</> : "Set a website URL on the Overview tab first."}
        actions={<Button kind="primary" icon="refresh" loading={busy} disabled={!client.website_url || !!jobId} onClick={crawl}>Crawl now</Button>}
      >
        {jobId ? (
          <JobProgress jobId={jobId} showLog={false} onDone={() => { setJobId(null); reload(); setPagesKey((k) => k + 1); }} />
        ) : (
          <p className="muted" style={{ margin: 0 }}>Last crawl: {relative(client.last_crawl_at)} · {num(client.pages)} pages.</p>
        )}
      </Card>
      {isSuper && <CrawlSettings client={client} reload={reload} isSuper={isSuper} />}
      <PagesList key={pagesKey} client={client} reload={reload} isSuper={isSuper} />
    </div>
  );
}

function CrawlSettings({ client, reload }: TabProps) {
  const s = client.crawl_settings;
  const [maxPages, setMaxPages] = useState(s.max_pages);
  const [delay, setDelay] = useState(s.delay_seconds);
  const [include, setInclude] = useState(s.include_patterns.join("\n"));
  const [exclude, setExclude] = useState(s.exclude_patterns.join("\n"));
  const [extraction, setExtraction] = useState(s.extraction ?? "auto");
  const [renderJs, setRenderJs] = useState(s.render_js ?? "auto");
  const [readImages, setReadImages] = useState(s.read_images !== false);
  const [readDocuments, setReadDocuments] = useState(s.read_documents !== false);
  const { busy, run } = useAction();
  return (
    <Card title="Crawl settings">
      <div className="form-grid">
        <Field label="Max pages" htmlFor="cr-max"><input id="cr-max" className="input" type="number" min={1} max={20000} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} /></Field>
        <Field label="Delay between requests (seconds)" htmlFor="cr-delay" hint="Be polite to the website. robots.txt Crawl-delay wins if larger."><input id="cr-delay" className="input" type="number" min={0} max={60} step={0.5} value={delay} onChange={(e) => setDelay(Number(e.target.value))} /></Field>
        <Field label="Include URL patterns" htmlFor="cr-inc" hint="One per line, e.g. /stores/*. Empty = whole site."><textarea id="cr-inc" className="textarea" value={include} onChange={(e) => setInclude(e.target.value)} placeholder="/shop/*" /></Field>
        <Field label="Exclude URL patterns" htmlFor="cr-exc" hint="One per line, e.g. /careers/* or *?print=*"><textarea id="cr-exc" className="textarea" value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="/wp-admin/*" /></Field>
        <Field label="Text extraction" htmlFor="cr-ext" full hint="Full page keeps small facts like floors, opening hours and phone numbers. Main article suits blogs and news sites.">
          <select id="cr-ext" className="select" value={extraction} onChange={(e) => setExtraction(e.target.value)}>
            <option value="auto">Full page content (recommended)</option>
            <option value="main_content">Main article only</option>
          </select>
        </Field>
        <Field label="JavaScript websites" htmlFor="cr-js" full hint="Sites built with React, Vue or similar send almost no text until their scripts run. These pages are opened in a real browser (Cloudflare Browser Rendering, 10 free minutes a day) and read as visitors see them.">
          <select id="cr-js" className="select" value={renderJs} onChange={(e) => setRenderJs(e.target.value as typeof renderJs)}>
            <option value="auto">Open in a browser when a page looks empty (recommended)</option>
            <option value="always">Always open pages in a browser (slower)</option>
            <option value="never">Never: read the plain HTML only</option>
          </select>
        </Field>
        <label className="check full"><input type="checkbox" checked={readImages} onChange={(e) => setReadImages(e.target.checked)} />Read pictures: describe them and read the text in them (banners, posters, price lists). Uses Workers AI; each picture is read once and remembered for 60 days.</label>
        <label className="check full"><input type="checkbox" checked={readDocuments} onChange={(e) => setReadDocuments(e.target.checked)} />Read PDF, Word and Excel files linked from the website</label>
      </div>
      <div className="row end" style={{ marginTop: 14 }}>
        <Button kind="primary" loading={busy} onClick={() => run(async () => {
          await api(`/api/admin/clients/${client.client_id}/crawl-settings`, { method: "PUT", body: { max_pages: maxPages, delay_seconds: delay, include_patterns: include, exclude_patterns: exclude, extraction, render_js: renderJs, read_images: readImages, read_documents: readDocuments } });
          await reload();
        }, "Crawl settings saved")}>Save</Button>
      </div>
    </Card>
  );
}

function PagesList({ client, isSuper }: TabProps) {
  const [data, setData] = useState<{ total: number; items: PageRow[] } | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<number | null>(null);
  const { run } = useAction();
  const load = useCallback(() => api<{ total: number; items: PageRow[] }>(`/api/admin/clients/${client.client_id}/pages?search=${encodeURIComponent(search)}&page=${page}`).then(setData), [client.client_id, search, page]);
  useEffect(() => {
    const t = window.setTimeout(load, 200);
    return () => window.clearTimeout(t);
  }, [load]);

  return (
    <Card title={`Crawled pages${data ? ` (${num(data.total)})` : ""}`} actions={<input className="input" style={{ width: 260 }} placeholder="Search URL or title…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search pages" />} bodyless>
      {!data ? <Loading /> : data.items.length === 0 ? <Empty title="No pages yet">Press Crawl now to read the website.</Empty> : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Page</th><th className="num">Characters</th><th className="num">Chunks</th><th>Crawled</th><th /></tr></thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td style={{ maxWidth: 520 }}><strong className="truncate">{p.title || "Untitled"}</strong><a className="small truncate" href={p.url} target="_blank" rel="noreferrer">{p.url}</a></td>
                    <td className="num">{num(p.characters)}</td>
                    <td className="num">{num(p.chunks)}</td>
                    <td className="small muted nowrap">{relative(p.crawled_at)}</td>
                    <td className="num nowrap">
                      <Button size="sm" onClick={() => setViewing(p.id)}>View</Button>{" "}
                      {isSuper && <Button size="sm" kind="danger" onClick={() => run(async () => { await api(`/api/admin/clients/${client.client_id}/pages/${p.id}`, { method: "DELETE" }); await load(); }, "Page removed")}>Remove</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.total > 50 && (
            <div className="card-body row between">
              <Button size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <span className="small muted">Page {page} of {Math.ceil(data.total / 50)}</span>
              <Button size="sm" disabled={page * 50 >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          )}
        </>
      )}
      {viewing !== null && <PageViewer clientId={client.client_id} pageId={viewing} onClose={() => setViewing(null)} />}
    </Card>
  );
}

function PageViewer({ clientId, pageId, onClose }: { clientId: string; pageId: number; onClose: () => void }) {
  const [page, setPage] = useState<{ url: string; title: string; content: string } | null>(null);
  useEffect(() => {
    api<{ page: { url: string; title: string; content: string } }>(`/api/admin/clients/${clientId}/pages/${pageId}`).then((d) => setPage(d.page));
  }, [clientId, pageId]);
  return (
    <Modal title={page?.title || "Page"} onClose={onClose} wide>
      {!page ? <Loading /> : (
        <div className="stack">
          <a href={page.url} target="_blank" rel="noreferrer">{page.url}</a>
          <Alert kind="info">This is the exact text the assistant learned from this page.</Alert>
          <div className="log-box" style={{ background: "var(--surface-2)", color: "var(--text)", maxHeight: 480 }}>{page.content}</div>
        </div>
      )}
    </Modal>
  );
}
