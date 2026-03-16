import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════
   SPOTIFY CONFIG
═══════════════════════════════════════════════════════════════ */
const SPOTIFY_CLIENT_ID = "ca576640f2414bc2bc00fb45f69add96";
const REDIRECT_URI = "http://127.0.0.1:5173/";
const SCOPES = "user-read-private user-read-email user-read-recently-played";

/* ── PKCE ── */
async function generateCodeChallenge() {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(64)))
    .map(b => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"[b % 66])
    .join("");
  sessionStorage.setItem("spotify_verifier", verifier);
  const hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hashed)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getSpotifyAuthUrl() {
  const challenge = await generateCodeChallenge();
  return `https://accounts.spotify.com/authorize?${new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID, response_type: "code",
    redirect_uri: REDIRECT_URI, scope: SCOPES,
    code_challenge_method: "S256", code_challenge: challenge,
  })}`;
}

async function exchangeCodeForToken(code) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code,
      redirect_uri: REDIRECT_URI, client_id: SPOTIFY_CLIENT_ID,
      code_verifier: sessionStorage.getItem("spotify_verifier"),
    }),
  });
  return res.ok ? res.json() : null;
}

async function doRefreshToken(refreshToken) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: refreshToken,
      client_id: SPOTIFY_CLIENT_ID,
    }),
  });
  return res.ok ? res.json() : null;
}

async function fetchSpotifyProfile(token) {
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok ? res.json() : null;
}

async function fetchRecentlyPlayed(token, limit = 20) {
  const res = await fetch(
    `https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.ok ? res.json() : null;
}

async function spSearch(q, types, token) {
  if (!token || typeof token !== "string" || !q?.trim()) return null;
  const cleanToken = token.trim();
  const qs = `q=${encodeURIComponent(q.trim())}&type=${types}&limit=10`;
  const res = await fetch(`https://api.spotify.com/v1/search?${qs}`, {
    headers: { Authorization: `Bearer ${cleanToken}` }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("[spSearch] API error", res.status, err);
    return null;
  }
  return res.json();
}

function extractCode() {
  return new URLSearchParams(window.location.search).get("code");
}

/* ── localStorage ── */
const LS = {
  TOKEN: "nw_access_token",
  REFRESH: "nw_refresh_token",
  EXP: "nw_token_expires",
  PROFILE: "nw_profile",
  REVIEWS: "nw_reviews",
  LISTS: "nw_lists",
  FOLLOWS: "nw_follows",
  USERS: "nw_users_cache",
};

function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { }
}
function lsClear(...keys) { keys.forEach(k => localStorage.removeItem(k)); }

/* ── Token store — plain module-level object, no React involved ──
   This is the single source of truth for the current token.
   It is read synchronously from localStorage at module load time,
   so it is always populated before any component renders.
─────────────────────────────────────────────────────────────── */
const tokenStore = {
  accessToken: lsGet(LS.TOKEN),
  refreshToken: lsGet(LS.REFRESH),
  expiresAt: lsGet(LS.EXP, 0),

  isValid() {
    return !!(this.accessToken && Date.now() < this.expiresAt - 60000);
  },

  save(data) {
    const exp = Date.now() + (data.expires_in || 3600) * 1000;
    this.accessToken = data.access_token;
    this.expiresAt = exp;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    lsSet(LS.TOKEN, data.access_token);
    lsSet(LS.EXP, exp);
    if (data.refresh_token) lsSet(LS.REFRESH, data.refresh_token);
  },

  clear() {
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    lsClear(LS.TOKEN, LS.REFRESH, LS.EXP, LS.PROFILE);
  },
};

/* ensureToken — always call this before any Spotify API request.
   Reads/writes tokenStore directly, never touches React state.    */
let refreshPromise = null; // deduplicate concurrent refresh calls

