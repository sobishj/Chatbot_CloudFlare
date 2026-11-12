// Branding with a live preview rendered by the real widget.js (preview mode).
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Branding } from "../../api";
import { Button, Card, Field, useAction } from "../../components/ui";
import type { TabProps } from "./ClientDetail";

declare global {
  interface Window {
    WebsiteAssistant?: { mount: (o: { config: object; container?: HTMLElement; preview?: boolean; open?: boolean; apiBase?: string; device?: Device }) => WidgetHandle };
  }
}

type Device = "desktop" | "mobile";
type WidgetHandle = { update: (c: object) => void; setDevice: (d: Device) => void; destroy: () => void };

// The preview draws the widget on a stand-in screen of this size, scaled to fit the panel,
// so the size percentages look the way they will on a real screen.
const SCREENS: Record<Device, { w: number; h: number; label: string }> = {
  desktop: { w: 1280, h: 800, label: "a 1280 × 800 desktop screen" },
  mobile: { w: 390, h: 844, label: "a 390 × 844 phone" },
};
const MAX_PREVIEW_HEIGHT = 640;

function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "Asia/Kolkata", "Asia/Dubai", "Europe/London", "America/New_York"];
  }
}

function SizeSlider({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}: <strong>{value}%</strong></label>
      <input id={id} type="range" min={20} max={100} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

const LANGUAGES = [
  ["en", "English"], ["ml", "Malayalam"], ["hi", "Hindi"], ["ta", "Tamil"], ["ar", "Arabic"],
  ["kn", "Kannada"], ["te", "Telugu"], ["fr", "French"], ["de", "German"], ["es", "Spanish"],
];

function loadWidgetScript(): Promise<void> {
  if (window.WebsiteAssistant) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/widget.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("widget.js failed to load"));
    document.head.appendChild(s);
  });
}

