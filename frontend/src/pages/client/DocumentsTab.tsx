import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Job } from "../../api";
import { JobProgress } from "../../components/JobProgress";
import { Alert, Badge, Button, Card, Empty, Field, Loading, Modal, StatusBadge, useAction, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { approxTime, bytes, money, num, relative } from "../../format";
import type { TabProps } from "./ClientDetail";

interface Doc { id: number; source: "upload" | "folder"; path: string; filename: string; size_bytes: number; status: string; error: string | null; chunk_count: number; enabled: boolean; uploaded_at: string; indexed_at: string | null }
interface DocsData { documents: Doc[]; settings: { watch_path: string | null; scan_interval_minutes: number; last_scan_at: string | null; key_facts: string }; watched_root: string; mode: string }

/** Returned instead of starting indexing when the local embedding model would take very long. */
interface LargeUpload {
  pages: number;
  scanned: boolean;
  files: { filename: string; pages: number; scanned: boolean }[];
  current: { label: string; device: string; seconds: number; measured: boolean };
  cloud: { key: string; label: string; seconds: number; usd: number | null; recommended: boolean }[];
}

const ACCEPT = ".pdf,.docx,.xlsx,.txt,.md";

export function DocumentsTab({ client, reload, isSuper }: TabProps) {
  const [data, setData] = useState<DocsData | null>(null);
  const runningJob = client.active_jobs?.find((j) => j.type === "index_docs" || j.type === "scan_folder" || j.type === "reindex")?.id ?? null;
  const [jobId, setJobId] = useState<number | null>(runningJob);
  // Indexing continues in the background when you leave this tab; show it again on return.
  useEffect(() => {
    if (runningJob !== null) setJobId((current) => current ?? runningJob);
  }, [runningJob]);
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [large, setLarge] = useState<LargeUpload | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { busy, run } = useAction();

  const load = useCallback(() => api<DocsData>(`/api/admin/clients/${client.client_id}/documents`).then(setData), [client.client_id]);
  useEffect(() => {
    load();
  }, [load]);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const form = new FormData();
    list.forEach((f) => form.append("files", f));
    setUploading(true);
    try {
      const res = await api<{ saved: Doc[]; errors: string[]; job: Job | null; large: LargeUpload | null }>(`/api/admin/clients/${client.client_id}/documents`, { form });
      res.errors.forEach((e) => toast(e, "error"));
      if (res.saved.length && !res.large) toast(`${res.saved.length} file(s) uploaded, indexing…`);
      if (res.job) setJobId(res.job.id);
      if (res.large) setLarge(res.large);
      await load();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setUploading(false);
    }
  };

  const startJob = (path: string) => run(async () => {
    const { job } = await api<{ job: Job }>(path, { method: "POST" });
    setJobId(job.id);
  });

  if (!data) return <Loading />;
  const uploads = data.documents.filter((d) => d.source === "upload");
  const folder = data.documents.filter((d) => d.source === "folder");
  const waiting = uploads.filter((d) => d.status === "pending");
  const indexPending = () => startJob(`/api/admin/clients/${client.client_id}/documents/index`);

  return (
    <div className="stack">
      <Card title="Upload documents" subtitle="PDF, Word (DOCX), Excel (XLSX), text and Markdown, up to 1 GB each. Scanned PDFs are read with OCR. Files are indexed automatically after upload.">
        <div
          className={`dropzone ${over ? "over" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}
        >
          <Icon name="upload" size={26} />
          <p style={{ margin: "8px 0 0" }}>{uploading ? "Uploading…" : <><strong>Drop files here</strong> or click to choose</>}</p>
          <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
        </div>
        {jobId && <div style={{ marginTop: 14 }}><JobProgress jobId={jobId} onDone={() => { setJobId(null); load(); reload(); }} /></div>}
        {!jobId && waiting.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <Alert kind="info">
              <div className="row between">
                <span>{waiting.length} uploaded file(s) are waiting to be indexed.</span>
                <Button size="sm" kind="primary" loading={busy} onClick={indexPending}>Index now</Button>
              </div>
            </Alert>
          </div>
        )}
      </Card>

      {large && (
        <LargeUploadDialog
          info={large}
          isSuper={isSuper}
          onClose={() => { setLarge(null); load(); }}
          onIndexLocal={() => { setLarge(null); indexPending(); }}
        />
      )}

      <Card
        title={`Documents (${data.documents.length})`}
        actions={<Button icon="refresh" loading={busy} disabled={!!jobId || data.documents.length === 0} onClick={() => startJob(`/api/admin/clients/${client.client_id}/documents/reindex`)}>Re-index all</Button>}
        bodyless
      >
        {data.documents.length === 0 ? <Empty title="No documents yet">Upload files above.</Empty> : (
          <DocTable
            docs={[...uploads, ...folder]}
            onToggle={(d, enabled) => run(async () => {
              const r = await api<{ document: Doc }>(`/api/admin/clients/${client.client_id}/documents/${d.id}/enabled`, { method: "PUT", body: { enabled } });
              setData((cur) => cur && { ...cur, documents: cur.documents.map((x) => (x.id === d.id ? r.document : x)) });
            }, enabled ? `The assistant uses ${d.filename} again` : `The assistant no longer answers from ${d.filename}`)}
            onToggleAll={(enabled) => run(async () => {
              const r = await api<{ documents: Doc[] }>(`/api/admin/clients/${client.client_id}/documents/enabled`, { method: "PUT", body: { enabled } });
              setData((cur) => cur && { ...cur, documents: r.documents });
            }, enabled ? "The assistant uses all documents" : "The assistant no longer answers from any document")}
            onDelete={(d) => run(async () => { await api(`/api/admin/clients/${client.client_id}/documents/${d.id}`, { method: "DELETE" }); await load(); reload(); }, "Document deleted")} />
        )}
      </Card>

      <Card title="Answering">
        <div className="stack">
          <KeyFacts client={client} value={data.settings.key_facts} onSaved={(settings) => setData({ ...data, settings })} />
        </div>
      </Card>

    </div>
  );
}

function LargeUploadDialog({ info, isSuper, onClose, onIndexLocal }: { info: LargeUpload; isSuper: boolean; onClose: () => void; onIndexLocal: () => void }) {
  const navigate = useNavigate();
  const where = info.current.device === "cuda" ? "this server's GPU" : "this server's CPU";
  return (
    <Modal
      title="Large upload: choose how to index it"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Decide later</Button>
          <span className="spacer" />
          <Button onClick={onIndexLocal}>Index with {info.current.label} anyway</Button>
          {isSuper && <Button kind="primary" onClick={() => navigate("/settings?tab=embeddings")}>Choose a cloud model…</Button>}
        </>
      }
    >
      <div className="stack">
        <p style={{ margin: 0 }}>
          This upload has about <strong>{num(info.pages)} pages</strong>{info.scanned ? " of scanned images, which are read with OCR first" : ""}.
          With the current embedding model, <strong>{info.current.label}</strong> on {where}, indexing will take <strong>{approxTime(info.current.seconds)}</strong>
          {info.current.measured ? " (based on the speed measured on this server)" : " (estimate)"}.
        </p>
        <div>
          <strong>Cloud embedding models are much faster:</strong>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="table">
              <thead><tr><th>Model</th><th>Time for this upload</th><th className="num">Approx. cost</th></tr></thead>
              <tbody>
                {info.cloud.map((c) => (
                  <tr key={c.key}>
                    <td>{c.label} {c.recommended && <Badge color="green">Recommended</Badge>}</td>
                    <td>{approxTime(c.seconds)}</td>
                    <td className="num">{c.usd != null ? money(c.usd) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <Alert kind="info">
          A cloud model sends document text (and later, visitor questions) to the provider, and switching re-indexes all existing content once.
          {isSuper ? " Choosing one takes you to Settings → Embeddings; this upload is indexed automatically after the switch." : " Only a super admin can switch the embedding model (Settings → Embeddings)."}
        </Alert>
        <p className="small muted" style={{ margin: 0 }}>The files are saved either way. If you decide later, use <strong>Index now</strong> on this tab.</p>
      </div>
    </Modal>
  );
}

// Key information is stored as one text (that's what the assistant gets); a blank line separates records.
const KEY_FACTS_MAX = 4000;
const toRecords = (value: string) => value.split(/\n\s*\n/).map((r) => r.trim()).filter(Boolean);
// Blank lines inside a record would split it in two, so they are dropped.
const cleanRecord = (text: string) => text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).join("\n");
const joinRecords = (records: string[]) => records.map(cleanRecord).filter(Boolean).join("\n\n");

function KeyFacts({ client, value, onSaved }: { client: TabProps["client"]; value: string; onSaved: (s: DocsData["settings"]) => void }) {
  const records = toRecords(value);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const { busy, run } = useAction();
  const listBox = useRef<HTMLDivElement>(null);

  const save = (next: string[], message: string) =>
    run(async () => {
      const settings = (await api<{ settings: DocsData["settings"] }>(`/api/admin/clients/${client.client_id}/documents/answering`, { method: "PUT", body: { key_facts: joinRecords(next) } })).settings;
      onSaved(settings);
      return settings;
    }, message);

  const lengthWith = (next: string[]) => joinRecords(next).length;
  const addNext = [...records, draft];
  const addTooLong = lengthWith(addNext) > KEY_FACTS_MAX;
  const editNext = editing ? records.map((r, i) => (i === editing.index ? editing.text : r)) : records;
  const editTooLong = editing !== null && lengthWith(editNext) > KEY_FACTS_MAX;
  const used = joinRecords(records).length;

  const add = async () => {
    if (await save(addNext, "Key information added")) {
      setDraft("");
      // Show the new record at the bottom of the list.
      requestAnimationFrame(() => listBox.current?.scrollTo({ top: listBox.current.scrollHeight, behavior: "smooth" }));
    }
  };
  const saveEdit = async () => {
    if (!editing) return;
    // Emptying a record removes it.
    const next = cleanRecord(editing.text) ? editNext : records.filter((_, i) => i !== editing.index);
    if (await save(next, "Key information updated")) setEditing(null);
  };
  const remove = async (index: number) => {
    if (await save(records.filter((_, i) => i !== index), "Key information deleted")) setConfirmDelete(null);
  };

  return (
    <Field
      label="Key information (always given to the assistant)"
      htmlFor="key-facts"
      hint={`Facts the assistant must always know, whatever the visitor asks: ${client.name}'s opening hours, address, phone, parking… Keep it short. For "is it open now?" it uses the current time in the time zone set under Settings → Crawl schedule.`}
    >
      {records.length > 0 && (
        // Fixed height: more records scroll inside the box instead of pushing the page down.
        <div className="stack" role="region" aria-label="Saved key information" tabIndex={0}
          ref={listBox}
          style={{ gap: 8, marginBottom: 12, maxHeight: 280, overflowY: "auto", overscrollBehavior: "contain", padding: 8, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
          {records.map((record, i) => (
            <div key={i} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "10px 12px", background: "var(--surface-2)" }}>
              {editing?.index === i ? (
                <>
                  <textarea className="textarea" rows={Math.max(3, editing.text.split("\n").length + 1)} value={editing.text} autoFocus
                    aria-label={`Edit key information ${i + 1}`} onChange={(e) => setEditing({ index: i, text: e.target.value })} />
                  {editTooLong && <div className="hint" style={{ color: "var(--danger)" }}>Too long: all key information together can be at most {KEY_FACTS_MAX} characters.</div>}
                  <div className="row end" style={{ marginTop: 8, gap: 8 }}>
                    <Button size="sm" kind="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
                    <Button size="sm" kind="primary" loading={busy} disabled={editing.text === record || editTooLong} onClick={saveEdit}>Save</Button>
                  </div>
                </>
              ) : (
                <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{record}</div>
                  {confirmDelete === i ? (
                    <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                      <Button size="sm" kind="ghost" disabled={busy} onClick={() => setConfirmDelete(null)}>Keep</Button>
                      <Button size="sm" kind="danger" loading={busy} onClick={() => remove(i)}>Delete</Button>
                    </div>
                  ) : (
                    <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                      <Button size="sm" disabled={busy || editing !== null} onClick={() => { setConfirmDelete(null); setEditing({ index: i, text: record }); }}>Edit</Button>
                      <Button size="sm" kind="ghost" icon="trash" aria-label={`Delete key information ${i + 1}`} disabled={busy || editing !== null}
                        onClick={() => setConfirmDelete(i)} />
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <textarea id="key-facts" className="textarea" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)}
        aria-label="New key information"
        placeholder={records.length ? "Add new information…" : "Open every day, 9:00 AM to 11:00 PM.\nAddress: …\nPhone: …"} />
      {addTooLong && <div className="hint" style={{ color: "var(--danger)" }}>Too long: all key information together can be at most {KEY_FACTS_MAX} characters.</div>}
      <div className="row" style={{ marginTop: 8, justifyContent: "space-between" }}>
        <span className="small muted">{used} / {KEY_FACTS_MAX} characters used</span>
        <Button kind="primary" size="sm" icon="plus" loading={busy && editing === null && confirmDelete === null} disabled={!cleanRecord(draft) || addTooLong || busy}
          onClick={add}>
          Add information
        </Button>
      </div>
    </Field>
  );
}

function DocTable({ docs, onToggle, onToggleAll, onDelete }: { docs: Doc[]; onToggle: (d: Doc, enabled: boolean) => void; onToggleAll: (enabled: boolean) => void; onDelete: (d: Doc) => void }) {
  const used = docs.filter((d) => d.enabled).length;
  const allBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = used > 0 && used < docs.length; // some ticked: show a dash
  }, [used, docs.length]);
  const [confirm, setConfirm] = useState<number | null>(null);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th title="Untick to stop the assistant answering from a document">
          <label className="check" style={{ gap: 6 }}>
            <input ref={allBox} type="checkbox" checked={docs.length > 0 && used === docs.length}
              onChange={(e) => onToggleAll(e.target.checked)} aria-label={used === docs.length ? "Ignore all documents" : "Use all documents"} />
            Use
          </label>
        </th><th>File</th><th>Source</th><th className="num">Size</th><th>Status</th><th>Indexed</th><th /></tr></thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} style={{ opacity: d.enabled ? 1 : 0.55 }}>
              <td style={{ width: 44 }}>
                <input type="checkbox" checked={d.enabled} onChange={(e) => onToggle(d, e.target.checked)}
                  aria-label={`Use ${d.filename} for answers`} title={d.enabled ? "Used for answers. Untick to ignore it." : "Ignored for answers. Tick to use it again."} />
              </td>
              <td style={{ maxWidth: 380 }}><strong className="truncate" title={d.path}>{d.filename}</strong>{d.source === "folder" && d.path !== d.filename && <span className="small muted truncate">{d.path}</span>}{d.error && <div className="small" style={{ color: "var(--danger)" }}>{d.error}</div>}</td>
              <td>{d.source === "upload" ? <Badge>Uploaded</Badge> : <Badge color="blue">Folder</Badge>}</td>
              <td className="num">{bytes(d.size_bytes)}</td>
              <td><StatusBadge status={d.status} />{d.status === "indexed" && <div className="small muted">{d.chunk_count} chunks</div>}</td>
              <td className="small muted nowrap">{relative(d.indexed_at)}</td>
              <td className="num">
                {d.source === "upload" && (confirm === d.id
                  ? <Button size="sm" kind="danger" onClick={() => onDelete(d)}>Confirm</Button>
                  : <Button size="sm" kind="ghost" aria-label={`Delete ${d.filename}`} onClick={() => setConfirm(d.id)}><Icon name="trash" /></Button>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