async function ensureToken() {
  // Valid token already in store
  if (tokenStore.isValid()) return tokenStore.accessToken;

  // Token exists but not yet checked for expiry (e.g. just saved, expiresAt not set)
  // Fall back: if we have an accessToken but expiresAt is 0, treat it as valid
  if (tokenStore.accessToken && tokenStore.expiresAt === 0) return tokenStore.accessToken;

  if (!tokenStore.refreshToken) {
    console.warn("[ensureToken] No refresh token available");
    return null;
  }

  // Deduplicate concurrent refresh calls
  if (!refreshPromise) {
    refreshPromise = doRefreshToken(tokenStore.refreshToken)
      .then(data => {
        if (data?.access_token) {
          tokenStore.save(data);
          return data.access_token;
        }
        console.warn("[ensureToken] Refresh failed", data);
        tokenStore.clear();
        return null;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

/* ── Helpers ── */
function formatDate(s) {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/* ── UI Components ── */
function Avatar({ user, size = 36 }) {
  const img = user?.images?.[0]?.url;
  if (img) return <img src={img} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, display: "block" }} />;
  const palette = ["#007AFF", "#34C759", "#FF9500", "#FF2D55", "#AF52DE", "#5AC8FA"];
  const name = user?.display_name || user?.name || "?";
  const bg = palette[(name.charCodeAt(0) || 0) % palette.length];
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.36, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
      {name[0].toUpperCase()}
    </div>
  );
}

function Stars({ value, onChange, size = 18 }) {
  const [hov, setHov] = useState(0);
  const show = hov || value;
  return (
    <div style={{ display: "flex", gap: 2 }}>
      {[1, 2, 3, 4, 5].map(s => (
        <svg key={s} width={size} height={size} viewBox="0 0 24 24"
          fill={s <= show ? "#F5C518" : "none"} stroke={s <= show ? "#F5C518" : "#3A3A3C"} strokeWidth="1.5"
          style={{ cursor: onChange ? "pointer" : "default", transition: "all .1s", filter: s <= show ? "drop-shadow(0 0 3px rgba(245,197,24,0.4))" : "none" }}
          onMouseEnter={() => onChange && setHov(s)} onMouseLeave={() => onChange && setHov(0)}
          onClick={() => onChange?.(s)}>
          <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
        </svg>
      ))}
    </div>
  );
}

function CoverArt({ item, size = 52 }) {
  const r = Math.max(4, size * 0.08);
  if (item?.cover) return <img src={item.cover} alt="" style={{ width: size, height: size, borderRadius: r, objectFit: "cover", flexShrink: 0 }} />;
  const hue = ((item?.title || "?").charCodeAt(0) * 23 + (item?.artist || "").charCodeAt(0) * 7) % 360;
  return (
    <div style={{ width: size, height: size, borderRadius: r, flexShrink: 0, background: `linear-gradient(135deg,hsl(${hue},40%,16%),hsl(${(hue + 50) % 360},35%,10%))`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.26, fontWeight: 700, color: `hsl(${hue},50%,58%)`, border: `1px solid hsl(${hue},28%,20%)` }}>
      {(item?.title || "?").slice(0, 2).toUpperCase()}
    </div>
  );
}

function RichEditor({ value, onChange, placeholder = "Write your review…" }) {
  const ref = useRef(null);
  const init = useRef(false);
  useEffect(() => {
    if (ref.current && !init.current) { ref.current.innerHTML = value || ""; init.current = true; }
  }, []);
  function exec(cmd, val = null) { ref.current?.focus(); document.execCommand(cmd, false, val); sync(); }
  function sync() { const h = ref.current?.innerHTML || ""; onChange(h === "<br>" ? "" : h); }
  const tools = [
    { l: <b>B</b>, t: "Bold", fn: () => exec("bold") },
    { l: <i>I</i>, t: "Italic", fn: () => exec("italic") },
    { l: <u style={{ textDecoration: "underline" }}>U</u>, t: "Underline", fn: () => exec("underline") },
    { l: "❝", t: "Blockquote", fn: () => exec("formatBlock", "blockquote") },
    { l: "•≡", t: "List", fn: () => exec("insertUnorderedList") },
    { l: "H", t: "Heading", fn: () => exec("formatBlock", "h3") },
    { l: "¶", t: "Paragraph", fn: () => exec("formatBlock", "p") },
    { l: "✕", t: "Clear", fn: () => { exec("removeFormat"); exec("formatBlock", "p"); } },
  ];
  return (
    <div className="rich-wrap">
      <div className="rich-bar">
        {tools.map((t, i) => <button key={i} className="rich-btn" title={t.t} onMouseDown={e => { e.preventDefault(); t.fn(); }}>{t.l}</button>)}
      </div>
      <div ref={ref} className="rich-body" contentEditable suppressContentEditableWarning
        onInput={sync} onKeyDown={e => e.key === "Tab" && (e.preventDefault(), exec("insertHTML", "&nbsp;&nbsp;&nbsp;&nbsp;"))}
        data-ph={placeholder} />
    </div>
  );
}

/* ── Inline Search ── */
function InlineSearch({ onSelect, placeholder = "Search songs or albums…", disabled = false }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("tracks");
  const deb = useRef(null);
  const wrap = useRef(null);

  useEffect(() => {
    const fn = e => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  useEffect(() => {
    if (!q.trim()) { setRes(null); setOpen(false); return; }
    if (disabled) return;
    clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      setLoading(true);
      try {
        const token = await ensureToken();
        if (!token) { console.warn("[InlineSearch] ensureToken returned null"); setLoading(false); return; }
        const d = await spSearch(q, "track,album", token);
        const tracks = (d?.tracks?.items || []).map(t => ({ id: t.id, type: "track", title: t.name, artist: t.artists.map(a => a.name).join(", "), cover: t.album?.images?.[0]?.url, year: t.album?.release_date?.slice(0, 4) }));
        const albums = (d?.albums?.items || []).map(a => ({ id: a.id, type: "album", title: a.name, artist: a.artists.map(x => x.name).join(", "), cover: a.images?.[0]?.url, year: a.release_date?.slice(0, 4) }));
        setRes({ tracks, albums }); setOpen(true);
      } catch (e) { console.error("Search error:", e); }
      setLoading(false);
    }, 340);
  }, [q]);

  function pick(item) { setQ(""); setRes(null); setOpen(false); onSelect(item); }
  const list = activeTab === "tracks" ? (res?.tracks || []) : (res?.albums || []);

  return (
    <div ref={wrap} className="isb-wrap">
      <div className="isb-field">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></svg>
        <input className="isb-input" placeholder={disabled ? "Connect Spotify to search…" : placeholder} value={q}
          onChange={e => setQ(e.target.value)} onFocus={() => res && setOpen(true)} disabled={disabled} />
        {loading && <div className="isb-spin" />}
        {q && !loading && <button className="isb-x" onClick={() => { setQ(""); setOpen(false); }}>✕</button>}
      </div>
      {open && list.length > 0 && (
        <div className="isb-drop">
          <div className="isb-tabs">
            {[["tracks", `Tracks (${res?.tracks?.length || 0})`], ["albums", `Albums (${res?.albums?.length || 0})`]].map(([k, l]) => (
              <button key={k} className={`isb-tab ${activeTab === k ? "active" : ""}`} onClick={() => setActiveTab(k)}>{l}</button>
            ))}
          </div>
          <div className="isb-list">
            {list.map(item => (
              <button key={item.id} className="isb-row" onClick={() => pick(item)}>
                <CoverArt item={item} size={36} />
                <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  <div className="isb-name">{item.title}</div>
                  <div className="isb-meta">{item.artist}{item.year ? ` · ${item.year}` : ""}</div>
                </div>
                <span className="isb-badge">{item.type}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Review Modal ── */
function ReviewModal({ initItem, onClose, onSubmit, initStars = 0, initText = "", isEdit = false }) {
  const [item, setItem] = useState(initItem || null);
  const [stars, setStars] = useState(initStars);
  const [text, setText] = useState(initText || "");
  const ovRef = useRef(null);
  useEffect(() => {
    document.body.style.overflow = "hidden";
    const fn = e => e.key === "Escape" && onClose();
    document.addEventListener("keydown", fn);
    return () => { document.body.style.overflow = ""; document.removeEventListener("keydown", fn); };
  }, []);
  const LABELS = ["", "Poor", "Fair", "Good", "Great", "Essential"];
  return (
    <div ref={ovRef} className="modal-ov" onClick={e => e.target === ovRef.current && onClose()}>
      <div className="modal-box">
        <div className="modal-head">
          <span className="modal-title">{isEdit ? "Edit Review" : item ? "Write a Review" : "Find Music"}</span>
          <button className="modal-x" onClick={onClose}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
        </div>
        <div className="modal-body">
          {!item && !isEdit && (
            <>
              <p className="modal-hint">Search for the album or track you want to review</p>
              <InlineSearch onSelect={setItem} placeholder="Search Spotify…" />
              <div className="modal-manual">
                <p>Or enter manually:</p>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <input className="modal-input" placeholder="Title…" id="mt" />
                  <input className="modal-input" placeholder="Artist…" id="ma" style={{ maxWidth: 130 }} />
                  <button className="modal-go" onClick={() => {
                    const t = document.getElementById("mt").value.trim();
                    const a = document.getElementById("ma").value.trim();
                    if (t) setItem({ id: "m" + Date.now(), type: "track", title: t, artist: a || "Unknown", cover: null, year: "" });
                  }}>→</button>
                </div>
              </div>
            </>
          )}
          {item && (
            <>
              <div className="modal-hero">
                <div className="modal-cover-wrap">
                  <CoverArt item={item} size={90} />
                  {item.cover && <div className="modal-glow" style={{ backgroundImage: `url(${item.cover})` }} />}
                </div>
                <div className="modal-item-info">
                  <div className="modal-item-title">{item.title}</div>
                  <div className="modal-item-artist">{item.artist}</div>
                  <div className="modal-item-meta">{item.type === "album" ? "Album" : "Track"}{item.year ? ` · ${item.year}` : ""}</div>
                  {!isEdit && <button className="modal-change" onClick={() => setItem(null)}>← Change</button>}
                </div>
              </div>
              <div className="modal-rating">
                <span className="modal-rating-label">Rating</span>
                <Stars value={stars} onChange={setStars} size={28} />
                {stars > 0 && <span className="modal-rating-word">{LABELS[stars]}</span>}
              </div>
              <RichEditor value={text} onChange={setText} placeholder="What did you think? Bold, italic, blockquotes all supported…" />
              <button className="modal-submit" disabled={stars === 0} onClick={() => onSubmit(item, stars, text)}>
                {isEdit ? "Save Changes" : "Post Review"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── List Modal ── */
function ListModal({ onClose, onSubmit, initList = null, isEdit = false }) {
  const [title, setTitle] = useState(initList?.title || "");
  const [desc, setDesc] = useState(initList?.description || "");
  const [items, setItems] = useState(initList?.items || []);
  useEffect(() => { document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = ""; }; }, []);
  function add(r) { if (!items.find(i => i.id === r.id)) setItems(p => [...p, { ...r, rank: p.length + 1 }]); }
  function remove(id) { setItems(p => p.filter(i => i.id !== id).map((i, n) => ({ ...i, rank: n + 1 }))); }
  function move(id, dir) {
    setItems(p => {
      const idx = p.findIndex(i => i.id === id); const n = [...p]; const sw = idx + dir;
      if (sw < 0 || sw >= n.length) return p;
      [n[idx], n[sw]] = [n[sw], n[idx]];
      return n.map((i, x) => ({ ...i, rank: x + 1 }));
    });
  }
  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal-box modal-box-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{isEdit ? "Edit List" : "New List"}</span>
          <button className="modal-x" onClick={onClose}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
        </div>
        <div className="modal-body">
          <input className="modal-input" style={{ width: "100%", fontSize: 16, fontWeight: 600, marginBottom: 8 }} placeholder="List title…" value={title} onChange={e => setTitle(e.target.value)} />
          <input className="modal-input" style={{ width: "100%", marginBottom: 14 }} placeholder="Description (optional)…" value={desc} onChange={e => setDesc(e.target.value)} />
          <p className="modal-hint" style={{ marginBottom: 8 }}>Add songs or albums</p>
          <InlineSearch onSelect={add} placeholder="Search to add…" />
          {items.length > 0 && (
            <div className="list-edit-items">
              <div className="list-edit-label">Your list</div>
              {items.map((item, idx) => (
                <div key={item.id} className="list-edit-row">
                  <span className="list-edit-rank">{idx + 1}</span>
                  <CoverArt item={item} size={32} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: "#fff", fontWeight: 500 }}>{item.title}</div>
                    <div style={{ fontSize: 11, color: "#636366" }}>{item.artist}</div>
                  </div>
                  <div style={{ display: "flex", gap: 3 }}>
                    <button className="lm-btn" onClick={() => move(item.id, -1)} disabled={idx === 0}>↑</button>
                    <button className="lm-btn" onClick={() => move(item.id, 1)} disabled={idx === items.length - 1}>↓</button>
                    <button className="lm-btn danger" onClick={() => remove(item.id)}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button className="modal-submit" style={{ marginTop: 14 }} disabled={!title.trim() || items.length === 0} onClick={() => onSubmit(title, desc, items)}>
            {isEdit ? "Save List" : "Create List"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Alert ── */
function Alert({ title, message, actions, onClose }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(12px)", animation: "fadeIn .15s ease" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#2C2C2E", borderRadius: 16, width: 280, overflow: "hidden", animation: "popIn .2s cubic-bezier(.34,1.56,.64,1)" }}>
        {(title || message) && (
          <div style={{ padding: "20px 16px 16px", textAlign: "center" }}>
            {title && <div style={{ fontSize: 17, fontWeight: 600, color: "#fff", marginBottom: 6 }}>{title}</div>}
            {message && <div style={{ fontSize: 13, color: "#8E8E93", lineHeight: 1.5 }}>{message}</div>}
          </div>
        )}
        <div style={{ borderTop: "1px solid #3A3A3C", display: "flex" }}>
          {actions.map((a, i) => (
            <button key={i} onClick={a.action} style={{ flex: 1, padding: "14px 8px", background: "none", border: "none", borderLeft: i > 0 ? "1px solid #3A3A3C" : "none", color: a.destructive ? "#FF3B30" : a.primary ? "#007AFF" : "#8E8E93", fontSize: 17, fontWeight: a.primary ? 600 : 400, cursor: "pointer" }}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Review Card ── */
function ReviewCard({ review, currentUser, allUsers, toggleLike, navigate, onEdit, onDelete }) {
  const author = allUsers[review.userId];
  if (!author) return null;
  const liked = review.likes?.includes(currentUser?.id);
  const isOwn = review.userId === currentUser?.id;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    const fn = e => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);
  return (
    <article className="rc">
      <div className="rc-art" onClick={() => navigate("reviewDetail", { reviewId: review.id })}>
        {review.item.cover ? <img src={review.item.cover} alt="" className="rc-art-img" /> : <div className="rc-art-bg" style={{ "--h": ((review.item.title || "").charCodeAt(0) * 23) % 360 }} />}
        <div className="rc-art-fade" />
        <div className="rc-art-stars"><Stars value={review.stars} size={13} /></div>
        <span className="rc-art-badge">{review.item.type}</span>
      </div>
      <div className="rc-body">
        <div className="rc-track-row" onClick={() => navigate("reviewDetail", { reviewId: review.id })}>
          <div className="rc-track-name">{review.item.title}</div>
          <div className="rc-track-sub">{review.item.artist}{review.item.year ? ` · ${review.item.year}` : ""}</div>
        </div>
        <div className="rc-meta-row">
          <button className="rc-author" onClick={() => navigate("profile", { userId: review.userId })}>
            <Avatar user={author} size={22} />
            <span className="rc-author-name">{author.display_name || author.name}</span>
          </button>
          <span className="rc-date">{formatDate(review.createdAt)}</span>
          {isOwn && (
            <div ref={menuRef} style={{ position: "relative", marginLeft: "auto" }}>
              <button className="rc-menu-btn" onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none"><circle cx="5" cy="12" r="1.4" fill="#555" /><circle cx="12" cy="12" r="1.4" fill="#555" /><circle cx="19" cy="12" r="1.4" fill="#555" /></svg>
              </button>
              {menuOpen && (
                <div className="rc-menu-drop">
                  <button onClick={() => { setMenuOpen(false); onEdit(review); }}>Edit</button>
                  <button className="danger" onClick={() => { setMenuOpen(false); onDelete(review.id); }}>Delete</button>
                </div>
              )}
            </div>
          )}
        </div>
        {review.text && <div className="rc-snippet" onClick={() => navigate("reviewDetail", { reviewId: review.id })} dangerouslySetInnerHTML={{ __html: review.text }} />}
        <div className="rc-actions">
          <button className={`rc-act ${liked ? "liked" : ""}`} onClick={() => toggleLike(review.id)}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill={liked ? "#E9463F" : "none"} stroke={liked ? "#E9463F" : "#555"} strokeWidth="2" strokeLinecap="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
            {review.likes?.length > 0 && <span>{review.likes.length}</span>}
          </button>
          <button className="rc-act" onClick={() => navigate("reviewDetail", { reviewId: review.id })}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#555" strokeWidth="2" strokeLinecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
            {review.comments?.length > 0 && <span>{review.comments.length}</span>}
          </button>
        </div>
      </div>
    </article>
  );
}

/* ── Recently Played ── */
function RecentlyPlayed({ onReview, title = "Your Recent Listening" }) {
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    ensureToken().then(async token => {
      if (!token || cancelled) { setLoading(false); return; }
      try {
        const data = await fetchRecentlyPlayed(token, 20);
        if (cancelled) return;
        if (data?.items) {
          const seen = new Set();
          const unique = data.items.filter(({ track }) => {
            if (seen.has(track.id)) return false;
            seen.add(track.id); return true;
          });
          setTracks(unique.slice(0, 12));
        }
      } catch { }
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) return (
    <div className="rp-wrap">
      <div className="rp-header-row"><span className="rp-header">{title}</span></div>
      <div style={{ display: "flex", gap: 10, padding: "8px 0 4px" }}>
        {[1, 2, 3, 4, 5].map(i => <div key={i} className="rp-skeleton" />)}
      </div>
    </div>
  );

  if (!tracks.length) return null;

  return (
    <div className="rp-wrap">
      <div className="rp-header-row">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="#1DB954" style={{ flexShrink: 0 }}><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424a.622.622 0 01-.857.207c-2.348-1.435-5.304-1.76-8.785-.964a.622.622 0 11-.277-1.215c3.809-.87 7.077-.496 9.712 1.115a.623.623 0 01.207.857zm1.223-2.722a.78.78 0 01-1.072.257c-2.687-1.652-6.785-2.131-9.965-1.166a.78.78 0 01-.973-.519.781.781 0 01.519-.972c3.632-1.102 8.147-.568 11.234 1.328a.78.78 0 01.257 1.072zm.105-2.835c-3.223-1.914-8.54-2.09-11.618-1.156a.935.935 0 11-.543-1.79c3.532-1.073 9.404-.865 13.115 1.338a.935.935 0 01-.954 1.608z" /></svg>
        <span className="rp-header">{title}</span>
        <span className="rp-hint">Tap to review</span>
      </div>
      <div className="rp-scroll">
        {tracks.map(({ track, played_at }) => {
          const item = { id: track.id, type: "track", title: track.name, artist: track.artists.map(a => a.name).join(", "), cover: track.album?.images?.[0]?.url, year: track.album?.release_date?.slice(0, 4) };
          return (
            <div key={track.id + played_at} className="rp-card" onClick={() => onReview(item)}>
              <div className="rp-art-wrap">
                {item.cover ? <img src={item.cover} alt="" className="rp-art" /> : <div className="rp-art-fallback" style={{ "--h": (item.title.charCodeAt(0) * 23) % 360 }} />}
                <div className="rp-hover-layer">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
                </div>
              </div>
              <div className="rp-name">{item.title}</div>
              <div className="rp-artist">{item.artist}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════════════════ */
export default function Noteworthy() {
  const [profile, setProfile] = useState(() => lsGet(LS.PROFILE));
  const [reviews, setReviews] = useState(() => lsGet(LS.REVIEWS, []));
  const [lists, setLists] = useState(() => lsGet(LS.LISTS, []));
  const [follows, setFollows] = useState(() => lsGet(LS.FOLLOWS, {}));
  const [usersCache, setUsersCache] = useState(() => lsGet(LS.USERS, {}));
  const [tab, setTab] = useState("feed");
  const [subPage, setSubPage] = useState(null);
  const [modal, setModal] = useState(null);
  const [alert, setAlert] = useState(null);
  const [toast, setToast] = useState(null);
  const [ready, setReady] = useState(false); // true once auth is resolved

  /* ── Boot sequence ── */
  useEffect(() => {
    const code = extractCode();

    if (code) {
      // OAuth callback
      window.history.replaceState({}, "", "/");
      exchangeCodeForToken(code).then(async data => {
        if (!data?.access_token) { setReady(true); return; }
        tokenStore.save(data);
        const prof = await fetchSpotifyProfile(data.access_token);
        if (prof) {
          setProfile(prof); lsSet(LS.PROFILE, prof);
          setUsersCache(prev => { const n = { ...prev, [prof.id]: prof }; lsSet(LS.USERS, n); return n; });
        }
        setReady(true);
      });
      return;
    }

    if (tokenStore.isValid()) {
      // Token in store is still good — just boot
      setReady(true);
      return;
    }

    if (tokenStore.refreshToken) {
      // Try silent refresh
      ensureToken().then(() => setReady(true));
      return;
    }

    // No auth at all
    setReady(true);
  }, []);

  useEffect(() => { lsSet(LS.REVIEWS, reviews); }, [reviews]);
  useEffect(() => { lsSet(LS.LISTS, lists); }, [lists]);
  useEffect(() => { lsSet(LS.FOLLOWS, follows); }, [follows]);

  function notify(msg, type = "success") {
    setToast({ msg, type }); setTimeout(() => setToast(null), 2600);
  }

  function signOut() {
    tokenStore.clear();
    setProfile(null); setTab("feed"); setSubPage(null); setModal(null);
  }

  const navigate = (page, data = {}) => setSubPage({ page, ...data });
  const goBack = () => setSubPage(null);
  const myId = profile?.id;
  const myFollowing = follows[myId] || [];

  function addReview(item, stars, text) {
    const r = { id: "rv" + Date.now(), userId: myId, item, stars, text, likes: [], comments: [], createdAt: new Date().toISOString() };
    setReviews(p => [r, ...p]); setModal(null); notify("Review posted");
  }
  function editReview(id, stars, text) {
    setReviews(p => p.map(r => r.id === id ? { ...r, stars, text } : r)); setModal(null); notify("Review updated");
  }
  function deleteReview(id) {
    setReviews(p => p.filter(r => r.id !== id));
    if (subPage?.page === "reviewDetail") goBack(); notify("Review deleted");
  }
  function toggleLike(id) {
    if (!myId) return;
    setReviews(p => p.map(r => {
      if (r.id !== id) return r;
      const has = r.likes?.includes(myId);
      return { ...r, likes: has ? (r.likes || []).filter(x => x !== myId) : [...(r.likes || []), myId] };
    }));
  }
  function addComment(id, text) {
    setReviews(p => p.map(r => r.id !== id ? r : { ...r, comments: [...(r.comments || []), { id: "cm" + Date.now(), userId: myId, text, createdAt: new Date().toISOString() }] }));
  }
  function deleteComment(reviewId, commentId) {
    setReviews(p => p.map(r => r.id !== reviewId ? r : { ...r, comments: r.comments.filter(c => c.id !== commentId) }));
  }
  function toggleFollow(targetId, targetProfile) {
    if (!myId) return;
    const cur = follows[myId] || []; const has = cur.includes(targetId);
    const upd = has ? cur.filter(x => x !== targetId) : [...cur, targetId];
    setFollows(p => ({ ...p, [myId]: upd }));
    if (targetProfile) setUsersCache(p => { const n = { ...p, [targetId]: targetProfile }; lsSet(LS.USERS, n); return n; });
    notify(has ? "Unfollowed" : "Now following!", "success");
  }
  function addList(title, desc, items) {
    setLists(p => [{ id: "l" + Date.now(), userId: myId, title, description: desc, items, createdAt: new Date().toISOString() }, ...p]);
    setModal(null); notify("List created");
  }
  function editList(id, title, desc, items) {
    setLists(p => p.map(l => l.id === id ? { ...l, title, description: desc, items } : l)); setModal(null); notify("List updated");
  }
  function deleteList(id) {
    setLists(p => p.filter(l => l.id !== id));
    if (subPage?.page === "listDetail") goBack(); notify("List deleted");
  }

  const shared = {
    reviews, lists, allUsers: usersCache, currentUser: profile, myId, myFollowing,
    navigate, toggleLike, addComment, deleteComment,
    setModal, setAlert, deleteReview, deleteList, toggleFollow, follows,
  };

  if (!ready) return (
    <>
      <style>{CSS}</style>
      <div className="landing">
        <div className="landing-inner">
          <div className="landing-logo"><span className="landing-note">♪</span><span className="landing-wordmark">noteworthy</span></div>
          <div className="auth-loading"><div className="auth-spin" /><span>Loading…</span></div>
        </div>
      </div>
    </>
  );

  if (!profile) return (
    <>
      <style>{CSS}</style>
      <div className="landing">
        <div className="landing-inner">
          <div className="landing-logo"><span className="landing-note">♪</span><span className="landing-wordmark">noteworthy</span></div>
          <p className="landing-tagline">Track the music you've heard.<br />Tell your friends what's worth it.</p>
          <button className="landing-btn" onClick={async () => { window.location.href = await getSpotifyAuthUrl(); }}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="#fff"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424a.622.622 0 01-.857.207c-2.348-1.435-5.304-1.76-8.785-.964a.622.622 0 11-.277-1.215c3.809-.87 7.077-.496 9.712 1.115a.623.623 0 01.207.857zm1.223-2.722a.78.78 0 01-1.072.257c-2.687-1.652-6.785-2.131-9.965-1.166a.78.78 0 01-.973-.519.781.781 0 01.519-.972c3.632-1.102 8.147-.568 11.234 1.328a.78.78 0 01.257 1.072zm.105-2.835c-3.223-1.914-8.54-2.09-11.618-1.156a.935.935 0 11-.543-1.79c3.532-1.073 9.404-.865 13.115 1.338a.935.935 0 01-.954 1.608z" /></svg>
            Continue with Spotify
          </button>
          <p className="landing-fine">Noteworthy uses Spotify to power music search.<br />Your listening history is never stored.</p>
        </div>
      </div>
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      <div className="nw-app">
        {subPage && (
          <div className="subpage-ov">
            {subPage.page === "reviewDetail" && <ReviewDetailPage review={reviews.find(r => r.id === subPage.reviewId)} {...shared} goBack={goBack} />}
            {subPage.page === "profile" && <ProfilePage userId={subPage.userId} {...shared} goBack={goBack} />}
            {subPage.page === "listDetail" && <ListDetailPage list={lists.find(l => l.id === subPage.listId)} {...shared} goBack={goBack} />}
          </div>
        )}
        <div className="nw-main">
          {tab === "feed" && <FeedTab     {...shared} signOut={signOut} hasToken={!!tokenStore.accessToken} />}
          {tab === "discover" && <DiscoverTab {...shared} />}
          {tab === "activity" && <ActivityTab {...shared} />}
          {tab === "lists" && <ListsTab    {...shared} />}
          {tab === "profile" && <MyProfileTab {...shared} />}
        </div>
        <nav className="tab-bar">
          {[
            { id: "feed", label: "Feed", svg: <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H5a1 1 0 01-1-1V9.5z M9 21V12h6v9" strokeWidth="1.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /> },
            { id: "discover", label: "Discover", svg: <><circle cx="11" cy="11" r="7" strokeWidth="1.5" fill="none" stroke="currentColor" /><path d="M16.5 16.5L21 21" strokeWidth="1.5" strokeLinecap="round" stroke="currentColor" /></> },
            { id: "activity", label: "Activity", svg: <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" strokeWidth="1.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /> },
            { id: "lists", label: "Lists", svg: <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 12h6M9 16h4" strokeWidth="1.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /> },
            { id: "profile", label: "Profile", svg: <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" strokeWidth="1.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /> },
          ].map(t => (
            <button key={t.id} className={`tab-item ${tab === t.id ? "active" : ""}`} onClick={() => { setTab(t.id); setSubPage(null); }}>
              <svg viewBox="0 0 24 24" width="23" height="23">{t.svg}</svg>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Global FAB — always fixed, floats above tab bar */}
      {!subPage && (
        <button className="nw-fab" onClick={() => setModal({ type: "newReview" })} title="Write a review">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      )}

      {modal?.type === "newReview" && <ReviewModal onClose={() => setModal(null)} onSubmit={addReview} />}
      {modal?.type === "editReview" && <ReviewModal initItem={modal.review.item} initStars={modal.review.stars} initText={modal.review.text} isEdit onClose={() => setModal(null)} onSubmit={(_, s, t) => editReview(modal.review.id, s, t)} />}
      {modal?.type === "newReviewWithItem" && <ReviewModal initItem={modal.item} onClose={() => setModal(null)} onSubmit={addReview} />}
      {modal?.type === "newList" && <ListModal onClose={() => setModal(null)} onSubmit={addList} />}
      {modal?.type === "editList" && <ListModal initList={modal.list} isEdit onClose={() => setModal(null)} onSubmit={(t, d, i) => editList(modal.list.id, t, d, i)} />}

      {alert && <Alert title={alert.title} message={alert.message} actions={alert.actions} onClose={() => setAlert(null)} />}
      {toast && <div className={`nw-toast ${toast.type || ""}`}>{toast.msg}</div>}
    </>
  );
}

/* ── Feed Tab ── */
function FeedTab({ reviews, allUsers, currentUser, myId, myFollowing, toggleLike, navigate, setModal, deleteReview, signOut, hasToken }) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    const fn = e => { if (!menuRef.current?.contains(e.target)) setUserMenuOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);
  const feed = reviews.filter(r => r.userId === myId || myFollowing.includes(r.userId)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return (
    <div className="screen">
      <header className="nw-header">
        <span className="nw-logo">noteworthy</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="header-btn" onClick={() => setModal({ type: "newReview" })}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            Review
          </button>
          <div ref={menuRef} style={{ position: "relative" }}>
            <button className="avatar-btn" onClick={() => setUserMenuOpen(v => !v)}>
              <Avatar user={currentUser} size={32} />
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#888" strokeWidth="2.5" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {userMenuOpen && (
              <div className="user-menu">
                <div className="user-menu-info">
                  <Avatar user={currentUser} size={36} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{currentUser?.display_name}</div>
                    <div style={{ fontSize: 12, color: "#555" }}>{currentUser?.id}</div>
                  </div>
                </div>
                <button className="user-menu-item" onClick={() => { setUserMenuOpen(false); signOut(); }}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="sticky-search">
        <InlineSearch onSelect={item => setModal({ type: "newReviewWithItem", item })} placeholder="Search to review a song or album…" />
      </div>
      <div className="scroll-area">
        {feed.length === 0 ? (
          <>
            <RecentlyPlayed onReview={item => setModal({ type: "newReviewWithItem", item })} title="Your Recent Listening" />
            <div className="empty-feed" style={{ paddingTop: 32 }}>
              <h2 className="empty-h">Start your diary</h2>
              <p className="empty-p">Tap any track above to review it, or search for something you've been listening to.</p>
              <button className="empty-cta" onClick={() => setModal({ type: "newReview" })}>Write a review</button>
            </div>
          </>
        ) : (
          feed.map(r => <ReviewCard key={r.id} review={r} currentUser={currentUser} allUsers={allUsers} toggleLike={toggleLike} navigate={navigate} onEdit={rev => setModal({ type: "editReview", review: rev })} onDelete={id => deleteReview(id)} />)
        )}
      </div>
    </div>
  );
}

/* ── Discover Tab ── */
function DiscoverTab({ reviews, allUsers, currentUser, myId, myFollowing, toggleLike, navigate, setModal, deleteReview, toggleFollow, follows }) {
  const [mainTab, setMainTab] = useState("music");
  const [peopleQ, setPeopleQ] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [activeType, setActiveType] = useState("tracks");
  const [searchQ, setSearchQ] = useState("");
  const deb = useRef(null);
  const community = [...reviews].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 20);
  const allKnownUsers = Object.values(allUsers).filter(u => u.id !== myId);
  const peopleResults = peopleQ.trim() ? allKnownUsers.filter(u => (u.display_name || "").toLowerCase().includes(peopleQ.toLowerCase()) || (u.id || "").toLowerCase().includes(peopleQ.toLowerCase())) : allKnownUsers;

  useEffect(() => {
    if (!searchQ.trim()) { setSearchResults(null); return; }
    clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      setSearching(true);
      try {
        const token = await ensureToken();
        if (!token) { setSearching(false); return; }
        const d = await spSearch(searchQ, "track,album", token);
        const tracks = (d?.tracks?.items || []).map(t => ({ id: t.id, type: "track", title: t.name, artist: t.artists.map(a => a.name).join(", "), cover: t.album?.images?.[0]?.url, year: t.album?.release_date?.slice(0, 4) }));
        const albums = (d?.albums?.items || []).map(a => ({ id: a.id, type: "album", title: a.name, artist: a.artists.map(x => x.name).join(", "), cover: a.images?.[0]?.url, year: a.release_date?.slice(0, 4) }));
        setSearchResults({ tracks, albums });
      } catch (e) { console.error(e); }
      setSearching(false);
    }, 340);
  }, [searchQ]);

  const displayed = activeType === "tracks" ? (searchResults?.tracks || []) : (searchResults?.albums || []);

  return (
    <div className="screen">
      <header className="nw-header"><span className="nw-logo">Discover</span></header>
      <div className="sticky-search">
        {mainTab === "music" ? (
          <div className="isb-wrap">
            <div className="isb-field">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></svg>
              <input className="isb-input" placeholder="Search Spotify to review…" value={searchQ} onChange={e => setSearchQ(e.target.value)} />
              {searching && <div className="isb-spin" />}
              {searchQ && !searching && <button className="isb-x" onClick={() => { setSearchQ(""); setSearchResults(null); }}>✕</button>}
            </div>
          </div>
        ) : (
          <div className="isb-wrap">
            <div className="isb-field">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></svg>
              <input className="isb-input" placeholder="Search by name…" value={peopleQ} onChange={e => setPeopleQ(e.target.value)} />
            </div>
          </div>
        )}
      </div>
      <div className="scroll-area">
        <div className="seg-ctrl">
          {["music", "people"].map(t => (
            <button key={t} className={`seg-btn ${mainTab === t ? "active" : ""}`} onClick={() => setMainTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {mainTab === "music" && (
          <>
            {searchResults && (
              <>
                <div className="pill-row">
                  {[["tracks", "Tracks"], ["albums", "Albums"]].map(([k, l]) => (
                    <button key={k} className={`pill ${activeType === k ? "active" : ""}`} onClick={() => setActiveType(k)}>{l}</button>
                  ))}
                </div>
                {displayed.map(item => (
                  <div key={item.id} className="search-res-row">
                    <CoverArt item={item} size={44} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="srr-title">{item.title}</div>
                      <div className="srr-meta">{item.artist}{item.year ? ` · ${item.year}` : ""}</div>
                    </div>
                    <button className="btn-chip" onClick={() => setModal({ type: "newReviewWithItem", item })}>Review</button>
                  </div>
                ))}
                {displayed.length === 0 && <div className="empty-inline">No results.</div>}
              </>
            )}
            {!searchResults && (
              <>
                <div className="sect-label">Community Reviews</div>
                {community.length === 0 ? <div className="empty-inline">No reviews yet — be the first!</div>
                  : community.map(r => <ReviewCard key={r.id} review={r} currentUser={currentUser} allUsers={allUsers} toggleLike={toggleLike} navigate={navigate} onEdit={rev => setModal({ type: "editReview", review: rev })} onDelete={id => deleteReview(id)} />)
                }
              </>
            )}
          </>
        )}
        {mainTab === "people" && (
          <>
            {peopleResults.length === 0 && <div className="empty-inline">{peopleQ ? "No users found." : "No other users yet. As friends join Noteworthy, they'll appear here."}</div>}
            {peopleResults.map(u => {
              const isFollowing = (follows[myId] || []).includes(u.id);
              const uReviews = reviews.filter(r => r.userId === u.id).length;
              return (
                <div key={u.id} className="people-row" onClick={() => navigate("profile", { userId: u.id })}>
                  <Avatar user={u} size={42} />
                  <div style={{ flex: 1 }}><div className="pr-name">{u.display_name || u.id}</div><div className="pr-meta">{uReviews} review{uReviews !== 1 ? "s" : ""}</div></div>
                  <button className={`btn-follow ${isFollowing ? "following" : ""}`} onClick={e => { e.stopPropagation(); toggleFollow(u.id, u); }}>
                    {isFollowing ? "Following" : "Follow"}
                  </button>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Activity Tab ── */
function ActivityTab({ reviews, allUsers, currentUser, myId, myFollowing, toggleLike, navigate, setModal, deleteReview }) {
  const activity = reviews.filter(r => myFollowing.includes(r.userId)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return (
    <div className="screen">
      <header className="nw-header"><span className="nw-logo">Activity</span></header>
      <div className="scroll-area">
        {activity.length === 0 ? <div className="empty-feed"><div className="empty-art">🔔</div><h2 className="empty-h">Nothing yet</h2><p className="empty-p">Reviews from people you follow will appear here.</p></div>
          : activity.map(r => <ReviewCard key={r.id} review={r} currentUser={currentUser} allUsers={allUsers} toggleLike={toggleLike} navigate={navigate} onEdit={rev => setModal({ type: "editReview", review: rev })} onDelete={id => deleteReview(id)} />)
        }
      </div>
    </div>
  );
}

/* ── Lists Tab ── */
function ListsTab({ lists, allUsers, currentUser, myId, navigate, setModal, setAlert, deleteList }) {
  return (
    <div className="screen">
      <header className="nw-header">
        <span className="nw-logo">Lists</span>
        <button className="header-btn" onClick={() => setModal({ type: "newList" })}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          New list
        </button>
      </header>
      <div className="scroll-area">
        {lists.length === 0 ? <div className="empty-feed"><div className="empty-art">📋</div><h2 className="empty-h">No lists yet</h2><p className="empty-p">Create a ranked list of your favorites.</p><button className="empty-cta" onClick={() => setModal({ type: "newList" })}>Create a list</button></div>
          : lists.map(l => <ListCard key={l.id} list={l} allUsers={allUsers} currentUser={currentUser} myId={myId} navigate={navigate} setModal={setModal} setAlert={setAlert} deleteList={deleteList} />)
        }
      </div>
    </div>
  );
}

function ListCard({ list, allUsers, currentUser, myId, navigate, setModal, setAlert, deleteList }) {
  const author = allUsers[list.userId]; const isOwn = list.userId === myId;
  const [menuOpen, setMenuOpen] = useState(false); const menuRef = useRef(null);
  useEffect(() => { const fn = e => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); }; document.addEventListener("mousedown", fn); return () => document.removeEventListener("mousedown", fn); }, []);
  return (
    <div className="list-card" onClick={() => navigate("listDetail", { listId: list.id })}>
      <div className="lc-top">
        <div style={{ flex: 1, minWidth: 0 }}><div className="lc-title">{list.title}</div>{list.description && <div className="lc-desc">{list.description}</div>}</div>
        {isOwn && (
          <div ref={menuRef} style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
            <button className="rc-menu-btn" onClick={() => setMenuOpen(v => !v)}><svg viewBox="0 0 24 24" width="15" height="15" fill="none"><circle cx="5" cy="12" r="1.4" fill="#555" /><circle cx="12" cy="12" r="1.4" fill="#555" /><circle cx="19" cy="12" r="1.4" fill="#555" /></svg></button>
            {menuOpen && <div className="rc-menu-drop"><button onClick={() => { setMenuOpen(false); setModal({ type: "editList", list }); }}>Edit</button><button className="danger" onClick={() => { setMenuOpen(false); deleteList(list.id); }}>Delete</button></div>}
          </div>
        )}
      </div>
      <div className="lc-items">
        {list.items.slice(0, 4).map((item, i) => (
          <div key={item.id} className="lc-row"><span className="lc-rank">{i + 1}</span><CoverArt item={item} size={34} /><div style={{ flex: 1, minWidth: 0 }}><div className="lc-iname">{item.title}</div><div className="lc-imeta">{item.artist}</div></div></div>
        ))}
        {list.items.length > 4 && <div className="lc-more">+{list.items.length - 4} more</div>}
      </div>
      {author && <div className="lc-foot"><Avatar user={author} size={16} /><span>{author.display_name || author.id} · {list.items.length} items</span></div>}
    </div>
  );
}

/* ── My Profile Tab ── */
function MyProfileTab(props) {
  const [tab, setTab] = useState("activity");
  const { currentUser, myId, reviews, lists, allUsers, toggleLike, navigate, setModal, setAlert, deleteReview, deleteList, follows } = props;
  const myReviews = reviews.filter(r => r.userId === myId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const myLists = lists.filter(l => l.userId === myId);
  const myFollowing = (follows[myId] || []).length;
  const myFollowers = Object.entries(follows).filter(([uid, arr]) => uid !== myId && arr.includes(myId)).length;
  return (
    <div className="screen">
      <header className="nw-header" style={{ borderBottom: "none" }}><span className="nw-logo" style={{ fontSize: 18 }}>{currentUser?.display_name}</span></header>
      <div className="scroll-area">
        <div className="profile-hero">
          <Avatar user={currentUser} size={70} />
          <div className="profile-stats">
            {[["Reviews", myReviews.length], ["Following", myFollowing], ["Followers", myFollowers]].map(([l, n]) => (
              <div key={l} className="ps"><div className="ps-n">{n}</div><div className="ps-l">{l}</div></div>
            ))}
          </div>
        </div>
        <div className="profile-name">{currentUser?.display_name}</div>
        {currentUser?.id && <div className="profile-handle">{currentUser.id}</div>}
        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          <button className="profile-act-btn" onClick={() => setModal({ type: "newReview" })}>+ Review</button>
          <button className="profile-act-btn" onClick={() => setModal({ type: "newList" })}>+ List</button>
        </div>
        <div className="seg-ctrl">
          {[["activity", "Activity"], ["reviews", `Reviews (${myReviews.length})`], ["lists", `Lists (${myLists.length})`]].map(([k, l]) => (
            <button key={k} className={`seg-btn ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        {tab === "activity" && <RecentlyPlayed onReview={item => setModal({ type: "newReviewWithItem", item })} title="Recently Played" />}
        {tab === "reviews" && (myReviews.length === 0 ? <div className="empty-feed"><div className="empty-art">⭐</div><h2 className="empty-h">No reviews yet</h2><button className="empty-cta" onClick={() => setModal({ type: "newReview" })}>Write your first review</button></div> : myReviews.map(r => <ReviewCard key={r.id} review={r} currentUser={currentUser} allUsers={allUsers} toggleLike={toggleLike} navigate={navigate} onEdit={rev => setModal({ type: "editReview", review: rev })} onDelete={id => deleteReview(id)} />))}
        {tab === "lists" && (myLists.length === 0 ? <div className="empty-feed"><div className="empty-art">📋</div><h2 className="empty-h">No lists yet</h2></div> : myLists.map(l => <ListCard key={l.id} list={l} allUsers={allUsers} currentUser={currentUser} myId={myId} navigate={navigate} setModal={setModal} setAlert={setAlert} deleteList={deleteList} />))}
      </div>
    </div>
  );
}

/* ── Profile Page (other users) ── */
function ProfilePage({ userId, reviews, lists, allUsers, currentUser, myId, myFollowing, follows, toggleLike, navigate, setModal, setAlert, deleteReview, deleteList, toggleFollow, goBack }) {
  const [tab, setTab] = useState("reviews");
  const user = allUsers[userId];
  const isFollowing = myFollowing.includes(userId);
  const userReviews = reviews.filter(r => r.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const userLists = lists.filter(l => l.userId === userId);
  const userFollowing = (follows[userId] || []).length;
  const userFollowers = Object.entries(follows).filter(([uid, arr]) => uid !== userId && arr.includes(userId)).length;

  if (!user) return (
    <div className="screen">
      <header className="nw-header"><button className="back-btn" onClick={goBack}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#007AFF" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg></button><span className="nw-logo" style={{ fontSize: 17 }}>Profile</span><div style={{ width: 32 }} /></header>
      <div className="scroll-area"><div className="empty-inline">User not found.</div></div>
    </div>
  );

  return (
    <div className="screen">
      <header className="nw-header" style={{ borderBottom: "none" }}>
        <button className="back-btn" onClick={goBack}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#007AFF" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg></button>
        <span className="nw-logo" style={{ fontSize: 17 }}>{user.display_name || user.id}</span>
        <div style={{ width: 32 }} />
      </header>
      <div className="scroll-area">
        <div className="profile-hero">
          <Avatar user={user} size={70} />
          <div className="profile-stats">
            {[["Reviews", userReviews.length], ["Following", userFollowing], ["Followers", userFollowers]].map(([l, n]) => (
              <div key={l} className="ps"><div className="ps-n">{n}</div><div className="ps-l">{l}</div></div>
            ))}
          </div>
        </div>
        <div className="profile-name">{user.display_name || user.id}</div>
        {userId !== myId && <button className={`profile-follow-btn ${isFollowing ? "following" : ""}`} onClick={() => toggleFollow(userId, user)}>{isFollowing ? "Following" : "Follow"}</button>}
        <div className="seg-ctrl">
          {[["reviews", `Reviews (${userReviews.length})`], ["lists", `Lists (${userLists.length})`]].map(([k, l]) => (
            <button key={k} className={`seg-btn ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        {tab === "reviews" && (userReviews.length === 0 ? <div className="empty-inline">No reviews yet.</div> : userReviews.map(r => <ReviewCard key={r.id} review={r} currentUser={currentUser} allUsers={allUsers} toggleLike={toggleLike} navigate={navigate} onEdit={rev => setModal({ type: "editReview", review: rev })} onDelete={id => deleteReview(id)} />))}
        {tab === "lists" && (userLists.length === 0 ? <div className="empty-inline">No lists yet.</div> : userLists.map(l => <ListCard key={l.id} list={l} allUsers={allUsers} currentUser={currentUser} myId={myId} navigate={navigate} setModal={setModal} setAlert={setAlert} deleteList={deleteList} />))}
      </div>
    </div>
  );
}

/* ── Review Detail ── */
function ReviewDetailPage({ review, reviews, allUsers, currentUser, myId, toggleLike, addComment, deleteComment, navigate, setModal, setAlert, deleteReview, goBack }) {
  const [text, setText] = useState("");
  if (!review) return null;
  const live = reviews.find(r => r.id === review.id) || review;
  const author = allUsers[live.userId];
  const liked = live.likes?.includes(myId);
  return (
    <div className="screen">
      <header className="nw-header">
        <button className="back-btn" onClick={goBack}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#007AFF" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg></button>
        <span className="nw-logo" style={{ fontSize: 17 }}>Review</span>
        {live.userId === myId && <button className="rc-menu-btn" onClick={() => setAlert({ title: null, message: null, actions: [{ label: "Edit", action: () => { setAlert(null); setModal({ type: "editReview", review: live }); } }, { label: "Delete", destructive: true, action: () => { setAlert(null); deleteReview(live.id); goBack(); } }, { label: "Cancel", action: () => setAlert(null) }] })}><svg viewBox="0 0 24 24" width="18" height="18" fill="none"><circle cx="5" cy="12" r="1.6" fill="#555" /><circle cx="12" cy="12" r="1.6" fill="#555" /><circle cx="19" cy="12" r="1.6" fill="#555" /></svg></button>}
      </header>
      <div className="scroll-area">
        <div className="rd-art-hero">
          {live.item.cover && <div className="rd-art-bg" style={{ backgroundImage: `url(${live.item.cover})` }} />}
          <CoverArt item={live.item} size={116} />
        </div>
        <div className="rd-info">
          <div className="rd-title">{live.item.title}</div>
          <div className="rd-artist">{live.item.artist}</div>
          <div className="rd-meta">{live.item.type === "album" ? "Album" : "Track"}{live.item.year ? ` · ${live.item.year}` : ""}</div>
          <div style={{ marginTop: 10 }}><Stars value={live.stars} size={20} /></div>
        </div>
        {author && <button className="rd-author" onClick={() => navigate("profile", { userId: author.id })}><Avatar user={author} size={28} /><div><div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{author.display_name || author.id}</div><div style={{ fontSize: 12, color: "#555" }}>{formatDate(live.createdAt)}</div></div></button>}
        {live.text && <div className="rd-body" dangerouslySetInnerHTML={{ __html: live.text }} />}
        <div className="rd-acts">
          <button className={`rc-act ${liked ? "liked" : ""}`} onClick={() => toggleLike(live.id)}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill={liked ? "#E9463F" : "none"} stroke={liked ? "#E9463F" : "#555"} strokeWidth="2" strokeLinecap="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
            {live.likes?.length || 0} {live.likes?.length === 1 ? "like" : "likes"}
          </button>
        </div>
        <div className="comments">
          <div className="sect-label" style={{ marginBottom: 12 }}>Comments · {live.comments?.length || 0}</div>
          {(live.comments || []).map(c => {
            const cu2 = allUsers[c.userId];
            return (
              <div key={c.id} className="comment-row">
                <Avatar user={cu2 || { display_name: c.userId }} size={26} />
                <div style={{ flex: 1 }}><span className="comment-author">{cu2?.display_name || c.userId} </span><span className="comment-text">{c.text}</span></div>
                {c.userId === myId && <button className="comment-del" onClick={() => deleteComment(live.id, c.id)}>✕</button>}
              </div>
            );
          })}
        </div>
        <div className="comment-compose">
          <Avatar user={currentUser} size={26} />
          <input className="comment-in" placeholder="Add a comment…" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && text.trim()) { addComment(live.id, text.trim()); setText(""); } }} />
          <button className="comment-post" disabled={!text.trim()} onClick={() => { if (text.trim()) { addComment(live.id, text.trim()); setText(""); } }}>Post</button>
        </div>
      </div>
    </div>
  );
}

/* ── List Detail ── */
function ListDetailPage({ list, lists, allUsers, currentUser, myId, navigate, setModal, setAlert, deleteList, goBack }) {
  if (!list) return null;
  const live = lists.find(l => l.id === list.id) || list;
  const author = allUsers[live.userId]; const isOwn = live.userId === myId;
  return (
    <div className="screen">
      <header className="nw-header">
        <button className="back-btn" onClick={goBack}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#007AFF" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg></button>
        <span className="nw-logo" style={{ fontSize: 17 }}>List</span>
        {isOwn && <button className="rc-menu-btn" onClick={() => setAlert({ title: null, message: null, actions: [{ label: "Edit List", action: () => { setAlert(null); setModal({ type: "editList", list: live }); } }, { label: "Delete List", destructive: true, action: () => { setAlert(null); deleteList(live.id); goBack(); } }, { label: "Cancel", action: () => setAlert(null) }] })}><svg viewBox="0 0 24 24" width="18" height="18" fill="none"><circle cx="5" cy="12" r="1.6" fill="#555" /><circle cx="12" cy="12" r="1.6" fill="#555" /><circle cx="19" cy="12" r="1.6" fill="#555" /></svg></button>}
      </header>
      <div className="scroll-area">
        <div className="ld-head"><div className="ld-title">{live.title}</div>{live.description && <div className="ld-desc">{live.description}</div>}
          {author && <button className="rd-author" style={{ marginTop: 8 }} onClick={() => navigate("profile", { userId: author.id })}><Avatar user={author} size={22} /><span style={{ fontSize: 13, color: "#555" }}>{author.display_name || author.id} · {live.items.length} items</span></button>}
        </div>
        {live.items.map((item, i) => (
          <div key={item.id} className="ld-row"><div className="ld-rank">{i + 1}</div><CoverArt item={item} size={46} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15, fontWeight: 600, color: "#e8e8e8" }}>{item.title}</div><div style={{ fontSize: 12, color: "#555" }}>{item.artist} · {item.type}</div></div></div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   CSS
═══════════════════════════════════════════════════════════════ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Titillium+Web:ital,wght@0,300;0,400;0,600;0,700;1,400&family=DM+Serif+Display:ital@0;1&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#14181c;--s1:#1f2429;--s2:#2c3440;--s3:#3a4352;--border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);--text:#e8e8e8;--text2:#9ab;--text3:#678;--text4:#445566;--green:#00c030;--gold:#F5C518;--red:#E9463F;--blue:#40bcf4;--font:'Titillium Web',-apple-system,sans-serif;--serif:'DM Serif Display',Georgia,serif;--tab-h:64px}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font);-webkit-font-smoothing:antialiased}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes slideUp{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes popIn{from{transform:scale(.9);opacity:0}to{transform:scale(1);opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

.landing{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg)}
.landing-inner{display:flex;flex-direction:column;align-items:center;gap:22px;padding:40px 24px;max-width:380px;text-align:center;animation:slideUp .4s ease}
.landing-logo{display:flex;align-items:center;gap:12px}
.landing-note{font-size:36px;color:var(--green)}
.landing-wordmark{font-family:var(--serif);font-size:34px;font-style:italic;color:var(--text);letter-spacing:-.5px}
.landing-tagline{font-size:16px;color:var(--text2);line-height:1.65}
.landing-btn{display:flex;align-items:center;gap:10px;background:#1DB954;color:#000;border:none;font-family:var(--font);font-size:16px;font-weight:700;padding:14px 28px;border-radius:50px;cursor:pointer;transition:transform .15s,box-shadow .15s;box-shadow:0 4px 20px rgba(29,185,84,.35)}
.landing-btn:hover{transform:scale(1.04);box-shadow:0 6px 28px rgba(29,185,84,.5)}
.landing-fine{font-size:12px;color:var(--text4);line-height:1.5}
.auth-loading{display:flex;align-items:center;gap:12px;color:var(--text2);font-size:15px}
.auth-spin{width:20px;height:20px;border:2px solid var(--s3);border-top-color:var(--green);border-radius:50%;animation:spin .8s linear infinite}

.nw-app{max-width:430px;margin:0 auto;min-height:100vh;background:var(--bg);position:relative}
.nw-main{padding-bottom:var(--tab-h)}
.screen{display:flex;flex-direction:column;min-height:100vh}
.subpage-ov{position:fixed;inset:0;z-index:100;background:var(--bg);overflow-y:auto;max-width:430px;margin:0 auto;animation:slideUp .2s ease}

.nw-header{display:flex;align-items:center;justify-content:space-between;padding:48px 16px 12px;position:sticky;top:0;z-index:20;background:rgba(20,24,28,.93);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid var(--border)}
.nw-logo{font-family:var(--serif);font-size:22px;color:var(--text);font-style:italic;letter-spacing:-.3px}
.back-btn{background:none;border:none;cursor:pointer;padding:4px;display:flex;align-items:center;width:32px}
.header-btn{display:flex;align-items:center;gap:5px;background:var(--green);color:#000;border:none;font-family:var(--font);font-size:13px;font-weight:700;padding:7px 14px;border-radius:4px;cursor:pointer;transition:opacity .15s}
.header-btn:hover{opacity:.88}
.avatar-btn{display:flex;align-items:center;gap:5px;background:none;border:none;cursor:pointer;padding:3px;border-radius:20px}
.user-menu{position:absolute;top:calc(100% + 8px);right:0;background:var(--s2);border:1px solid var(--border2);border-radius:10px;min-width:200px;overflow:hidden;z-index:300;box-shadow:0 8px 32px rgba(0,0,0,.7);animation:slideUp .15s ease}
.user-menu-info{display:flex;align-items:center;gap:10px;padding:14px 14px 12px;border-bottom:1px solid var(--border)}
.user-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:11px 14px;background:none;border:none;color:var(--text2);font-family:var(--font);font-size:14px;cursor:pointer;transition:background .1s}
.user-menu-item:hover{background:var(--s3);color:var(--text)}

.sticky-search{padding:8px 14px;background:rgba(20,24,28,.93);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);position:sticky;top:85px;z-index:19;border-bottom:1px solid var(--border)}
.scroll-area{flex:1;padding:14px 14px 28px}
.sect-label{font-size:11px;font-weight:700;color:var(--text3);letter-spacing:1px;text-transform:uppercase;margin-bottom:12px}

.isb-wrap{position:relative;width:100%}
.isb-field{display:flex;align-items:center;gap:8px;background:var(--s2);border-radius:6px;padding:0 12px;height:40px;border:1px solid var(--border)}
.isb-input{flex:1;background:none;border:none;outline:none;color:var(--text);font-family:var(--font);font-size:14px}
.isb-input::placeholder{color:var(--text4)}
.isb-spin{width:13px;height:13px;border:2px solid var(--s3);border-top-color:var(--blue);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
.isb-x{background:none;border:none;color:var(--text4);cursor:pointer;font-size:11px;padding:2px}
.isb-drop{position:absolute;top:calc(100% + 5px);left:0;right:0;background:var(--s1);border:1px solid var(--border2);border-radius:8px;overflow:hidden;z-index:200;box-shadow:0 8px 32px rgba(0,0,0,.7);animation:slideUp .14s ease}
.isb-tabs{display:flex;border-bottom:1px solid var(--border)}
.isb-tab{flex:1;background:none;border:none;color:var(--text3);font-family:var(--font);font-size:12px;font-weight:600;padding:9px 0;cursor:pointer;transition:color .1s;letter-spacing:.3px}
.isb-tab.active{color:var(--green)}
.isb-list{max-height:260px;overflow-y:auto}
.isb-row{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;background:none;border:none;cursor:pointer;transition:background .1s;border-bottom:1px solid var(--border)}
.isb-row:last-child{border-bottom:none}
.isb-row:hover{background:var(--s2)}
.isb-name{font-size:13px;font-weight:600;color:var(--text);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:185px}
.isb-meta{font-size:11px;color:var(--text3);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.isb-badge{font-size:10px;font-weight:700;color:var(--text4);background:var(--s3);padding:2px 6px;border-radius:3px;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap}

.tab-bar{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:rgba(20,24,28,.97);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-top:1px solid var(--border);display:flex;height:var(--tab-h);z-index:50}
.tab-item{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;background:none;border:none;cursor:pointer;color:var(--text4);transition:color .15s;font-family:var(--font);font-size:10px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;padding:0}
.tab-item.active{color:var(--green)}

.nw-fab{position:fixed;bottom:calc(var(--tab-h) + 18px);right:max(18px,calc(50vw - 215px + 18px));width:52px;height:52px;border-radius:50%;background:var(--green);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(0,192,48,.5),0 2px 8px rgba(0,0,0,.4);z-index:60;transition:transform .15s,box-shadow .15s}
.nw-fab:hover{transform:scale(1.07);box-shadow:0 6px 26px rgba(0,192,48,.65),0 2px 10px rgba(0,0,0,.4)}
.nw-fab:active{transform:scale(.93)}

.rc{display:flex;flex-direction:column;background:var(--s1);border-radius:6px;margin-bottom:12px;overflow:hidden;border:1px solid var(--border);transition:border-color .15s}
.rc:hover{border-color:var(--border2)}
.rc-art{position:relative;width:100%;aspect-ratio:1/1;max-height:300px;overflow:hidden;cursor:pointer}
.rc-art-img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .3s}
.rc:hover .rc-art-img{transform:scale(1.02)}
.rc-art-bg{width:100%;height:100%;background:linear-gradient(135deg,hsl(calc(var(--h,200)*1deg),35%,12%),hsl(calc((var(--h,200)+50)*1deg),30%,8%))}
.rc-art-fade{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 45%,rgba(20,24,28,.95) 100%)}
.rc-art-stars{position:absolute;bottom:10px;right:10px}
.rc-art-badge{position:absolute;top:10px;left:10px;background:rgba(20,24,28,.6);backdrop-filter:blur(6px);color:rgba(255,255,255,.6);font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;padding:3px 7px;border-radius:3px}
.rc-body{padding:11px 13px 13px}
.rc-track-row{cursor:pointer;margin-bottom:8px}
.rc-track-name{font-family:var(--serif);font-size:17px;font-style:italic;color:var(--text);line-height:1.2}
.rc-track-sub{font-size:12px;color:var(--text3);margin-top:2px}
.rc-meta-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.rc-author{display:flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;padding:0}
.rc-author-name{font-size:12px;font-weight:600;color:var(--text2);transition:color .1s}
.rc-author:hover .rc-author-name{color:var(--green)}
.rc-date{font-size:11px;color:var(--text4)}
.rc-menu-btn{background:none;border:none;cursor:pointer;padding:4px;display:flex;align-items:center}
.rc-menu-drop{position:absolute;top:calc(100% + 4px);right:0;background:var(--s2);border:1px solid var(--border2);border-radius:7px;overflow:hidden;z-index:200;min-width:110px;box-shadow:0 6px 20px rgba(0,0,0,.7);animation:slideUp .12s ease}
.rc-menu-drop button{display:block;width:100%;padding:10px 14px;background:none;border:none;color:var(--text2);font-family:var(--font);font-size:13px;text-align:left;cursor:pointer;transition:background .1s}
.rc-menu-drop button:hover{background:var(--s3);color:var(--text)}
.rc-menu-drop button.danger{color:#e44}
.rc-menu-drop button.danger:hover{background:rgba(228,68,68,.12)}
.rc-snippet{font-size:13px;color:var(--text2);line-height:1.6;margin-bottom:9px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;cursor:pointer}
.rc-snippet p{margin-bottom:4px}
.rc-snippet strong{color:var(--text)}
.rc-snippet em{font-style:italic}
.rc-snippet blockquote{border-left:2px solid var(--green);padding-left:8px;color:var(--text3);font-style:italic}
.rc-actions{display:flex;gap:12px}
.rc-act{display:flex;align-items:center;gap:4px;background:none;border:none;cursor:pointer;color:var(--text4);font-family:var(--font);font-size:12px;padding:0;transition:color .12s}
.rc-act:hover{color:var(--text2)}
.rc-act.liked{color:var(--red)}

.seg-ctrl{display:flex;background:var(--s2);border-radius:5px;padding:2px;margin-bottom:16px;gap:2px}
.seg-btn{flex:1;border:none;background:none;color:var(--text3);font-family:var(--font);font-size:12px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;padding:7px 0;border-radius:4px;cursor:pointer;transition:all .15s}
.seg-btn.active{background:var(--s3);color:var(--text)}

.people-row{display:flex;align-items:center;gap:12px;padding:11px;background:var(--s1);border-radius:6px;margin-bottom:7px;border:1px solid var(--border);cursor:pointer;transition:border-color .1s}
.people-row:hover{border-color:var(--border2)}
.pr-name{font-size:14px;font-weight:600;color:var(--text)}
.pr-meta{font-size:12px;color:var(--text3);margin-top:1px}
.btn-follow{background:none;border:1px solid var(--green);color:var(--green);font-family:var(--font);font-size:12px;font-weight:700;padding:6px 14px;border-radius:4px;cursor:pointer;white-space:nowrap;transition:all .15s}
.btn-follow:hover{background:var(--green);color:#000}
.btn-follow.following{border-color:var(--s3);color:var(--text3)}
.btn-chip{background:none;border:1px solid var(--green);color:var(--green);font-family:var(--font);font-size:12px;font-weight:700;padding:5px 12px;border-radius:4px;cursor:pointer;white-space:nowrap;transition:all .15s}
.btn-chip:hover{background:var(--green);color:#000}

.search-res-row{display:flex;align-items:center;gap:11px;padding:9px 11px;background:var(--s1);border-radius:6px;margin-bottom:6px;border:1px solid var(--border)}
.srr-title{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.srr-meta{font-size:11px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill-row{display:flex;gap:7px;margin-bottom:13px}
.pill{background:var(--s2);border:1px solid var(--border);color:var(--text3);font-family:var(--font);font-size:12px;font-weight:600;padding:5px 14px;border-radius:20px;cursor:pointer;transition:all .15s}
.pill.active{background:var(--green);border-color:var(--green);color:#000}

.profile-hero{display:flex;align-items:center;gap:18px;padding:6px 0 18px}
.profile-stats{display:flex;flex:1}
.ps{flex:1;text-align:center}
.ps-n{font-size:20px;font-weight:700;color:var(--text);font-family:var(--serif)}
.ps-l{font-size:11px;color:var(--text3);margin-top:1px;letter-spacing:.3px;text-transform:uppercase}
.profile-name{font-size:20px;font-weight:700;font-family:var(--serif);font-style:italic;color:var(--text);margin-bottom:3px}
.profile-handle{font-size:12px;color:var(--text4);margin-bottom:18px}
.profile-follow-btn{width:100%;background:none;border:1px solid var(--green);color:var(--green);font-family:var(--font);font-size:15px;font-weight:700;padding:12px;border-radius:5px;cursor:pointer;margin-bottom:18px;transition:all .15s}
.profile-follow-btn:hover{background:var(--green);color:#000}
.profile-follow-btn.following{border-color:var(--s3);color:var(--text3)}
.profile-act-btn{flex:1;background:var(--s2);border:1px solid var(--border2);color:var(--text2);font-family:var(--font);font-size:13px;font-weight:600;padding:10px;border-radius:5px;cursor:pointer;margin-bottom:18px;transition:background .15s}
.profile-act-btn:hover{background:var(--s3)}

.list-card{background:var(--s1);border-radius:6px;padding:14px;margin-bottom:10px;cursor:pointer;border:1px solid var(--border);transition:border-color .1s}
.list-card:hover{border-color:var(--border2)}
.lc-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px}
.lc-title{font-size:16px;font-weight:700;font-family:var(--serif);font-style:italic;color:var(--text)}
.lc-desc{font-size:12px;color:var(--text3);margin-top:3px}
.lc-items{display:flex;flex-direction:column;gap:7px;margin-bottom:10px}
.lc-row{display:flex;align-items:center;gap:10px}
.lc-rank{font-size:13px;font-weight:700;color:var(--green);width:17px;flex-shrink:0}
.lc-iname{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lc-imeta{font-size:11px;color:var(--text3)}
.lc-more{font-size:11px;color:var(--text4);padding-top:2px}
.lc-foot{display:flex;align-items:center;gap:7px;padding-top:9px;border-top:1px solid var(--border);font-size:11px;color:var(--text4)}

.rd-art-hero{position:relative;display:flex;justify-content:center;padding:24px 0 18px;overflow:hidden;margin:-14px -14px 0}
.rd-art-bg{position:absolute;inset:0;background-size:cover;background-position:center;filter:blur(28px) brightness(.28);transform:scale(1.1)}
.rd-info{padding:14px 0 14px;border-bottom:1px solid var(--border);margin-bottom:12px}
.rd-title{font-size:22px;font-weight:700;font-family:var(--serif);font-style:italic;color:var(--text);line-height:1.2}
.rd-artist{font-size:14px;color:var(--text2);margin-top:4px}
.rd-meta{font-size:12px;color:var(--text3);margin-top:3px}
.rd-author{display:flex;align-items:center;gap:10px;background:none;border:none;cursor:pointer;padding:10px 0;width:100%}
.rd-body{font-size:14px;color:var(--text2);line-height:1.75;padding:12px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin:4px 0 10px}
.rd-body p{margin-bottom:8px}.rd-body p:last-child{margin-bottom:0}
.rd-body strong{color:var(--text);font-weight:600}.rd-body em{font-style:italic}
.rd-body blockquote{border-left:3px solid var(--green);padding-left:12px;color:var(--text3);font-style:italic;margin:10px 0}
.rd-body h3{font-size:15px;font-weight:700;color:var(--text);margin-bottom:5px;font-family:var(--serif)}
.rd-body ul{padding-left:18px}.rd-body li{margin-bottom:3px}
.rd-acts{display:flex;gap:14px;padding:8px 0}

.comments{padding-top:4px}
.comment-row{display:flex;align-items:flex-start;gap:9px;padding:9px 0;border-bottom:1px solid var(--border)}
.comment-author{font-size:13px;font-weight:600;color:var(--text)}
.comment-text{font-size:13px;color:var(--text2)}
.comment-del{background:none;border:none;color:var(--text4);cursor:pointer;font-size:11px;padding:3px;flex-shrink:0}
.comment-compose{display:flex;align-items:center;gap:9px;padding:12px 0 24px}
.comment-in{flex:1;background:var(--s2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:var(--font);font-size:13px;padding:8px 12px;outline:none}
.comment-in:focus{border-color:var(--green)}
.comment-post{background:none;border:none;color:var(--green);font-family:var(--font);font-size:13px;font-weight:700;cursor:pointer;padding:0 4px}
.comment-post:disabled{opacity:.4}

.ld-head{padding-bottom:16px;border-bottom:1px solid var(--border);margin-bottom:12px}
.ld-title{font-size:24px;font-weight:700;font-family:var(--serif);font-style:italic;color:var(--text);margin-bottom:5px}
.ld-desc{font-size:14px;color:var(--text3)}
.ld-row{display:flex;align-items:center;gap:11px;padding:9px 0;border-bottom:1px solid var(--border)}
.ld-rank{font-size:15px;font-weight:700;color:var(--green);width:24px;flex-shrink:0;font-family:var(--serif)}

.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:300;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);animation:fadeIn .17s ease}
.modal-box{background:var(--s1);border-radius:10px;width:100%;max-width:420px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border2);box-shadow:0 24px 60px rgba(0,0,0,.85);animation:popIn .22s cubic-bezier(.34,1.4,.64,1)}
.modal-box-lg{max-height:92vh}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 13px;border-bottom:1px solid var(--border);flex-shrink:0}
.modal-title{font-family:var(--serif);font-size:18px;font-style:italic;color:var(--text)}
.modal-x{background:var(--s2);border:none;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text3)}
.modal-body{flex:1;overflow-y:auto;padding:16px 18px 22px;display:flex;flex-direction:column;gap:14px}
.modal-hint{font-size:13px;color:var(--text3)}
.modal-manual{background:var(--s2);border-radius:7px;padding:13px}
.modal-manual p{font-size:13px;color:var(--text3);margin-bottom:0}
.modal-input{background:var(--s3);border:none;border-radius:5px;color:var(--text);font-family:var(--font);font-size:14px;padding:9px 11px;outline:none;min-width:0}
.modal-input::placeholder{color:var(--text4)}
.modal-go{background:var(--green);border:none;color:#000;font-family:var(--font);font-size:14px;font-weight:700;padding:9px 14px;border-radius:5px;cursor:pointer;white-space:nowrap}
.modal-hero{display:flex;gap:14px;align-items:flex-start;background:var(--s2);border-radius:8px;padding:14px;position:relative;overflow:hidden}
.modal-cover-wrap{position:relative;flex-shrink:0;z-index:1}
.modal-glow{position:absolute;inset:-16px;background-size:cover;background-position:center;filter:blur(22px);opacity:.35;z-index:0;pointer-events:none}
.modal-item-title{font-size:16px;font-weight:700;color:var(--text);font-family:var(--serif);font-style:italic;line-height:1.2;position:relative;z-index:1}
.modal-item-artist{font-size:13px;color:var(--text2);margin-top:3px;position:relative;z-index:1}
.modal-item-meta{font-size:11px;color:var(--text3);margin-top:2px;position:relative;z-index:1}
.modal-item-info{flex:1;min-width:0;display:flex;flex-direction:column;position:relative;z-index:1}
.modal-change{display:inline-flex;align-items:center;gap:4px;background:none;border:none;color:var(--text4);font-family:var(--font);font-size:11px;cursor:pointer;padding:4px 0;margin-top:6px;transition:color .1s}
.modal-change:hover{color:var(--green)}
.modal-rating{display:flex;align-items:center;gap:12px}
.modal-rating-label{font-size:12px;color:var(--text3);font-weight:600;letter-spacing:.4px;text-transform:uppercase}
.modal-rating-word{font-size:13px;color:var(--gold);font-weight:700;letter-spacing:.3px;text-transform:uppercase}
.modal-submit{width:100%;background:var(--green);border:none;color:#000;font-family:var(--font);font-size:15px;font-weight:700;padding:14px;border-radius:6px;cursor:pointer;transition:opacity .15s;flex-shrink:0}
.modal-submit:disabled{opacity:.35;cursor:not-allowed}

.rich-wrap{border:1px solid var(--s3);border-radius:6px;overflow:hidden;background:var(--s2)}
.rich-bar{display:flex;gap:1px;padding:5px 8px;border-bottom:1px solid var(--s3);background:rgba(0,0,0,.2);flex-wrap:wrap}
.rich-btn{background:none;border:none;color:var(--text3);font-family:var(--font);font-size:13px;padding:4px 8px;border-radius:4px;cursor:pointer;transition:all .1s;min-width:28px;display:flex;align-items:center;justify-content:center}
.rich-btn:hover{background:var(--s3);color:var(--text)}
.rich-body{padding:11px 13px;min-height:100px;outline:none;color:var(--text2);font-family:var(--font);font-size:14px;line-height:1.65;caret-color:var(--green)}
.rich-body:empty::before{content:attr(data-ph);color:var(--text4);pointer-events:none;display:block}
.rich-body p{margin-bottom:7px}
.rich-body blockquote{border-left:3px solid var(--green);padding-left:11px;color:var(--text3);font-style:italic;margin:7px 0}
.rich-body h3{font-size:15px;font-weight:700;color:var(--text);margin-bottom:5px}
.rich-body ul{padding-left:16px}.rich-body li{margin-bottom:2px}
.rich-body strong{color:var(--text)}

.list-edit-items{display:flex;flex-direction:column;gap:5px;max-height:200px;overflow-y:auto;margin-top:8px}
.list-edit-label{font-size:10px;font-weight:700;color:var(--text4);letter-spacing:.6px;text-transform:uppercase;margin-bottom:6px}
.list-edit-row{display:flex;align-items:center;gap:9px;padding:7px 9px;background:var(--s3);border-radius:5px}
.list-edit-rank{font-size:13px;font-weight:700;color:var(--green);width:18px;flex-shrink:0;font-family:var(--serif)}
.lm-btn{background:var(--s2);border:none;color:var(--text3);font-size:11px;width:22px;height:22px;border-radius:4px;cursor:pointer;transition:all .1s;display:flex;align-items:center;justify-content:center}
.lm-btn:hover:not(:disabled){background:var(--green);color:#000}
.lm-btn.danger:hover{background:var(--red);color:#fff}
.lm-btn:disabled{opacity:.28}

.empty-feed{display:flex;flex-direction:column;align-items:center;padding:56px 20px;gap:12px;text-align:center}
.empty-art{font-size:46px}
.empty-h{font-size:18px;font-weight:700;color:var(--text);font-family:var(--serif);font-style:italic}
.empty-p{font-size:14px;color:var(--text3);line-height:1.55;max-width:260px}
.empty-cta{background:none;border:1px solid var(--green);color:var(--green);font-family:var(--font);font-size:13px;font-weight:700;padding:9px 22px;border-radius:4px;cursor:pointer;transition:all .15s}
.empty-cta:hover{background:var(--green);color:#000}
.empty-inline{font-size:13px;color:var(--text4);padding:24px 0;text-align:center}

.rp-wrap{margin-bottom:24px}
.rp-header-row{display:flex;align-items:center;gap:6px;margin-bottom:10px}
.rp-header{font-size:11px;font-weight:700;color:var(--text3);letter-spacing:1px;text-transform:uppercase;flex:1}
.rp-hint{font-size:10px;color:var(--text4);letter-spacing:.3px}
.rp-scroll{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none;-ms-overflow-style:none}
.rp-scroll::-webkit-scrollbar{display:none}
.rp-card{flex-shrink:0;width:96px;cursor:pointer}
.rp-art-wrap{position:relative;width:96px;height:96px;border-radius:6px;overflow:hidden;margin-bottom:7px}
.rp-art{width:100%;height:100%;object-fit:cover;display:block;transition:transform .25s}
.rp-card:hover .rp-art{transform:scale(1.06)}
.rp-art-fallback{width:100%;height:100%;background:linear-gradient(135deg,hsl(calc(var(--h,200)*1deg),35%,14%),hsl(calc((var(--h,200)+50)*1deg),30%,9%))}
.rp-hover-layer{position:absolute;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s;border-radius:6px}
.rp-card:hover .rp-hover-layer{opacity:1}
.rp-name{font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
.rp-artist{font-size:10px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.rp-skeleton{flex-shrink:0;width:96px;height:96px;border-radius:6px;background:linear-gradient(90deg,var(--s2) 25%,var(--s3) 50%,var(--s2) 75%);background-size:200% 100%;animation:shimmer 1.4s infinite}

.nw-toast{position:fixed;top:54px;left:50%;transform:translateX(-50%);background:var(--s2);color:var(--text);font-family:var(--font);font-size:13px;font-weight:600;padding:10px 18px;border-radius:4px;z-index:600;box-shadow:0 4px 20px rgba(0,0,0,.5);animation:slideUp .2s ease;white-space:nowrap;letter-spacing:.2px}
.nw-toast.success{background:rgba(0,192,48,.15);color:var(--green);border:1px solid rgba(0,192,48,.25)}
.nw-toast.info{background:var(--s2);color:var(--text3)}
`;