export function BrandingTab({ client, reload }: TabProps) {
  const [b, setB] = useState<Branding>(client.branding);
  const [notice, setNotice] = useState("");
  const [globalTz, setGlobalTz] = useState("UTC");
  const [device, setDevice] = useState<Device>("desktop");
  const [frameWidth, setFrameWidth] = useState(420);
  const measure = useRef<HTMLDivElement>(null);
  const zones = useMemo(timeZones, []);
  const { busy, run } = useAction();
  const stage = useRef<HTMLDivElement>(null);
  const handle = useRef<WidgetHandle | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Branding>(k: K, v: Branding[K]) => setB({ ...b, [k]: v });

  useEffect(() => {
    api<{ chat_notice?: string; timezone?: string }>("/api/admin/settings")
      .then((s) => { setNotice(s.chat_notice ?? ""); setGlobalTz(s.timezone || "UTC"); })
      .catch(() => setNotice("Chats are recorded to improve service."));
  }, []);

  useEffect(() => {
    const el = measure.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setFrameWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const screen = SCREENS[device];
  const scale = Math.min(frameWidth / screen.w, MAX_PREVIEW_HEIGHT / screen.h);

  const previewConfig = {
    client_id: `preview-${client.client_id}`,
    name: client.name,
    bot_name: b.bot_name,
    primary_color: b.primary_color,
    greeting: b.greeting,
    default_language: b.default_language,
    position: b.position,
    width_pct: b.width_pct,
    height_pct: b.height_pct,
    mobile_width_pct: b.mobile_width_pct,
    mobile_height_pct: b.mobile_height_pct,
    logo_url: client.logo_url ? `${location.origin}${client.logo_url}` : null,
    notice,
    powered_by: b.powered_by,
    powered_by_text: b.powered_by_text,
    powered_by_url: b.powered_by_url,
  };

  useEffect(() => {
    let cancelled = false;
    loadWidgetScript().then(() => {
      if (cancelled || !stage.current || !window.WebsiteAssistant) return;
      if (handle.current) handle.current.update(previewConfig);
      else handle.current = window.WebsiteAssistant.mount({ config: previewConfig, container: stage.current, preview: true, open: true, device });
    });
    return () => { cancelled = true; };
  });
  useEffect(() => { handle.current?.setDevice(device); }, [device]);
  useEffect(() => () => { handle.current?.destroy(); handle.current = null; }, []);

  const uploadLogo = (file: File) => run(async () => {
    const form = new FormData();
    form.append("file", file);
    await api(`/api/admin/clients/${client.client_id}/logo`, { form });
    await reload();
  }, "Logo updated");

  return (
    <div className="grid split-preview">
      <Card title="Branding" subtitle="How the chat widget looks on the website.">
        <div className="form-grid">
          <Field label="Bot name" htmlFor="b-name"><input id="b-name" className="input" value={b.bot_name} onChange={(e) => set("bot_name", e.target.value)} /></Field>
          <Field label="Colour" htmlFor="b-color">
            <div className="color-row">
              <input type="color" aria-label="Pick colour" value={b.primary_color} onChange={(e) => set("primary_color", e.target.value)} />
              <input id="b-color" className="input mono" value={b.primary_color} onChange={(e) => set("primary_color", e.target.value)} />
            </div>
          </Field>
          <Field label="Greeting message" htmlFor="b-greet" full><textarea id="b-greet" className="textarea" rows={2} value={b.greeting} onChange={(e) => set("greeting", e.target.value)} /></Field>
          <Field label="Default language" htmlFor="b-lang" hint="Widget labels. The assistant always answers in the visitor's language.">
            <select id="b-lang" className="select" value={b.default_language} onChange={(e) => set("default_language", e.target.value)}>
              {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </Field>
          <Field label="Position" htmlFor="b-pos">
            <select id="b-pos" className="select" value={b.position} onChange={(e) => set("position", e.target.value as Branding["position"])}>
              <option value="right">Bottom right</option><option value="left">Bottom left</option>
            </select>
          </Field>
          <div className="field full">
            <span className="label">Chat window size</span>
            <span className="hint">Percent of the visitor's screen. On desktops the window never gets smaller than 300 × 360 pixels so it stays usable.</span>
          </div>
          <SizeSlider id="b-w" label="Desktop width" value={b.width_pct} onChange={(v) => set("width_pct", v)} />
          <SizeSlider id="b-h" label="Desktop height" value={b.height_pct} onChange={(v) => set("height_pct", v)} />
          <SizeSlider id="b-mw" label="Phone width" value={b.mobile_width_pct} onChange={(v) => set("mobile_width_pct", v)} />
          <SizeSlider id="b-mh" label="Phone height" value={b.mobile_height_pct} onChange={(v) => set("mobile_height_pct", v)} />
          <span className="hint full">On phones (screens up to 480 pixels wide) the window is centred at the bottom. Set both to 100% for full screen.</span>
          <Field label="Time zone" htmlFor="b-tz" full hint="Used when visitors ask things like “what time is it?” or “are you open now?”.">
            <select id="b-tz" className="select" value={b.timezone} onChange={(e) => set("timezone", e.target.value)}>
              <option value="">Same as the global setting ({globalTz})</option>
              {b.timezone && !zones.includes(b.timezone) && <option value={b.timezone}>{b.timezone}</option>}
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
          <div className="field full">
            <span className="label">Logo</span>
            <div className="row">
              {client.logo_url ? <img src={client.logo_url} alt="Current logo" style={{ width: 44, height: 44, objectFit: "contain", border: "1px solid var(--border)", borderRadius: 8, padding: 3 }} /> : <span className="muted small">No logo</span>}
              <Button icon="upload" onClick={() => fileInput.current?.click()} loading={busy}>Upload</Button>
              {client.logo_url && <Button kind="ghost" onClick={() => run(async () => { await api(`/api/admin/clients/${client.client_id}/logo`, { method: "DELETE" }); await reload(); }, "Logo removed")}>Remove</Button>}
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ""; }} />
            </div>
            <span className="hint">PNG, JPG, GIF or WebP, up to 1 MB. Square images look best.</span>
          </div>
          <label className="check full"><input type="checkbox" checked={b.powered_by} onChange={(e) => set("powered_by", e.target.checked)} />Show “Powered by” footer</label>
          {b.powered_by && (
            <>
              <Field label="Powered-by text" htmlFor="b-pt"><input id="b-pt" className="input" value={b.powered_by_text} onChange={(e) => set("powered_by_text", e.target.value)} /></Field>
              <Field label="Powered-by link (optional)" htmlFor="b-pu"><input id="b-pu" className="input" value={b.powered_by_url} onChange={(e) => set("powered_by_url", e.target.value)} placeholder="https://…" /></Field>
            </>
          )}
        </div>
        <div className="row end" style={{ marginTop: 16 }}>
          <Button onClick={() => setB(client.branding)}>Reset</Button>
          <Button kind="primary" loading={busy} onClick={() => run(async () => { await api(`/api/admin/clients/${client.client_id}/branding`, { method: "PUT", body: b }); await reload(); }, "Branding saved")}>Save</Button>
        </div>
      </Card>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row between">
          <span className="label">Live preview</span>
          <div className="segmented" role="group" aria-label="Preview device">
            {(["desktop", "mobile"] as Device[]).map((d) => (
              <button key={d} type="button" className={device === d ? "active" : ""} aria-pressed={device === d} onClick={() => setDevice(d)}>{d === "desktop" ? "Desktop" : "Phone"}</button>
            ))}
          </div>
        </div>
        <div ref={measure}>
          <div className="preview-frame" style={{ width: screen.w * scale, height: screen.h * scale }}>
            <div className="preview-stage" ref={stage} style={{ width: screen.w, height: screen.h, transform: `scale(${scale})` }}>
              <div className="fake"><div style={{ width: "60%" }} /><div style={{ width: "85%" }} /><div style={{ width: "72%" }} /><div style={{ width: "40%" }} /></div>
            </div>
          </div>
        </div>
        <span className="hint">Shown on {screen.label}, scaled to fit. The preview uses the real widget. Messages here aren't sent to the model; use Test chat for real answers.</span>
      </div>
    </div>
  );
}
