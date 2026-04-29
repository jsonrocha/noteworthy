import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase.js";
import {
  getFeedReviews,
  getAllReviews,
  getUserReviews,
  insertReview,
  updateReview,
  deleteReview as dbDeleteReview,
  addLike,
  removeLike,
  addComment as dbAddComment,
  deleteComment as dbDeleteComment,
  getFollowing,
  getFollowers,
  follow as dbFollow,
  unfollow as dbUnfollow,
  getUserLists,
  getAllLists,
  insertList,
  updateList,
  deleteList as dbDeleteList,
  getAllUsers,
  searchUsers,
  subscribeToFeed,
  getNotifications,
  updateDisplayName,
  uploadAvatar,
} from "./db.js";

/* ── iTunes Search (no auth, no API key required) ── */
async function musicSearch(q) {
  if (!q?.trim()) return null;
  const base = `https://itunes.apple.com/search?${new URLSearchParams({ term: q.trim(), media: "music", limit: "10" })}`;
  const [tracksRes, albumsRes] = await Promise.all([
    fetch(base + "&entity=song").then(r => r.json()).catch(() => ({ results: [] })),
    fetch(base + "&entity=album").then(r => r.json()).catch(() => ({ results: [] })),
  ]);
  const tracks = (tracksRes.results || [])
    .filter(t => t.wrapperType === "track")
    .map(t => ({
      id: String(t.trackId),
      type: "track",
      title: t.trackName,
      artist: t.artistName,
      cover: t.artworkUrl100?.replace("100x100bb", "600x600bb") ?? null,
      year: t.releaseDate?.slice(0, 4) ?? null,
      previewUrl: t.previewUrl ?? null,
      appleUrl: t.trackViewUrl ?? null,
    }));
  const albums = (albumsRes.results || [])
    .filter(a => a.wrapperType === "collection" && a.collectionType === "Album")
    .map(a => ({
      id: String(a.collectionId),
      type: "album",
      title: a.collectionName,
      artist: a.artistName,
      cover: a.artworkUrl100?.replace("100x100bb", "600x600bb") ?? null,
      year: a.releaseDate?.slice(0, 4) ?? null,
      appleUrl: a.collectionViewUrl ?? null,
    }));
  return { tracks, albums };
}

/* ── Audio preview manager ── */
let _previewEl = null;
let _stopPreview = null;

function PreviewButton({ url, large = false }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => { if (playing) { _previewEl?.pause(); _previewEl = null; _stopPreview = null; } }, [playing]);
  if (!url) return null;
  function toggle(e) {
    e.stopPropagation();
    if (playing) {
      _previewEl?.pause(); _previewEl = null; _stopPreview = null; setPlaying(false);
    } else {
      if (_stopPreview) _stopPreview();
      const el = new Audio(url);
      _previewEl = el;
      const stop = () => { setPlaying(false); _previewEl = null; _stopPreview = null; };
      _stopPreview = () => { el.pause(); stop(); };
      el.addEventListener("ended", stop);
      el.play().catch(stop);
      setPlaying(true);
    }
  }
  const sz = large ? 18 : 11;
  return (
    <div role="button" className={`preview-btn${large ? " preview-btn-lg" : ""}`} onClick={toggle} title={playing ? "Pause preview" : "Play 30s preview"}>
      {playing
        ? <svg viewBox="0 0 24 24" width={sz} height={sz} fill="white"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
        : <svg viewBox="0 0 24 24" width={sz} height={sz} fill="white"><polygon points="6,3 20,12 6,21" /></svg>
      }
    </div>
  );
}

function CoverWithPreview({ item, size }) {
  return (
    <div style={{ position: "relative", flexShrink: 0, display: "inline-flex" }}>
      <CoverArt item={item} size={size} />
      {item?.previewUrl && <PreviewButton url={item.previewUrl} />}
    </div>
  );
}

/* ── localStorage (profile cache + UI prefs — tokens managed by Supabase SDK) ── */
const LS = {
  PROFILE: "nw_profile",
  FAV_ARTISTS: "nw_fav_artists",
  VERSION: "nw_ls_version",
  NOTIF_SEEN: "nw_notif_seen",
};

// Bump this whenever the localStorage schema changes (e.g. auth migration).
// Any browser with a different (or missing) version gets wiped clean on boot.
const LS_VERSION = 2;

function lsMigrate() {
  try {
    const stored = parseInt(localStorage.getItem(LS.VERSION) ?? "0", 10);
    if (stored < LS_VERSION) {
      // Wipe all nw_* keys so stale Spotify-era data can't interfere
      Object.keys(localStorage)
        .filter(k => k.startsWith("nw_"))
        .forEach(k => localStorage.removeItem(k));
      localStorage.setItem(LS.VERSION, String(LS_VERSION));
    }
  } catch { /* ignore — storage may be unavailable */ }
}

lsMigrate(); // runs once at module load, before any state is initialized

function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { }
}
function lsClear(...keys) { keys.forEach(k => localStorage.removeItem(k)); }

/* ═══════════════════════════════════════════════════════════════
   SUPABASE AUTH
═══════════════════════════════════════════════════════════════ */
async function fetchUserProfile(userId) {
  const { data } = await supabase.from("users").select("*").eq("id", userId).single();
  return data ? normalizeUser(data) : null;
}

// Creates the public profile row on first sign-in (user_metadata holds username from signUp)
async function ensureProfileRow(session) {
  const { data: existing } = await supabase
    .from("users").select("id").eq("id", session.user.id).maybeSingle();
  if (existing) return;
  const { username, display_name } = session.user.user_metadata ?? {};
  const { error } = await supabase.from("users").insert({
    id: session.user.id,
    username: username ?? session.user.email,
    display_name: display_name ?? username ?? session.user.email,
    email: session.user.email,
    avatar_url: null,
  });
  if (error) console.error("ensureProfileRow error:", error.message);
}

async function authSignUp(username, email, password) {
  const { data: existing } = await supabase
    .from("users").select("id").eq("username", username).maybeSingle();
  if (existing) throw new Error("Username already taken");

  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { username, display_name: username } },
  });
  if (error) throw error;
  return data.user;
}

async function authSignIn(usernameOrEmail, password) {
  let email = usernameOrEmail.trim();
  if (!email.includes("@")) {
    const { data: row } = await supabase
      .from("users").select("email").eq("username", email).maybeSingle();
    if (!row || !row.email) throw new Error("No account found for that username. Try signing in with your email address instead.");
    email = row.email;
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

/* ── Data normalization — convert Supabase rows to app shape ── */
function normalizeReview(row) {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    stars: row.stars,
    text: row.body ?? "",
    item: {
      id: row.item_id,
      type: row.item_type,
      title: row.item_title,
      artist: row.item_artist,
      cover: row.item_cover ?? null,
      year: row.item_year ?? null,
      previewUrl: row.item_preview_url ?? null,
      appleUrl: row.item_apple_url ?? null,
    },
    likes: (row.likes ?? []).map(l => l.user_id),
    comments: (row.comments ?? []).map(c => ({
      id: c.id,
      userId: c.user_id,
      text: c.body,
      createdAt: c.created_at,
    })),
  };
}

function normalizeList(row) {
  const items = (row.list_items ?? [])
    .sort((a, b) => a.rank - b.rank)
    .map(i => ({
      id: i.item_id ?? i.id,
      rank: i.rank,
      title: i.item_title,
      artist: i.item_artist,
      type: i.item_type,
      cover: i.item_cover ?? null,
    }));
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description ?? "",
    createdAt: row.created_at,
    items,
  };
}

function normalizeUser(row) {
  return {
    id: row.id,
    username: row.username ?? "",
    display_name: row.display_name ?? row.username ?? "",
    email: row.email ?? "",
    images: row.avatar_url ? [{ url: row.avatar_url }] : [],
    bio: row.bio ?? "",
  };
}

/* ── Helpers ── */
function formatDate(s) {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function genId(prefix) { return prefix + Date.now() + Math.random().toString(36).slice(2, 7); }

/* ── UI Components ── */
function Avatar({ user, size = 36 }) {
  const img = user?.avatar_url || user?.images?.[0]?.url;
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

/* Half-star SVG helpers */
function StarFull({ size, lit }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill={lit ? "#F5C518" : "none"} stroke={lit ? "#F5C518" : "#3A3A3C"} strokeWidth="1.5"
      style={{ display: "block", filter: lit ? "drop-shadow(0 0 3px rgba(245,197,24,0.4))" : "none", transition: "all .1s" }}>
      <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
    </svg>
  );
}

function StarHalf({ size }) {
  const id = "hg" + size;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      style={{ display: "block", filter: "drop-shadow(0 0 3px rgba(245,197,24,0.35))", transition: "all .1s" }}>
      <defs>
        <linearGradient id={id}>
          <stop offset="50%" stopColor="#F5C518" />
          <stop offset="50%" stopColor="transparent" />
        </linearGradient>
      </defs>
      <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"
        fill={`url(#${id})`} stroke="#F5C518" strokeWidth="1.5" />
    </svg>
  );
}

function Stars({ value, onChange, size = 18 }) {
  // value is in increments of 0.5 (0, 0.5, 1, 1.5 … 5)
  const [hov, setHov] = useState(0);
  const show = hov || value;

  function getStarType(starNum, val) {
    // starNum is 1-5 (full star position)
    if (val >= starNum) return "full";
    if (val >= starNum - 0.5) return "half";
    return "empty";
  }

  function handleMouseMove(e, starNum) {
    if (!onChange) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setHov(x < rect.width / 2 ? starNum - 0.5 : starNum);
  }

  function handleClick(e, starNum) {
    if (!onChange) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clicked = x < rect.width / 2 ? starNum - 0.5 : starNum;
    // Toggle off if clicking the same value
    onChange(clicked === value ? 0 : clicked);
  }

  return (
    <div style={{ display: "flex", gap: 2 }}>
      {[1, 2, 3, 4, 5].map(s => {
        const type = getStarType(s, show);
        return (
          <div key={s} style={{ cursor: onChange ? "pointer" : "default", userSelect: "none" }}
            onMouseMove={e => handleMouseMove(e, s)}
            onMouseLeave={() => onChange && setHov(0)}
            onClick={e => handleClick(e, s)}>
            {type === "full" && <StarFull size={size} lit={true} />}
            {type === "half" && <StarHalf size={size} />}
            {type === "empty" && <StarFull size={size} lit={false} />}
          </div>
        );
      })}
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

function InlineSearch({ onSelect, placeholder = "Search songs or albums…" }) {
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
    clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      setLoading(true);
      try {
        const { tracks, albums } = await musicSearch(q) ?? { tracks: [], albums: [] };
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
        <input className="isb-input" placeholder={placeholder}
          value={q} onChange={e => setQ(e.target.value)} onFocus={() => res && setOpen(true)} />
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
                <CoverWithPreview item={item} size={36} />
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

/* ── Write Review Screen (full-screen, inline transition) ── */
function WriteReviewScreen({ initItem = null, initStars = 0, initText = "", isEdit = false, onSubmit, onClose }) {
  const [item, setItem] = useState(initItem);
  const [stars, setStars] = useState(initStars);
  const [text, setText] = useState(initText);
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState(null);
  const [searching, setSearching] = useState(false);
  const [activeTab, setActiveTab] = useState("tracks");
  const deb = useRef(null);
  const LABELS = { 0.5: "Awful", 1: "Poor", 1.5: "Meh", 2: "Fair", 2.5: "Okay", 3: "Good", 3.5: "Pretty Good", 4: "Great", 4.5: "Excellent", 5: "Essential" };

  useEffect(() => {
    if (!searchQ.trim()) { setSearchRes(null); return; }
    clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { tracks, albums } = await musicSearch(searchQ) ?? { tracks: [], albums: [] };
        setSearchRes({ tracks, albums });
      } catch (e) { console.error(e); }
      setSearching(false);
    }, 340);
  }, [searchQ]);

  const searchList = activeTab === "tracks" ? (searchRes?.tracks || []) : (searchRes?.albums || []);

  return (
    <div className="subpage-ov" style={{ display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <header className="nw-header" style={{ flexShrink: 0 }}>
        {item && !isEdit ? (
          <button className="back-btn" onClick={() => setItem(null)}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#007AFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
          </button>
        ) : (
          <button className="back-btn" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#007AFF" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        )}
        <span className="nw-logo" style={{ fontSize: 17 }}>{isEdit ? "Edit Review" : item ? "Write a Review" : "Find Music"}</span>
        <div style={{ width: 32 }} />
      </header>

      <div className="scroll-area" style={{ flex: 1, overflowY: "auto" }}>
        {/* ── Step 1: No item selected — show search ── */}
        {!item && !isEdit && (
          <>
            {/* Search bar */}
            <div style={{ marginBottom: 16 }}>
              <div className="isb-field" style={{ height: 48 }}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></svg>
                <input
                  className="isb-input"
                  style={{ fontSize: 16 }}
                  placeholder="Search music…"
                  value={searchQ}
                  onChange={e => setSearchQ(e.target.value)}
                  autoFocus
                />
                {searching && <div className="isb-spin" />}
                {searchQ && !searching && <button className="isb-x" style={{ fontSize: 14, padding: 4 }} onClick={() => { setSearchQ(""); setSearchRes(null); }}>✕</button>}
              </div>
            </div>

            {/* Tabs */}
            {searchRes && (
              <div className="isb-tabs" style={{ marginBottom: 12, borderRadius: 6, border: "1px solid var(--border)" }}>
                {[["tracks", `Tracks (${searchRes.tracks?.length || 0})`], ["albums", `Albums (${searchRes.albums?.length || 0})`]].map(([k, l]) => (
                  <button key={k} className={`isb-tab ${activeTab === k ? "active" : ""}`} style={{ padding: "10px 0" }} onClick={() => setActiveTab(k)}>{l}</button>
                ))}
              </div>
            )}

            {/* Results */}
            {searchList.map(r => (
              <button key={r.id} className="isb-row" style={{ borderRadius: 8, marginBottom: 6, border: "1px solid var(--border)", padding: "12px 14px" }} onClick={() => setItem(r)}>
                <CoverWithPreview item={r} size={48} />
                <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  <div className="isb-name" style={{ fontSize: 15, maxWidth: "100%" }}>{r.title}</div>
                  <div className="isb-meta" style={{ fontSize: 13, marginTop: 2 }}>{r.artist}{r.year ? ` · ${r.year}` : ""}</div>
                </div>
                <span className="isb-badge">{r.type}</span>
              </button>
            ))}

            {!searchQ && (
              <p style={{ fontSize: 14, color: "var(--text4)", textAlign: "center", marginTop: 40 }}>Search for a song or album to review</p>
            )}
            {searchQ && !searching && searchRes && searchList.length === 0 && (
              <p style={{ fontSize: 14, color: "var(--text4)", textAlign: "center", marginTop: 40 }}>No results for "{searchQ}"</p>
            )}

            {/* Manual entry */}
            <div style={{ marginTop: 32, background: "var(--s2)", borderRadius: 10, padding: 16 }}>
              <p style={{ fontSize: 13, color: "var(--text3)", marginBottom: 10 }}>Or enter manually:</p>
              <div style={{ display: "flex", gap: 8 }}>
                <input className="modal-input" style={{ flex: 1 }} placeholder="Title…" id="wrs-t" />
                <input className="modal-input" style={{ width: 130 }} placeholder="Artist…" id="wrs-a" />
                <button className="modal-go" onClick={() => {
                  const t = document.getElementById("wrs-t").value.trim();
                  const a = document.getElementById("wrs-a").value.trim();
                  if (t) setItem({ id: "m" + Date.now(), type: "track", title: t, artist: a || "Unknown", cover: null, year: "" });
                }}>→</button>
              </div>
            </div>
          </>
        )}

        {/* ── Step 2: Item selected — write review ── */}
        {item && (
          <>
            {/* Item hero */}
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start", background: "var(--s1)", borderRadius: 12, padding: 16, marginBottom: 20, position: "relative", overflow: "hidden" }}>
              {item.cover && <div style={{ position: "absolute", inset: -16, backgroundImage: `url(${item.cover})`, backgroundSize: "cover", backgroundPosition: "center", filter: "blur(24px) brightness(.25)", transform: "scale(1.1)", zIndex: 0 }} />}
              <div style={{ position: "relative", zIndex: 1, flexShrink: 0 }}><CoverArt item={item} size={100} /></div>
              <div style={{ position: "relative", zIndex: 1, flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "var(--serif)", fontSize: 20, fontStyle: "italic", color: "var(--text)", lineHeight: 1.2, marginBottom: 4 }}>{item.title}</div>
                <div style={{ fontSize: 14, color: "var(--text2)", marginBottom: 2 }}>{item.artist}</div>
                <div style={{ fontSize: 12, color: "var(--text3)" }}>{item.type === "album" ? "Album" : "Track"}{item.year ? ` · ${item.year}` : ""}</div>
              </div>
            </div>

            {/* Rating */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20, padding: "14px 16px", background: "var(--s1)", borderRadius: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text3)", letterSpacing: ".4px", textTransform: "uppercase" }}>Rating</span>
              <Stars value={stars} onChange={setStars} size={32} />
              {stars > 0 && <span style={{ fontSize: 14, color: "var(--gold)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".3px" }}>{LABELS[stars] || ""}</span>}
            </div>

            {/* Rich editor */}
            <div style={{ marginBottom: 24 }}>
              <RichEditor value={text} onChange={setText} placeholder="What did you think? Be honest, be specific…" />
            </div>

            {/* Submit */}
            <button
              className="modal-submit"
              style={{ fontSize: 16, padding: 16, borderRadius: 10, marginBottom: 32 }}
              disabled={stars === 0}
              onClick={() => onSubmit(item, stars, text)}
            >
              {isEdit ? "Save Changes" : "Post Review"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Create / Edit List Screen ── */
function ListScreen({ initList = null, isEdit = false, onSubmit, onClose }) {
  const [title, setTitle] = useState(initList?.title || "");
  const [desc, setDesc] = useState(initList?.description || "");
  const [items, setItems] = useState(initList?.items || []);
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState(null);
  const [searching, setSearching] = useState(false);
  const [activeTab, setActiveTab] = useState("tracks");
  const deb = useRef(null);

  useEffect(() => {
    if (!searchQ.trim()) { setSearchRes(null); return; }
    clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { tracks, albums } = await musicSearch(searchQ) ?? { tracks: [], albums: [] };
        setSearchRes({ tracks, albums });
      } catch (e) { console.error(e); }
      setSearching(false);
    }, 340);
  }, [searchQ]);

  const searchList = activeTab === "tracks" ? (searchRes?.tracks || []) : (searchRes?.albums || []);

  function addItem(r) {
    if (!items.find(i => i.id === r.id)) {
      setItems(p => [...p, { ...r, rank: p.length + 1 }]);
      setSearchQ(""); setSearchRes(null);
    }
  }
  function removeItem(id) { setItems(p => p.filter(i => i.id !== id).map((i, n) => ({ ...i, rank: n + 1 }))); }
  function moveItem(id, dir) {
    setItems(p => {
      const idx = p.findIndex(i => i.id === id); const n = [...p]; const sw = idx + dir;
      if (sw < 0 || sw >= n.length) return p;
      [n[idx], n[sw]] = [n[sw], n[idx]];
      return n.map((i, x) => ({ ...i, rank: x + 1 }));
    });
  }

  return (
    <div className="subpage-ov" style={{ display: "flex", flexDirection: "column" }}>
      <header className="nw-header" style={{ flexShrink: 0 }}>
        <button className="back-btn" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#007AFF" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
        <span className="nw-logo" style={{ fontSize: 17 }}>{isEdit ? "Edit List" : "New List"}</span>
        <button
          style={{ background: "none", border: "none", color: title.trim() && items.length > 0 ? "var(--green)" : "var(--text4)", fontFamily: "var(--font)", fontSize: 15, fontWeight: 700, cursor: title.trim() && items.length > 0 ? "pointer" : "default", padding: "4px 0" }}
          disabled={!title.trim() || items.length === 0}
          onClick={() => onSubmit(title, desc, items)}
        >
          {isEdit ? "Save" : "Create"}
        </button>
      </header>

      <div className="scroll-area" style={{ flex: 1, overflowY: "auto" }}>
        {/* Title + description */}
        <input
          className="modal-input"
          style={{ width: "100%", fontSize: 18, fontWeight: 700, marginBottom: 10, padding: "12px 14px", borderRadius: 10 }}
          placeholder="List title…"
          value={title}
          onChange={e => setTitle(e.target.value)}
          autoFocus
        />
        <input
          className="modal-input"
          style={{ width: "100%", marginBottom: 20, padding: "10px 14px", borderRadius: 10 }}
          placeholder="Description (optional)…"
          value={desc}
          onChange={e => setDesc(e.target.value)}
        />

        {/* Current list items */}
        {items.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div className="sect-label" style={{ marginBottom: 10 }}>Your list · {items.length} items</div>
            {items.map((item, idx) => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--s1)", borderRadius: 8, marginBottom: 6, border: "1px solid var(--border)" }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: "var(--green)", width: 22, flexShrink: 0, fontFamily: "var(--serif)" }}>{idx + 1}</span>
                <CoverArt item={item} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</div>
                  <div style={{ fontSize: 12, color: "var(--text3)" }}>{item.artist}</div>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="lm-btn" onClick={() => moveItem(item.id, -1)} disabled={idx === 0}>↑</button>
                  <button className="lm-btn" onClick={() => moveItem(item.id, 1)} disabled={idx === items.length - 1}>↓</button>
                  <button className="lm-btn danger" onClick={() => removeItem(item.id)}>✕</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Search to add */}
        <div className="sect-label" style={{ marginBottom: 8 }}>Add music</div>
        <div className="isb-field" style={{ height: 48, marginBottom: 12 }}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></svg>
          <input
            className="isb-input"
            style={{ fontSize: 15 }}
            placeholder="Search music…"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
          />
          {searching && <div className="isb-spin" />}
          {searchQ && !searching && <button className="isb-x" onClick={() => { setSearchQ(""); setSearchRes(null); }}>✕</button>}
        </div>

        {searchRes && (
          <div className="isb-tabs" style={{ marginBottom: 10, borderRadius: 6, border: "1px solid var(--border)" }}>
            {[["tracks", `Tracks (${searchRes.tracks?.length || 0})`], ["albums", `Albums (${searchRes.albums?.length || 0})`]].map(([k, l]) => (
              <button key={k} className={`isb-tab ${activeTab === k ? "active" : ""}`} style={{ padding: "10px 0" }} onClick={() => setActiveTab(k)}>{l}</button>
            ))}
          </div>
        )}

        {searchList.map(r => (
          <button key={r.id} className="isb-row" style={{ borderRadius: 8, marginBottom: 6, border: "1px solid var(--border)", padding: "12px 14px", opacity: items.find(i => i.id === r.id) ? 0.4 : 1 }} onClick={() => addItem(r)}>
            <CoverWithPreview item={r} size={42} />
            <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
              <div className="isb-name" style={{ fontSize: 14, maxWidth: "100%" }}>{r.title}</div>
              <div className="isb-meta" style={{ fontSize: 12, marginTop: 2 }}>{r.artist}{r.year ? ` · ${r.year}` : ""}</div>
            </div>
            {items.find(i => i.id === r.id)
              ? <span style={{ fontSize: 11, color: "var(--green)", fontWeight: 700 }}>Added</span>
              : <span style={{ fontSize: 11, color: "var(--green)", fontWeight: 700, border: "1px solid var(--green)", borderRadius: 4, padding: "3px 8px" }}>+ Add</span>
            }
          </button>
        ))}

        {!searchQ && items.length === 0 && (
          <p style={{ fontSize: 14, color: "var(--text4)", textAlign: "center", marginTop: 24 }}>Search above to add songs or albums</p>
        )}

        <div style={{ height: 40 }} />
      </div>
    </div>
  );
}


function PhotoLightbox({ src, name, onClose }) {
  useEffect(() => {
    const fn = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [onClose]);
  return (
    <div className="lightbox-bg" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
      <img src={src} alt={name || ""} className="lightbox-img" onClick={e => e.stopPropagation()} />
    </div>
  );
}

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

function ReviewCard({ review, currentUser, allUsers, toggleLike, navigate, onEdit, onDelete, setArtistPage }) {
  // Fall back to a minimal author object so the card always renders
  const author = allUsers[review.userId] || { id: review.userId, display_name: review.userId?.slice(0, 8) || "User", images: [] };
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
      <div className="rc-art" onClick={() => navigate("reviewDetail", { reviewId: review.id, reviewSnapshot: review })}>
        {review.item.cover ? <img src={review.item.cover} alt="" className="rc-art-img" /> : <div className="rc-art-bg" style={{ "--h": ((review.item.title || "").charCodeAt(0) * 23) % 360 }} />}
        <div className="rc-art-fade" />
        <div className="rc-art-stars"><Stars value={review.stars} size={13} /></div>
        <span className="rc-art-badge">{review.item.type}</span>
      </div>
      <div className="rc-body">
        <div className="rc-track-row" onClick={() => navigate("reviewDetail", { reviewId: review.id, reviewSnapshot: review })}>
          <div className="rc-track-name">{review.item.title}</div>
          <div className="rc-track-sub">
            {setArtistPage && review.item.artist
              ? <button className="rc-artist-link" onClick={e => { e.stopPropagation(); setArtistPage({ name: review.item.artist, id: review.item.artist }); }}>{review.item.artist}</button>
              : review.item.artist}
            {review.item.year ? ` · ${review.item.year}` : ""}
          </div>
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
        {review.text && <div className="rc-snippet" onClick={() => navigate("reviewDetail", { reviewId: review.id, reviewSnapshot: review })} dangerouslySetInnerHTML={{ __html: review.text }} />}
        <div className="rc-actions">
          <button className={`rc-act ${liked ? "liked" : ""}`} onClick={() => toggleLike(review.id, review)}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill={liked ? "#E9463F" : "none"} stroke={liked ? "#E9463F" : "#555"} strokeWidth="2" strokeLinecap="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
            {review.likes?.length > 0 && <span>{review.likes.length}</span>}
          </button>
          <button className="rc-act" onClick={() => navigate("reviewDetail", { reviewId: review.id, reviewSnapshot: review })}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#555" strokeWidth="2" strokeLinecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
            {review.comments?.length > 0 && <span>{review.comments.length}</span>}
          </button>
        </div>
      </div>
    </article>
  );
}


/* ═══════════════════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════
   AUTH PAGE  (sign-in / sign-up)
═══════════════════════════════════════════════════════════════ */
function AuthPage() {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    // Validate before hitting network
    if (mode === "signup") {
      if (!username.trim()) { setError("Username is required"); return; }
      if (username.includes("@")) { setError("Username cannot contain @"); return; }
    }
    setLoading(true);
    try {
      if (mode === "signup") {
        const user = await authSignUp(username.trim(), email.trim(), password);
        // If Supabase email confirmation is ON, there's no session yet — show prompt
        if (!user?.confirmed_at && !user?.email_confirmed_at) {
          // onAuthStateChange will handle everything once they click the link
          // For now just keep loading=false and let the user know
          setCheckEmail(true);
          return;
        }
        // Email confirmation OFF: onAuthStateChange SIGNED_IN handles the rest
      } else {
        await authSignIn(username.trim(), password);
        // onAuthStateChange SIGNED_IN handles profile hydration + unmounting this page
      }
    } catch (err) {
      setError(err.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (checkEmail) return (
    <>
      <style>{CSS}</style>
      <div className="landing">
        <div className="landing-inner">
          <div className="landing-logo"><span className="landing-note">♪</span><span className="landing-wordmark">noteworthy</span></div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>✉️</div>
            <p style={{ fontSize: 16, color: "var(--text)", fontWeight: 600, marginBottom: 8 }}>Check your email</p>
            <p style={{ fontSize: 14, color: "var(--text2)", lineHeight: 1.6 }}>We sent a confirmation link to <strong>{email}</strong>. Click it to finish creating your account.</p>
          </div>
          <button className="auth-toggle-btn" onClick={() => { setCheckEmail(false); setMode("signin"); }}>Back to sign in</button>
        </div>
      </div>
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      <div className="landing">
        <div className="landing-inner" style={{ gap: 16 }}>
          <div className="landing-logo"><span className="landing-note">♪</span><span className="landing-wordmark">noteworthy</span></div>
          <p className="landing-tagline">Track the music you've heard.<br />Tell your friends what's worth it.</p>

          <form className="auth-form" onSubmit={handleSubmit}>
            {mode === "signup" && (
              <input className="auth-input" type="text" placeholder="Username" autoCapitalize="none"
                value={username} onChange={e => setUsername(e.target.value)} required />
            )}
            <input className="auth-input" type={mode === "signin" ? "text" : "email"}
              placeholder={mode === "signin" ? "Username or email" : "Email"}
              autoCapitalize="none" value={mode === "signin" ? (username || email) : email}
              onChange={e => mode === "signin" ? setUsername(e.target.value) : setEmail(e.target.value)}
              required />
            <input className="auth-input" type="password" placeholder="Password"
              value={password} onChange={e => setPassword(e.target.value)} required />
            {error && <p className="auth-error">{error}</p>}
            <button className="auth-submit" type="submit" disabled={loading}>
              {loading ? <span className="auth-spin" /> : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>

          <p className="auth-toggle">
            {mode === "signup" ? "Already have an account?" : "New to Noteworthy?"}
            {" "}<button className="auth-toggle-btn" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); }}>
              {mode === "signup" ? "Sign in" : "Create account"}
            </button>
          </p>
        </div>
      </div>
    </>
  );
}

// Module-level guard — prevents duplicate onAuthStateChange subscriptions
// from Vite HMR re-executing the module during development.
let _authSubscription = null;

export default function Noteworthy() {
  const [profile, setProfile] = useState(() => lsGet(LS.PROFILE));
  const [reviews, setReviews] = useState([]);
  const [lists, setLists] = useState([]);
  const [allUsers, setAllUsers] = useState({});
  const [following, setFollowing] = useState([]);   // array of user IDs I follow
  const [tab, setTab] = useState("feed");
  const [subPage, setSubPage] = useState(null);
  const [modal, setModal] = useState(null);
  const [alert, setAlert] = useState(null);
  const [toast, setToast] = useState(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [favoriteArtists, setFavoriteArtists] = useState(() => lsGet(LS.FAV_ARTISTS, []));
  const [artistPage, setArtistPage] = useState(null); // { artist } object
  const [notifications, setNotifications] = useState([]);
  const [notifSeen, setNotifSeen] = useState(() => lsGet(LS.NOTIF_SEEN, 0));

  const unreadCount = notifications.filter(n => n.createdAt && new Date(n.createdAt) > new Date(notifSeen)).length;

  function markNotifSeen() {
    const now = Date.now();
    setNotifSeen(now);
    lsSet(LS.NOTIF_SEEN, now);
  }

  function updateProfileField(updates) {
    const updated = { ...profile, ...updates };
    setProfile(updated);
    lsSet(LS.PROFILE, updated);
    setAllUsers(prev => ({ ...prev, [myId]: { ...(prev[myId] ?? {}), ...updates } }));
  }

  const myId = profile?.id;

  /* ── Boot sequence ── */
  useEffect(() => {
    let mounted = true;

    // Tear down any subscription left over from a previous HMR cycle
    if (_authSubscription) { _authSubscription.unsubscribe(); _authSubscription = null; }

    // Subscribe to future auth events (sign-in, sign-out, token refresh).
    // We do NOT handle INITIAL_SESSION here — boot() below calls getSession() directly,
    // which is simpler, race-condition-free, and works identically in dev and prod.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (event === "SIGNED_IN" && session) {
        // User just signed in from the auth page — show minimal profile immediately
        const meta = session.user.user_metadata ?? {};
        const minimal = {
          id: session.user.id,
          username: meta.username ?? session.user.email,
          display_name: meta.display_name ?? meta.username ?? session.user.email,
          email: session.user.email,
          avatar_url: null,
        };
        setProfile(minimal);
        lsSet(LS.PROFILE, minimal);
        // Hydrate full profile in the background
        ensureProfileRow(session)
          .then(() => fetchUserProfile(session.user.id))
          .then(prof => { if (mounted && prof) { setProfile(prof); lsSet(LS.PROFILE, prof); } })
          .catch(e => console.error("sign-in hydration", e));
      } else if (event === "SIGNED_OUT") {
        lsClear(LS.PROFILE);
        setProfile(null); setReviews([]); setLists([]); setFollowing([]);
        setTab("feed"); setSubPage(null); setModal(null);
      }
      // TOKEN_REFRESHED: session silently renewed — nothing to do
    });
    _authSubscription = subscription;

    // Resolve the current session on startup with a 12-second timeout.
    // getSession() waits for Supabase's internal init (which includes token refresh
    // if the stored token is expired). Without a custom fetch timeout interfering,
    // this completes in < 2 seconds on any reasonable connection.
    async function boot() {
      try {
        const outcome = await Promise.race([
          supabase.auth.getSession().then(r => ({ session: r.data.session })),
          new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 12000)),
        ]);

        if (!mounted) return;

        if (outcome.timedOut) {
          console.warn("Supabase session check timed out — clearing stored session");
          Object.keys(localStorage)
            .filter(k => k.startsWith("sb-") && k.endsWith("-auth-token"))
            .forEach(k => localStorage.removeItem(k));
          lsClear(LS.PROFILE);
          setProfile(null);
          return;
        }

        const { session } = outcome;
        if (session) {
          try {
            await ensureProfileRow(session);
            const prof = await fetchUserProfile(session.user.id);
            if (!mounted) return;
            if (prof) { setProfile(prof); lsSet(LS.PROFILE, prof); }
            else { lsClear(LS.PROFILE); setProfile(null); }
          } catch (e) {
            // Network error — keep the cached profile so the user isn't logged out
            // spuriously. If the session is truly invalid, SIGNED_OUT will fire.
            console.error("profile hydration error", e);
          }
        } else {
          lsClear(LS.PROFILE);
          setProfile(null);
        }
      } catch (e) {
        console.error("boot error", e);
      }
    }

    boot();

    return () => { mounted = false; subscription.unsubscribe(); _authSubscription = null; };
  }, []);

  /* ── Load data from Supabase once profile is known ── */
  useEffect(() => {
    if (!myId) return;
    loadAll();
  }, [myId]);

  /* ── Persist favorite artists to localStorage ── */
  useEffect(() => { lsSet(LS.FAV_ARTISTS, favoriteArtists); }, [favoriteArtists]);

  /* ── Real-time feed subscription ── */
  useEffect(() => {
    if (!myId) return;
    const unsub = subscribeToFeed(myId, following, (event, row) => {
      if (event === 'INSERT') {
        // New review from someone we follow (or ourselves from another device)
        const normalized = normalizeReview(row);
        setReviews(p => p.find(r => r.id === normalized.id) ? p : [normalized, ...p]);
      } else if (event === 'UPDATE') {
        setReviews(p => p.map(r => r.id === row.id ? { ...r, stars: row.stars, text: row.body ?? "" } : r));
      } else if (event === 'DELETE') {
        setReviews(p => p.filter(r => r.id !== row.id));
      }
    });
    return () => unsub?.();
  }, [myId, following.join(',')]);

  async function loadAll() {
    setDbLoading(true);
    try {
      // Step 1: fetch following list + users first so allUsers is populated before reviews render
      const [followingIds, usersRows, listRows] = await Promise.all([
        getFollowing(myId),
        getAllUsers(),
        getUserLists(myId),
      ]);

      // Build users map — always include own profile so ReviewCard never gets null author
      const usersMap = {};
      usersRows.forEach(u => { usersMap[u.id] = normalizeUser(u); });
      if (profile) usersMap[myId] = profile; // Spotify profile has avatar etc.

      // Step 2: fetch reviews now that we know following list
      const feedRows = await getFeedReviews(myId, followingIds);
      const normalized = feedRows.map(normalizeReview);
      // Step 3: set everything in one go so React renders with complete data
      setAllUsers(usersMap);
      setFollowing(followingIds);
      setReviews(normalized);
      setLists(listRows.map(normalizeList));
    } catch (e) {
      console.error("loadAll error", e);
    }
    setDbLoading(false);
  }

  function notify(msg, type = "success") {
    setToast({ msg, type }); setTimeout(() => setToast(null), 2600);
  }

  function signOut() {
    // Clear state immediately so the UI responds right away
    lsClear(LS.PROFILE);
    setProfile(null); setReviews([]); setLists([]); setFollowing([]);
    setTab("feed"); setSubPage(null); setModal(null);
    supabase.auth.signOut(); // fire and forget — event will be a no-op since state is already cleared
  }

  const navigate = (page, data = {}) => setSubPage({ page, ...data });
  const goBack = () => setSubPage(null);

  /* ── Reviews ── */
  async function addReview(item, stars, text) {
    const id = genId("rv");
    const optimistic = {
      id, userId: myId, createdAt: new Date().toISOString(), stars, text,
      item, likes: [], comments: [],
    };
    setReviews(p => [optimistic, ...p]);
    setModal(null);
    notify("Review posted");
    await insertReview({ id, userId: myId, item, stars, text });
  }

  async function editReview(id, stars, text) {
    setReviews(p => p.map(r => r.id === id ? { ...r, stars, text } : r));
    setModal(null);
    notify("Review updated");
    await updateReview(id, stars, text);
  }

  async function deleteReview(id) {
    setReviews(p => p.filter(r => r.id !== id));
    if (subPage?.page === "reviewDetail") goBack();
    notify("Review deleted");
    await dbDeleteReview(id);
  }

  async function toggleLike(reviewId, reviewSnapshot) {
    if (!myId) return;
    const review = reviews.find(r => r.id === reviewId) ?? reviewSnapshot;
    if (!review) return;
    const liked = review.likes?.includes(myId);
    // Optimistic update — only mutates main reviews state if the review lives there
    setReviews(p => p.map(r => {
      if (r.id !== reviewId) return r;
      const likes = liked ? r.likes.filter(x => x !== myId) : [...(r.likes || []), myId];
      return { ...r, likes };
    }));
    if (liked) await removeLike(myId, reviewId);
    else await addLike(myId, reviewId);
  }

  async function addComment(reviewId, text) {
    const id = genId("cm");
    const optimistic = { id, userId: myId, text, createdAt: new Date().toISOString() };
    setReviews(p => p.map(r => r.id !== reviewId ? r : { ...r, comments: [...(r.comments || []), optimistic] }));
    await dbAddComment({ id, reviewId, userId: myId, text });
  }

  async function deleteComment(reviewId, commentId) {
    setReviews(p => p.map(r => r.id !== reviewId ? r : { ...r, comments: r.comments.filter(c => c.id !== commentId) }));
    await dbDeleteComment(commentId);
  }

  /* ── Favorite Artists ── */
  function toggleFavoriteArtist(artist) {
    setFavoriteArtists(prev => {
      const exists = prev.find(a => a.id === artist.id);
      return exists ? prev.filter(a => a.id !== artist.id) : [...prev, artist];
    });
  }

  /* ── Follows ── */
  async function toggleFollow(targetId, targetProfile) {
    if (!myId) return;
    const isFollowing = following.includes(targetId);
    // Optimistic update
    setFollowing(p => isFollowing ? p.filter(x => x !== targetId) : [...p, targetId]);
    // Cache the user profile so they appear in allUsers
    if (targetProfile) setAllUsers(p => ({ ...p, [targetId]: targetProfile }));
    notify(isFollowing ? "Unfollowed" : "Now following!", "success");
    if (isFollowing) await dbUnfollow(myId, targetId);
    else await dbFollow(myId, targetId);
    // Reload feed to reflect new following
    const rows = await getFeedReviews(myId, isFollowing ? following.filter(x => x !== targetId) : [...following, targetId]);
    setReviews(rows.map(normalizeReview));
  }

  /* ── Lists ── */
  async function addList(title, desc, items) {
    const id = genId("l");
    const optimistic = { id, userId: myId, title, description: desc, items, createdAt: new Date().toISOString() };
    setLists(p => [optimistic, ...p]);
    setModal(null);
    notify("List created");
    await insertList({ id, userId: myId, title, description: desc, items });
  }

  async function editList(id, title, desc, items) {
    setLists(p => p.map(l => l.id === id ? { ...l, title, description: desc, items } : l));
    setModal(null);
    notify("List updated");
    await updateList({ id, title, description: desc, items });
  }

  async function deleteList(id) {
    setLists(p => p.filter(l => l.id !== id));
    if (subPage?.page === "listDetail") goBack();
    notify("List deleted");
    await dbDeleteList(id);
  }

  /* ── Shared props ── */
  function goHome() { setTab("feed"); setSubPage(null); setArtistPage(null); }

  const shared = {
    reviews, lists, allUsers, currentUser: profile, myId,
    myFollowing: following, follows: { [myId]: following },
    navigate, toggleLike, addComment, deleteComment,
    setModal, setAlert, deleteReview, deleteList, toggleFollow,
    favoriteArtists, toggleFavoriteArtist,
    onUpdateProfile: updateProfileField,
    setArtistPage, setTab, goHome,
  };


  if (!profile) return (
    <>
      <style>{CSS}</style>
      <AuthPage />
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      <div className="nw-app">
        {artistPage && (
          <ArtistPage
            artist={artistPage}
            reviews={reviews}
            allUsers={allUsers}
            currentUser={profile}
            myId={myId}
            favoriteArtists={favoriteArtists}
            toggleFavoriteArtist={toggleFavoriteArtist}
            navigate={navigate}
            toggleLike={toggleLike}
            setModal={setModal}
            deleteReview={deleteReview}
            goBack={() => setArtistPage(null)}
          />
        )}
        {subPage && (
          <div className="subpage-ov">
            {subPage.page === "reviewDetail" && <ReviewDetailPage review={reviews.find(r => r.id === subPage.reviewId) ?? subPage.reviewSnapshot} {...shared} goBack={goBack} />}
            {subPage.page === "profile" && <ProfilePage userId={subPage.userId} {...shared} goBack={goBack} loadUserData={async (uid) => {
              const [uReviews, uLists, uFollowing, uFollowers] = await Promise.all([
                getUserReviews(uid),
                getUserLists(uid),
                getFollowing(uid),
                getFollowers(uid),
              ]);
              return {
                reviews: uReviews.map(normalizeReview),
                lists: uLists.map(normalizeList),
                followingCount: uFollowing.length,
                followersCount: uFollowers.length,
              };
            }} />}
            {subPage.page === "listDetail" && <ListDetailPage list={lists.find(l => l.id === subPage.listId)} {...shared} goBack={goBack} />}
          </div>
        )}
        <TopBar currentUser={profile} goHome={goHome} setModal={setModal} setTab={setTab} signOut={signOut} />
        <div className="nw-main">
          {tab === "feed" && <FeedTab     {...shared} dbLoading={dbLoading} />}
          {tab === "discover" && <DiscoverTab {...shared} loadAllReviews={async () => { const rows = await getAllReviews(); return rows.map(normalizeReview); }} loadAllLists={async () => { const rows = await getAllLists(); return rows.map(normalizeList); }} />}
          {tab === "notifications" && <NotificationsTab myId={myId} allUsers={allUsers} navigate={navigate} notifSeen={notifSeen} onLoad={setNotifications} />}
          {tab === "lists" && <ListsTab    {...shared} />}
          {tab === "profile" && <MyProfileTab {...shared} />}
        </div>
        <nav className="tab-bar">
          {[
            { id: "feed", label: "Feed", svg: <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H5a1 1 0 01-1-1V9.5z M9 21V12h6v9" strokeWidth="1.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /> },
            { id: "discover", label: "Discover", svg: <><circle cx="11" cy="11" r="7" strokeWidth="1.5" fill="none" stroke="currentColor" /><path d="M16.5 16.5L21 21" strokeWidth="1.5" strokeLinecap="round" stroke="currentColor" /></> },
            { id: "notifications", label: "Activity", svg: <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" strokeWidth="1.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />, badge: unreadCount },
            { id: "lists", label: "Lists", svg: <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 12h6M9 16h4" strokeWidth="1.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /> },
            { id: "profile", label: "Profile", svg: <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" strokeWidth="1.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /> },
          ].map(t => (
            <button key={t.id} className={`tab-item ${tab === t.id ? "active" : ""}`} onClick={() => { setTab(t.id); setSubPage(null); if (t.id === "notifications") markNotifSeen(); }}>
              <div style={{ position: "relative", display: "inline-flex" }}>
                <svg viewBox="0 0 24 24" width="23" height="23">{t.svg}</svg>
                {t.badge > 0 && <span className="tab-badge">{t.badge > 9 ? "9+" : t.badge}</span>}
              </div>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {!subPage && (
        <button className="nw-fab" onClick={() => setModal({ type: "newReview" })} title="Write a review">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      )}

      {/* Full-screen review composer */}
      {(modal?.type === "newReview" || modal?.type === "newReviewWithItem" || modal?.type === "editReview") && (
        <WriteReviewScreen
          initItem={modal.type === "newReviewWithItem" ? modal.item : modal.type === "editReview" ? modal.review.item : null}
          initStars={modal.type === "editReview" ? modal.review.stars : 0}
          initText={modal.type === "editReview" ? modal.review.text : ""}
          isEdit={modal.type === "editReview"}
          onClose={() => setModal(null)}
          onSubmit={modal.type === "editReview"
            ? (_, s, t) => editReview(modal.review.id, s, t)
            : addReview}
        />
      )}
      {/* Full-screen list composer */}
      {(modal?.type === "newList" || modal?.type === "editList") && (
        <ListScreen
          initList={modal.type === "editList" ? modal.list : null}
          isEdit={modal.type === "editList"}
          onClose={() => setModal(null)}
          onSubmit={modal.type === "editList"
            ? (t, d, i) => editList(modal.list.id, t, d, i)
            : addList}
        />
      )}

      {alert && <Alert title={alert.title} message={alert.message} actions={alert.actions} onClose={() => setAlert(null)} />}
      {toast && <div className={`nw-toast ${toast.type || ""}`}>{toast.msg}</div>}
    </>
  );
}

/* ── Global Top Bar ── */
function TopBar({ currentUser, goHome, setModal, setTab, signOut }) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    const fn = e => { if (!menuRef.current?.contains(e.target)) setUserMenuOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);
  return (
    <header className="nw-topbar">
      <button className="nw-logo-btn" onClick={goHome}>noteworthy</button>
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
              <button className="user-menu-info" onClick={() => { setUserMenuOpen(false); setTab("profile"); }}>
                <Avatar user={currentUser} size={36} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{currentUser?.display_name}</div>
                  <div style={{ fontSize: 12, color: "#555" }}>@{currentUser?.username}</div>
                </div>
              </button>
              <button className="user-menu-item" onClick={() => { setUserMenuOpen(false); signOut(); }}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

/* ── Feed Tab ── */
function FeedTab({ reviews, allUsers, currentUser, myId, myFollowing, toggleLike, navigate, setModal, deleteReview, dbLoading, setArtistPage }) {
  const feed = reviews
    .filter(r => r.userId === myId || myFollowing.includes(r.userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return (
    <div className="screen">
      <div className="sticky-search">
        <div className="isb-wrap">
          <div className="isb-field" style={{ cursor: "pointer" }} onClick={() => setModal({ type: "newReview" })}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></svg>
            <span style={{ flex: 1, fontSize: 14, color: "var(--text4)" }}>Search to review a song or album…</span>
          </div>
        </div>
      </div>
      <div className="scroll-area">
        {dbLoading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
            <div className="auth-spin" />
          </div>
        ) : feed.length === 0 ? (
          <>
            <div className="empty-feed" style={{ paddingTop: 32 }}>
              <h2 className="empty-h">Start your diary</h2>
              <p className="empty-p">Search for something you've been listening to and leave your first review.</p>
              <button className="empty-cta" onClick={() => setModal({ type: "newReview" })}>Write a review</button>
            </div>
          </>
        ) : (
          feed.map(r => <ReviewCard key={r.id} review={r} currentUser={currentUser} allUsers={allUsers} toggleLike={toggleLike} navigate={navigate} setArtistPage={setArtistPage} onEdit={rev => setModal({ type: "editReview", review: rev })} onDelete={id => deleteReview(id)} />)
        )}
      </div>
    </div>
  );
}

/* ── Discover Tab ── */
function DiscoverTab({ allUsers, currentUser, myId, myFollowing, follows, toggleLike, navigate, setModal, toggleFollow, loadAllReviews, loadAllLists, setArtistPage }) {
  const [mainTab, setMainTab] = useState("music");
  const [peopleQ, setPeopleQ] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [activeType, setActiveType] = useState("tracks");
  const [searchQ, setSearchQ] = useState("");
  const [community, setCommunity] = useState([]);
  const [communityLoaded, setCommunityLoaded] = useState(false);
  const deb = useRef(null);

  useEffect(() => {
    loadAllReviews()
      .then(rows => {
        setCommunity(rows.filter(r => r.userId !== myId).slice(0, 20));
      })
      .catch(() => {})
      .finally(() => setCommunityLoaded(true));
  }, []);

  useEffect(() => {
    if (!searchQ.trim()) { setSearchResults(null); return; }
    clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { tracks, albums } = await musicSearch(searchQ) ?? { tracks: [], albums: [] };
        setSearchResults({ tracks, albums });
      } catch (e) { console.error(e); }
      setSearching(false);
    }, 340);
  }, [searchQ]);

  const displayed = activeType === "tracks" ? (searchResults?.tracks || []) : (searchResults?.albums || []);
  const [dbPeopleResults, setDbPeopleResults] = useState([]);
  const [peopleSearching, setPeopleSearching] = useState(false);
  const allKnownUsers = Object.values(allUsers).filter(u => u.id !== myId);

  // Search DB for people when query changes
  useEffect(() => {
    if (!peopleQ.trim()) { setDbPeopleResults([]); return; }
    const t = setTimeout(async () => {
      setPeopleSearching(true);
      try {
        const rows = await searchUsers(peopleQ.trim(), myId);
        setDbPeopleResults(rows);
      } catch (e) { console.error(e); }
      setPeopleSearching(false);
    }, 340);
    return () => clearTimeout(t);
  }, [peopleQ]);

  const peopleResults = peopleQ.trim() ? dbPeopleResults : allKnownUsers;

  return (
    <div className="screen">
      <div className="sticky-search">
        {mainTab === "music" ? (
          <div className="isb-wrap">
            <div className="isb-field">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></svg>
              <input className="isb-input" placeholder="Search music to review…" value={searchQ} onChange={e => setSearchQ(e.target.value)} />
              {searching && <div className="isb-spin" />}
              {searchQ && !searching && <button className="isb-x" onClick={() => { setSearchQ(""); setSearchResults(null); }}>✕</button>}
            </div>
          </div>
        ) : (
          <div className="isb-wrap">
            <div className="isb-field">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></svg>
              <input className="isb-input" placeholder="Search by name or username…" value={peopleQ} onChange={e => setPeopleQ(e.target.value)} />
              {peopleSearching && <div className="isb-spin" />}
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
                    <CoverWithPreview item={item} size={44} />
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
                {!communityLoaded
                  ? <div style={{ display: "flex", justifyContent: "center", padding: 20 }}><div className="auth-spin" /></div>
                  : community.length === 0
                    ? <div className="empty-inline">No reviews yet — be the first!</div>
                    : community.map(r => <ReviewCard key={r.id} review={r} currentUser={currentUser} allUsers={allUsers} toggleLike={toggleLike} navigate={navigate} setArtistPage={setArtistPage} onEdit={() => { }} onDelete={() => { }} />)
                }
              </>
            )}
          </>
        )}
        {mainTab === "people" && (
          <>
            {!peopleSearching && peopleResults.length === 0 && (
              <div className="empty-inline">{peopleQ ? "No users found." : "No other users yet. As friends join Noteworthy, they'll appear here."}</div>
            )}
            {peopleResults.map(u => {
              // Normalize DB rows that come back as {id, display_name, avatar_url}
              const user = u.images ? u : normalizeUser(u);
              const isFollowing = myFollowing.includes(user.id);
              const uReviews = community.filter(r => r.userId === user.id).length;
              return (
                <div key={user.id} className="people-row" onClick={() => navigate("profile", { userId: user.id })}>
                  <Avatar user={user} size={42} />
                  <div style={{ flex: 1 }}>
                    <div className="pr-name">{user.display_name || user.id}</div>
                    <div className="pr-meta">{uReviews} review{uReviews !== 1 ? "s" : ""}</div>
                  </div>
                  <button className={`btn-follow ${isFollowing ? "following" : ""}`} onClick={e => { e.stopPropagation(); toggleFollow(user.id, user); }}>
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

/* ── Notifications Tab ── */
function NotificationsTab({ myId, allUsers, navigate, notifSeen, onLoad }) {
  const [notifs, setNotifs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!myId) return;
    let done = false;
    const bail = setTimeout(() => { if (!done) setLoading(false); }, 12000);
    getNotifications(myId)
      .then(data => { setNotifs(data); onLoad?.(data); })
      .catch(() => {})
      .finally(() => { done = true; clearTimeout(bail); setLoading(false); });
    return () => clearTimeout(bail);
  }, [myId]);

  return (
    <div className="screen">
      <div className="scroll-area">
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
            <div className="auth-spin" />
          </div>
        ) : notifs.length === 0 ? (
          <div className="empty-feed">
            <div className="empty-art">🔔</div>
            <h2 className="empty-h">No notifications yet</h2>
            <p className="empty-p">Likes and comments on your reviews will appear here.</p>
          </div>
        ) : notifs.map(n => {
          const actor = allUsers[n.userId];
          const name = actor?.display_name || actor?.username || "Someone";
          const isNew = notifSeen && new Date(n.createdAt) > new Date(notifSeen);
          return (
            <div key={n.id} className={`notif-item${isNew ? " notif-new" : ""}`}
              onClick={() => navigate("reviewDetail", { reviewId: n.reviewId })}>
              <Avatar user={actor} size={38} />
              <div className="notif-body">
                <p className="notif-text">
                  <span className="notif-actor">{name}</span>
                  {n.type === "like" ? " liked your review of " : " commented on your review of "}
                  <span className="notif-title">{n.itemTitle}</span>
                </p>
                {n.type === "comment" && n.text && (
                  <p className="notif-quote">"{n.text.length > 80 ? n.text.slice(0, 80) + "…" : n.text}"</p>
                )}
                <p className="notif-time">{formatDate(n.createdAt)}</p>
              </div>
              <span className="notif-icon">{n.type === "like" ? "♥" : "💬"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Lists Tab ── */
function ListsTab({ lists, allUsers, currentUser, myId, navigate, setModal, setAlert, deleteList }) {
  return (
    <div className="screen">
      <div className="scroll-area">
        {lists.length === 0
          ? <div className="empty-feed"><div className="empty-art">📋</div><h2 className="empty-h">No lists yet</h2><p className="empty-p">Create a ranked list of your favorites.</p><button className="empty-cta" onClick={() => setModal({ type: "newList" })}>Create a list</button></div>
          : <>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                <button className="header-btn" onClick={() => setModal({ type: "newList" })}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  New list
                </button>
              </div>
              {lists.map(l => <ListCard key={l.id} list={l} allUsers={allUsers} currentUser={currentUser} myId={myId} navigate={navigate} setModal={setModal} setAlert={setAlert} deleteList={deleteList} />)}
            </>
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
          <div key={i} className="lc-row"><span className="lc-rank">{i + 1}</span><CoverArt item={item} size={34} /><div style={{ flex: 1, minWidth: 0 }}><div className="lc-iname">{item.title}</div><div className="lc-imeta">{item.artist}</div></div></div>
        ))}
        {list.items.length > 4 && <div className="lc-more">+{list.items.length - 4} more</div>}
      </div>
      {author && <div className="lc-foot"><Avatar user={author} size={16} /><span>{author.display_name || author.id} · {list.items.length} items</span></div>}
    </div>
  );
}

/* ── Favorite Artist Card (self-fetches photo if missing) ── */
function FavoriteArtistCard({ artist, onArtist, onRemove }) {
  const [img, setImg] = useState(artist.images?.[0]?.url ?? null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current || img) return;
    fetchedRef.current = true;
    fetchArtistImage(artist.name).then(url => { if (url) setImg(url); });
  }, [artist.name, img]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: "pointer", position: "relative" }}
      onClick={() => onArtist(artist)}>
      <button
        onClick={e => { e.stopPropagation(); onRemove(artist); }}
        style={{ position: "absolute", top: -4, right: -4, width: 20, height: 20, borderRadius: "50%", background: "var(--s3)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1, color: "var(--text3)", fontSize: 10 }}>
        ✕
      </button>
      <div style={{ width: 90, height: 90, borderRadius: "50%", overflow: "hidden", background: "var(--s2)", border: "2px solid var(--border2)" }}>
        {img
          ? <img src={img} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32 }}>🎵</div>
        }
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", textAlign: "center", lineHeight: 1.3, maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{artist.name}</div>
      {artist.genres?.[0] && <div style={{ fontSize: 10, color: "var(--text4)", textAlign: "center" }}>{artist.genres[0]}</div>}
    </div>
  );
}

/* ── Favorite Artists Grid ── */
function FavoriteArtistsGrid({ artists, onArtist, onRemove }) {
  if (!artists.length) return (
    <div className="empty-feed">
      <div className="empty-art">🎤</div>
      <h2 className="empty-h">No favorite artists yet</h2>
      <p className="empty-p">Tap any artist name on a review to open their page, then favorite them.</p>
    </div>
  );
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, padding: "4px 0 24px" }}>
        {artists.map(artist => (
          <FavoriteArtistCard key={artist.id} artist={artist} onArtist={onArtist} onRemove={onRemove} />
        ))}
      </div>
    </div>
  );
}

/* ── Fetch artist photo from Wikipedia (CORS-safe, no API key needed) ── */
async function fetchArtistImage(name) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(name)}&prop=pageimages&format=json&pithumbsize=600&origin=*`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const pages = json.query?.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    return page?.thumbnail?.source ?? null;
  } catch {
    return null;
  }
}

/* ── Artist Page ── */
function ArtistPage({ artist, reviews, allUsers, currentUser, myId, favoriteArtists, toggleFavoriteArtist, navigate, toggleLike, setModal, deleteReview, goBack }) {
  const isFav = favoriteArtists.some(a => a.id === artist.id);
  const [photo, setPhoto] = useState(artist.images?.[0]?.url ?? null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current || artist.images?.[0]?.url) return;
    fetchedRef.current = true;
    fetchArtistImage(artist.name).then(url => { if (url) setPhoto(url); });
  }, [artist.name, artist.images]);

  const img = photo;

  // Find all reviews mentioning this artist
  const artistReviews = reviews
    .filter(r => r.item.artist?.toLowerCase().includes(artist.name.toLowerCase()))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Aggregate community score
  const avgScore = artistReviews.length
    ? (artistReviews.reduce((s, r) => s + r.stars, 0) / artistReviews.length).toFixed(1)
    : null;

  return (
    <div className="subpage-ov" style={{ zIndex: 200 }}>
      {/* Hero */}
      <div style={{ position: "relative", width: "100%", height: 260, overflow: "hidden", flexShrink: 0 }}>
        {img && <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${img})`, backgroundSize: "cover", backgroundPosition: "center top", filter: "blur(0px) brightness(.55)" }} />}
        {!img && <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,var(--s2),var(--bg))" }} />}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, transparent 40%, var(--bg) 100%)" }} />

        {/* Back + Favorite buttons */}
        <div style={{ position: "absolute", top: 52, left: 16, right: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button className="back-btn" onClick={goBack} style={{ background: "rgba(0,0,0,.4)", borderRadius: "50%", width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <button
            onClick={() => toggleFavoriteArtist(photo ? { ...artist, images: [{ url: photo }] } : artist)}
            style={{ background: isFav ? "var(--red)" : "rgba(0,0,0,.4)", border: isFav ? "none" : "1px solid rgba(255,255,255,.3)", borderRadius: 20, padding: "7px 14px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", transition: "all .15s" }}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill={isFav ? "#fff" : "none"} stroke="#fff" strokeWidth="2" strokeLinecap="round">
              <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{isFav ? "Favorited" : "Favorite"}</span>
          </button>
        </div>

        {/* Artist info */}
        <div style={{ position: "absolute", bottom: 20, left: 20, right: 20 }}>
          <div style={{ fontFamily: "var(--serif)", fontSize: 28, fontStyle: "italic", color: "#fff", fontWeight: 700, lineHeight: 1.1, marginBottom: 6, textShadow: "0 2px 12px rgba(0,0,0,.5)" }}>{artist.name}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {artist.followers?.total && <span style={{ fontSize: 12, color: "rgba(255,255,255,.7)" }}>{(artist.followers.total / 1000000 >= 1 ? (artist.followers.total / 1000000).toFixed(1) + "M" : (artist.followers.total / 1000).toFixed(0) + "K")} followers</span>}
            {artist.genres?.[0] && <span style={{ fontSize: 11, color: "rgba(255,255,255,.5)", background: "rgba(255,255,255,.1)", padding: "2px 8px", borderRadius: 10 }}>{artist.genres[0]}</span>}
            {avgScore && (
              <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--gold)", fontWeight: 700 }}>
                <Stars value={parseFloat(avgScore)} size={11} />
                {avgScore} community avg
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Reviews */}
      <div className="scroll-area" style={{ paddingTop: 8 }}>
        <div className="sect-label" style={{ marginBottom: 12 }}>
          {artistReviews.length > 0 ? `${artistReviews.length} Review${artistReviews.length !== 1 ? "s" : ""} on Noteworthy` : "No reviews yet"}
        </div>
        {artistReviews.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <p style={{ fontSize: 14, color: "var(--text4)", marginBottom: 16 }}>Be the first to review {artist.name}</p>
          </div>
        ) : (
          artistReviews.map(r => (
            <ReviewCard key={r.id} review={r} currentUser={currentUser} allUsers={allUsers}
              toggleLike={toggleLike} navigate={navigate}
              onEdit={rev => setModal({ type: "editReview", review: rev })}
              onDelete={id => deleteReview(id)} />
          ))
        )}
      </div>
    </div>
  );
}

/* ── Avatar crop helpers ── */
function getCroppedBlob(imageSrc, pan, totalScale, rotation, containerSize, outputSize) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = outputSize; canvas.height = outputSize;
      const ctx = canvas.getContext('2d');
      const s = outputSize / containerSize;
      ctx.beginPath();
      ctx.arc(outputSize / 2, outputSize / 2, outputSize / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(outputSize / 2 + pan.x * s, outputSize / 2 + pan.y * s);
      ctx.rotate(rotation * Math.PI / 180);
      ctx.scale(totalScale * s, totalScale * s);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      canvas.toBlob(resolve, 'image/jpeg', 0.92);
    };
    img.src = imageSrc;
  });
}

function AvatarCropModal({ imageFile, onSave, onClose }) {
  const [imageSrc] = useState(() => URL.createObjectURL(imageFile));
  const [naturalSize, setNaturalSize] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const containerRef = useRef(null);
  const lastPos = useRef(null);
  const CONTAINER = 280, OUTPUT = 400;

  useEffect(() => () => URL.revokeObjectURL(imageSrc), [imageSrc]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onDown(e) {
      e.preventDefault();
      lastPos.current = { x: e.clientX, y: e.clientY };
      function onMove(mv) {
        setPan(prev => {
          const next = { x: prev.x + mv.clientX - lastPos.current.x, y: prev.y + mv.clientY - lastPos.current.y };
          lastPos.current = { x: mv.clientX, y: mv.clientY };
          return next;
        });
      }
      function onUp() {
        lastPos.current = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    el.addEventListener('mousedown', onDown);
    return () => el.removeEventListener('mousedown', onDown);
  }, []);

  const baseScale = naturalSize ? Math.max(CONTAINER / naturalSize.w, CONTAINER / naturalSize.h) : 1;
  const totalScale = zoom * baseScale;

  async function handleSave() {
    if (!naturalSize) return;
    setSaving(true);
    const blob = await getCroppedBlob(imageSrc, pan, totalScale, rotation, CONTAINER, OUTPUT);
    onSave(blob);
  }

  return (
    <div className="crop-modal">
      <div className="crop-modal-inner">
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', textAlign: 'center', marginBottom: 20 }}>Adjust Photo</div>
        <div
          ref={containerRef}
          className="crop-container"
          style={{ width: CONTAINER, height: CONTAINER }}
        >
          {naturalSize && (
            <img src={imageSrc} alt="" style={{
              position: 'absolute', left: '50%', top: '50%',
              width: naturalSize.w, height: naturalSize.h, maxWidth: 'none',
              transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) rotate(${rotation}deg) scale(${totalScale})`,
              transformOrigin: 'center', userSelect: 'none', pointerEvents: 'none',
            }} />
          )}
        </div>
        <div className="crop-controls">
          <div className="crop-slider-row">
            <span className="crop-slider-label">Zoom</span>
            <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={e => setZoom(parseFloat(e.target.value))} />
          </div>
          <div className="crop-slider-row">
            <span className="crop-slider-label">Rotate</span>
            <input type="range" min="-180" max="180" step="1" value={rotation} onChange={e => setRotation(parseInt(e.target.value))} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20, width: '100%' }}>
          <button className="crop-cancel-btn" onClick={onClose}>Cancel</button>
          <button className="crop-save-btn" onClick={handleSave} disabled={saving || !naturalSize}>
            {saving ? <span className="auth-spin" style={{ width: 14, height: 14, borderColor: '#000', borderTopColor: 'transparent' }} /> : 'Save Photo'}
          </button>
        </div>
      </div>
      {/* Hidden img used only to read natural dimensions */}
      <img src={imageSrc} style={{ display: 'none' }} onLoad={e => setNaturalSize({ w: e.target.naturalWidth, h: e.target.naturalHeight })} alt="" />
    </div>
  );
}

/* ── My Profile Tab ── */
function MyProfileTab({ currentUser, myId, reviews, lists, allUsers, toggleLike, navigate, setModal, setAlert, deleteReview, deleteList, myFollowing, follows, favoriteArtists, toggleFavoriteArtist, toggleFollow, onUpdateProfile, setArtistPage }) {
  const [tab, setTab] = useState("reviews");
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [cropFile, setCropFile] = useState(null);
  const [followModal, setFollowModal] = useState(null); // null | { title, fetchIds }
  const [lightbox, setLightbox] = useState(null);
  const avatarInputRef = useRef(null);

  function handleAvatarChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (!["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"].includes(file.type)) {
      setAlert({ title: "Invalid file", message: "Please choose a JPEG, PNG, WebP, or GIF image.", actions: [{ label: "OK", action: () => setAlert(null) }] });
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setAlert({ title: "File too large", message: "Please choose an image under 20MB.", actions: [{ label: "OK", action: () => setAlert(null) }] });
      return;
    }
    setCropFile(file);
  }

  async function handleCropSave(blob) {
    setCropFile(null);
    setUploadingAvatar(true);
    const file = new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
    const url = await uploadAvatar(myId, file);
    if (url) onUpdateProfile?.({ avatar_url: url });
    setUploadingAvatar(false);
  }

  async function handleEditAvatar() {
    const url = currentUser?.avatar_url || currentUser?.images?.[0]?.url;
    if (!url) { avatarInputRef.current?.click(); return; }
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      setCropFile(new File([blob], 'avatar.jpg', { type: blob.type || 'image/jpeg' }));
    } catch {
      avatarInputRef.current?.click();
    }
  }

  const avatarUrl = currentUser?.avatar_url || currentUser?.images?.[0]?.url;

  const myReviews = reviews.filter(r => r.userId === myId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const myLists = lists.filter(l => l.userId === myId);
  const myFollowingCount = myFollowing.length;
  const myFollowers = Object.entries(follows).filter(([uid, arr]) => uid !== myId && (Array.isArray(arr) ? arr.includes(myId) : false)).length;

  async function saveName() {
    const trimmed = nameVal.trim();
    if (!trimmed || trimmed === currentUser?.display_name) { setEditingName(false); return; }
    setSavingName(true);
    await updateDisplayName(myId, trimmed);
    onUpdateProfile?.({ display_name: trimmed });
    setSavingName(false);
    setEditingName(false);
  }

  return (
    <>
    {cropFile && <AvatarCropModal imageFile={cropFile} onSave={handleCropSave} onClose={() => setCropFile(null)} />}
    {lightbox && <PhotoLightbox src={lightbox} name={currentUser?.display_name} onClose={() => setLightbox(null)} />}
    {followModal && (
      <FollowListModal
        title={followModal.title}
        fetchIds={followModal.fetchIds}
        allUsers={allUsers}
        myId={myId}
        myFollowing={myFollowing}
        toggleFollow={toggleFollow}
        navigate={navigate}
        onClose={() => setFollowModal(null)}
      />
    )}
    <div className="screen">
      <div className="scroll-area">
        <div className="profile-hero">
          <div className="avatar-upload-wrap" onClick={() => !uploadingAvatar && avatarUrl && setLightbox(avatarUrl)}>
            <Avatar user={currentUser} size={70} />
            <div className="avatar-upload-overlay">
              {uploadingAvatar
                ? <span className="auth-spin" style={{ width: 18, height: 18, borderColor: "#fff", borderTopColor: "transparent" }} />
                : <div className="auo-actions">
                    <button className="auo-btn" onClick={e => { e.stopPropagation(); handleEditAvatar(); }}>Edit</button>
                    <button className="auo-btn" onClick={e => { e.stopPropagation(); avatarInputRef.current?.click(); }}>Upload</button>
                  </div>
              }
            </div>
            <input ref={avatarInputRef} type="file" accept="image/*,.heic,.heif" style={{ display: "none" }} onChange={handleAvatarChange} />
          </div>
          <div className="profile-stats">
            {[
              { label: "Reviews",   count: myReviews.length,    onClick: myReviews.length > 0     ? () => setTab("reviews")  : null },
              { label: "Following", count: myFollowingCount,    onClick: myFollowingCount > 0 ? () => setFollowModal({ title: "Following", fetchIds: () => getFollowing(myId) }) : null },
              { label: "Followers", count: myFollowers,         onClick: myFollowers > 0     ? () => setFollowModal({ title: "Followers", fetchIds: () => getFollowers(myId) }) : null },
            ].map(({ label, count, onClick }) => (
              <div key={label} className={`ps${onClick ? " ps-link" : ""}`} onClick={onClick ?? undefined}>
                <div className="ps-n">{count}</div><div className="ps-l">{label}</div>
              </div>
            ))}
          </div>
        </div>

        {editingName ? (
          <div className="name-edit-row">
            <input className="name-edit-input" value={nameVal} onChange={e => setNameVal(e.target.value)}
              maxLength={40} autoFocus onKeyDown={e => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }} />
            <button className="name-edit-save" onClick={saveName} disabled={savingName}>
              {savingName ? <span className="auth-spin" style={{ width: 13, height: 13 }} /> : "Save"}
            </button>
            <button className="name-edit-cancel" onClick={() => setEditingName(false)}>✕</button>
          </div>
        ) : (
          <div className="name-edit-row">
            <div className="profile-name" style={{ marginBottom: 0 }}>{currentUser?.display_name}</div>
            <button className="name-pencil-btn" title="Edit display name"
              onClick={() => { setNameVal(currentUser?.display_name ?? ""); setEditingName(true); }}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          </div>
        )}

        {currentUser?.username && <div className="profile-handle">@{currentUser.username}</div>}
        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          <button className="profile-act-btn" onClick={() => setModal({ type: "newReview" })}>+ Review</button>
          <button className="profile-act-btn" onClick={() => setModal({ type: "newList" })}>+ List</button>
        </div>
        <div className="seg-ctrl" style={{ overflowX: "auto", flexWrap: "nowrap" }}>
          {[["favorites", `Favorites (${favoriteArtists.length})`], ["reviews", `Reviews (${myReviews.length})`], ["lists", `Lists (${myLists.length})`]].map(([k, l]) => (
            <button key={k} className={`seg-btn ${tab === k ? "active" : ""}`} style={{ whiteSpace: "nowrap", flex: "0 0 auto", padding: "7px 12px" }} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        {tab === "favorites" && <FavoriteArtistsGrid artists={favoriteArtists} onArtist={artist => setArtistPage(artist)} onRemove={toggleFavoriteArtist} />}
        {tab === "reviews" && (myReviews.length === 0 ? <div className="empty-feed"><div className="empty-art">⭐</div><h2 className="empty-h">No reviews yet</h2><button className="empty-cta" onClick={() => setModal({ type: "newReview" })}>Write your first review</button></div> : myReviews.map(r => <ReviewCard key={r.id} review={r} currentUser={currentUser} allUsers={allUsers} toggleLike={toggleLike} navigate={navigate} setArtistPage={setArtistPage} onEdit={rev => setModal({ type: "editReview", review: rev })} onDelete={id => deleteReview(id)} />))}
        {tab === "lists" && (myLists.length === 0 ? <div className="empty-feed"><div className="empty-art">📋</div><h2 className="empty-h">No lists yet</h2></div> : myLists.map(l => <ListCard key={l.id} list={l} allUsers={allUsers} currentUser={currentUser} myId={myId} navigate={navigate} setModal={setModal} setAlert={setAlert} deleteList={deleteList} />))}
      </div>
    </div>
    </>
  );
}

/* ── Follow List Modal ── */
function FollowListModal({ title, fetchIds, allUsers, myId, myFollowing, toggleFollow, navigate, onClose }) {
  const [ids, setIds] = useState(null);
  useEffect(() => {
    fetchIds().then(setIds).catch(() => setIds([]));
  }, []);
  return (
    <div className="follow-modal-bg" onClick={onClose}>
      <div className="follow-modal" onClick={e => e.stopPropagation()}>
        <div className="follow-modal-hdr">
          <span className="nw-logo" style={{ fontSize: 17 }}>{title}</span>
          <button className="back-btn" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="follow-modal-list">
          {ids === null ? (
            <div style={{ display: "flex", justifyContent: "center", padding: 28 }}><div className="auth-spin" /></div>
          ) : ids.length === 0 ? (
            <div style={{ textAlign: "center", padding: 28, color: "var(--text4)", fontSize: 14 }}>Nobody here yet.</div>
          ) : ids.map(uid => {
            const user = allUsers[uid];
            const isMe = uid === myId;
            const isFollowing = myFollowing.includes(uid);
            return (
              <div key={uid} className="follow-modal-row">
                <button className="follow-modal-user" onClick={() => { onClose(); navigate("profile", { userId: uid }); }}>
                  <Avatar user={user || { id: uid }} size={36} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{user?.display_name || uid?.slice(0, 10)}</div>
                    {user?.username && <div style={{ fontSize: 12, color: "var(--text3)" }}>@{user.username}</div>}
                  </div>
                </button>
                {!isMe && (
                  <button className={`btn-follow ${isFollowing ? "following" : ""}`} onClick={() => toggleFollow(uid, user)}>
                    {isFollowing ? "Following" : "Follow"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── Profile Page (other users) ── */
function ProfilePage({ userId, reviews, lists, allUsers, currentUser, myId, myFollowing, follows, toggleLike, navigate, setModal, setAlert, deleteReview, deleteList, toggleFollow, goBack, loadUserData, setArtistPage }) {
  const [tab, setTab] = useState("reviews");
  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [followModal, setFollowModal] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const user = allUsers[userId];

  useEffect(() => {
    loadUserData(userId).then(data => { setUserData(data); setLoading(false); });
  }, [userId]);

  const isFollowing = myFollowing.includes(userId);
  const userReviews = userData?.reviews ?? reviews.filter(r => r.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const userLists = userData?.lists ?? lists.filter(l => l.userId === userId);
  const userFollowing = userData?.followingCount ?? 0;
  const userFollowers = userData?.followersCount ?? 0;

  if (!user) return (
    <div className="screen">
      <header className="nw-header"><button className="back-btn" onClick={goBack}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#007AFF" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg></button><span className="nw-logo" style={{ fontSize: 17 }}>Profile</span><div style={{ width: 32 }} /></header>
      <div className="scroll-area"><div className="empty-inline">User not found.</div></div>
    </div>
  );

  return (
    <>
    {followModal && (
      <FollowListModal
        title={followModal.title}
        fetchIds={followModal.fetchIds}
        allUsers={allUsers}
        myId={myId}
        myFollowing={myFollowing}
        toggleFollow={toggleFollow}
        navigate={navigate}
        onClose={() => setFollowModal(null)}
      />
    )}
    {lightbox && <PhotoLightbox src={lightbox} name={user?.display_name} onClose={() => setLightbox(null)} />}
    <div className="screen">
      <header className="nw-header" style={{ borderBottom: "none" }}>
        <button className="back-btn" onClick={goBack}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#007AFF" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg></button>
        <span className="nw-logo" style={{ fontSize: 17 }}>{user.display_name || user.username}</span>
        <div style={{ width: 32 }} />
      </header>
      <div className="scroll-area">
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 40 }}><div className="auth-spin" /></div>
        ) : (
          <>
            <div className="profile-hero">
              {(() => { const u = user?.avatar_url || user?.images?.[0]?.url; return u
                ? <div className="avatar-view-wrap" onClick={() => setLightbox(u)}><Avatar user={user} size={70} /></div>
                : <Avatar user={user} size={70} />; })()}
              <div className="profile-stats">
                {[
                  { label: "Reviews",   count: userReviews.length, onClick: userReviews.length > 0 ? () => setTab("reviews") : null },
                  { label: "Following", count: userFollowing,       onClick: userFollowing > 0  ? () => setFollowModal({ title: "Following", fetchIds: () => getFollowing(userId) }) : null },
                  { label: "Followers", count: userFollowers,       onClick: userFollowers > 0  ? () => setFollowModal({ title: "Followers", fetchIds: () => getFollowers(userId) }) : null },
                ].map(({ label, count, onClick }) => (
                  <div key={label} className={`ps${onClick ? " ps-link" : ""}`} onClick={onClick ?? undefined}>
                    <div className="ps-n">{count}</div><div className="ps-l">{label}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="profile-name">{user.display_name || user.username}</div>
            {userId !== myId && <button className={`profile-follow-btn ${isFollowing ? "following" : ""}`} onClick={() => toggleFollow(userId, user)}>{isFollowing ? "Following" : "Follow"}</button>}
            <div className="seg-ctrl">
              {[["reviews", `Reviews (${userReviews.length})`], ["lists", `Lists (${userLists.length})`]].map(([k, l]) => (
                <button key={k} className={`seg-btn ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>
            {tab === "reviews" && (userReviews.length === 0 ? <div className="empty-inline">No reviews yet.</div> : userReviews.map(r => <ReviewCard key={r.id} review={r} currentUser={currentUser} allUsers={allUsers} toggleLike={toggleLike} navigate={navigate} setArtistPage={setArtistPage} onEdit={rev => setModal({ type: "editReview", review: rev })} onDelete={id => deleteReview(id)} />))}
            {tab === "lists" && (userLists.length === 0 ? <div className="empty-inline">No lists yet.</div> : userLists.map(l => <ListCard key={l.id} list={l} allUsers={allUsers} currentUser={currentUser} myId={myId} navigate={navigate} setModal={setModal} setAlert={setAlert} deleteList={deleteList} />))}
          </>
        )}
      </div>
    </div>
    </>
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
          <div style={{ position: "relative", display: "inline-flex" }}>
            <CoverArt item={live.item} size={116} />
            {live.item.previewUrl && <PreviewButton url={live.item.previewUrl} large />}
          </div>
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
          <button className={`rc-act ${liked ? "liked" : ""}`} onClick={() => toggleLike(live.id, live)}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill={liked ? "#E9463F" : "none"} stroke={liked ? "#E9463F" : "#555"} strokeWidth="2" strokeLinecap="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
            {live.likes?.length || 0} {live.likes?.length === 1 ? "like" : "likes"}
          </button>
        </div>
        <div className="rd-stream">
          <div className="rd-stream-label">Listen on</div>
          <div className="rd-stream-links">
            {live.item.previewUrl && (
              <a className="rd-sl rd-sl-preview" href={live.item.previewUrl} target="_blank" rel="noopener noreferrer">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                Preview
              </a>
            )}
            {live.item.appleUrl && (
              <a className="rd-sl rd-sl-apple" href={live.item.appleUrl} target="_blank" rel="noopener noreferrer">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a5.022 5.022 0 00-1.877-.726 10.496 10.496 0 00-1.564-.15c-.04-.003-.083-.01-.124-.013H5.986c-.152.01-.303.017-.455.026C4.786.07 4.043.15 3.34.428 2.004.958 1.04 1.88.475 3.208c-.192.448-.292.925-.363 1.408-.056.392-.088.785-.1 1.18 0 .032-.007.062-.01.093v12.223c.01.14.017.283.027.424.05.815.154 1.624.497 2.373.65 1.42 1.738 2.353 3.234 2.802.42.127.856.187 1.293.228.555.053 1.11.06 1.667.06h11.03c.525 0 1.048-.034 1.57-.1.823-.106 1.597-.35 2.296-.81a5.046 5.046 0 001.88-2.207c.186-.42.293-.87.37-1.324.113-.675.14-1.358.138-2.04-.003-3.8 0-7.595-.003-11.393zm-6.423 3.99v5.712c0 .417-.058.827-.244 1.206-.29.59-.76.962-1.388 1.14-.35.1-.706.157-1.07.173-.95.045-1.773-.6-1.943-1.536a1.88 1.88 0 011.038-2.022c.323-.16.67-.25 1.018-.324.378-.082.758-.153 1.134-.24.274-.063.457-.23.51-.516a.904.904 0 00.02-.183c0-1.956 0-3.912.003-5.868 0-.122-.034-.16-.156-.138-.795.154-1.59.3-2.387.45l-3.235.616c-.1.02-.161.055-.161.18.004 2.8.003 5.6.003 8.4v.188c0 .002-.004.006-.01.016-.12-.048-.232-.09-.34-.142a1.869 1.869 0 01-1.08-1.726c.015-.9.584-1.67 1.44-1.938.318-.1.65-.157.974-.228.356-.076.713-.15 1.07-.225.25-.053.45-.2.51-.47a.921.921 0 00.022-.21c.001-1.994 0-3.988.003-5.982 0-.135.033-.167.166-.19l5.822-1.1c.151-.026.22.004.22.188-.006 1.093-.003 2.185-.003 3.278z"/></svg>
                Apple Music
              </a>
            )}
            <a className="rd-sl rd-sl-spotify" href={`https://open.spotify.com/search/${encodeURIComponent(live.item.artist + ' ' + live.item.title)}`} target="_blank" rel="noopener noreferrer">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
              Spotify
            </a>
            <a className="rd-sl rd-sl-tidal" href={`https://tidal.com/search?q=${encodeURIComponent(live.item.artist + ' ' + live.item.title)}`} target="_blank" rel="noopener noreferrer">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12.012 3.992L8.008 7.996 4.004 3.992 0 7.996l4.004 4.004 4.004-4.004 4.004 4.004 4.004-4.004L20.02 12l4.004-4.004-4.004-4.004-4.004 4.004-4.004-4.004zM8.008 16.008l4.004-4.004 4.004 4.004-4.004 4.004z"/></svg>
              Tidal
            </a>
            <a className="rd-sl rd-sl-ytmusic" href={`https://music.youtube.com/search?q=${encodeURIComponent(live.item.artist + ' ' + live.item.title)}`} target="_blank" rel="noopener noreferrer">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228s6.228-2.796 6.228-6.228S15.432 5.772 12 5.772zM9.684 15.54V8.46L16.2 12l-6.516 3.54z"/></svg>
              YT Music
            </a>
          </div>
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
          <div key={i} className="ld-row"><div className="ld-rank">{i + 1}</div><CoverArt item={item} size={46} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15, fontWeight: 600, color: "#e8e8e8" }}>{item.title}</div><div style={{ fontSize: 12, color: "#555" }}>{item.artist} · {item.type}</div></div></div>
        ))}
      </div>
    </div>
  );
}

/* ── CSS (unchanged) ── */
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
.auth-form{display:flex;flex-direction:column;gap:10px;width:100%}
.auth-input{background:var(--s2);border:1px solid var(--border2);border-radius:8px;padding:13px 14px;color:var(--text);font-family:var(--font);font-size:15px;outline:none;transition:border-color .15s;width:100%}
.auth-input:focus{border-color:var(--green)}
.auth-input::placeholder{color:var(--text4)}
.auth-submit{background:var(--green);color:#000;border:none;font-family:var(--font);font-size:15px;font-weight:700;padding:14px;border-radius:8px;cursor:pointer;transition:opacity .15s;display:flex;align-items:center;justify-content:center;min-height:48px}
.auth-submit:hover{opacity:.88}
.auth-submit:disabled{opacity:.5;cursor:not-allowed}
.auth-error{font-size:13px;color:var(--red);text-align:center;margin:0}
.auth-toggle{font-size:13px;color:var(--text3);text-align:center}
.auth-toggle-btn{background:none;border:none;color:var(--green);font-family:var(--font);font-size:13px;font-weight:600;cursor:pointer;padding:0;text-decoration:underline}
.auth-loading{display:flex;align-items:center;gap:12px;color:var(--text2);font-size:15px}
.auth-spin{width:20px;height:20px;border:2px solid var(--s3);border-top-color:var(--green);border-radius:50%;animation:spin .8s linear infinite}
.nw-app{max-width:430px;margin:0 auto;min-height:100vh;background:var(--bg);position:relative}
.nw-main{padding-bottom:var(--tab-h)}
.screen{display:flex;flex-direction:column;min-height:100vh}
.subpage-ov{position:fixed;inset:0;z-index:100;background:var(--bg);overflow-y:auto;max-width:430px;margin:0 auto;animation:slideUp .2s ease}
.nw-topbar{display:flex;align-items:center;justify-content:space-between;padding:48px 16px 12px;position:sticky;top:0;z-index:25;background:rgba(20,24,28,.93);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid var(--border)}
.nw-header{display:flex;align-items:center;justify-content:space-between;padding:48px 16px 12px;position:sticky;top:0;z-index:20;background:rgba(20,24,28,.93);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid var(--border)}
.nw-logo{font-family:var(--serif);font-size:22px;color:var(--text);font-style:italic;letter-spacing:-.3px}
.nw-logo-btn{font-family:var(--serif);font-size:22px;color:var(--text);font-style:italic;letter-spacing:-.3px;background:none;border:none;cursor:pointer;padding:0;transition:opacity .15s}
.nw-logo-btn:hover{opacity:.7}
.back-btn{background:none;border:none;cursor:pointer;padding:4px;display:flex;align-items:center;width:32px}
.header-btn{display:flex;align-items:center;gap:5px;background:var(--green);color:#000;border:none;font-family:var(--font);font-size:13px;font-weight:700;padding:7px 14px;border-radius:4px;cursor:pointer;transition:opacity .15s}
.header-btn:hover{opacity:.88}
.avatar-btn{display:flex;align-items:center;gap:5px;background:none;border:none;cursor:pointer;padding:3px;border-radius:20px}
.user-menu{position:absolute;top:calc(100% + 8px);right:0;background:var(--s2);border:1px solid var(--border2);border-radius:10px;min-width:200px;overflow:hidden;z-index:300;box-shadow:0 8px 32px rgba(0,0,0,.7);animation:slideUp .15s ease}
.user-menu-info{display:flex;align-items:center;gap:10px;padding:14px 14px 12px;border-bottom:1px solid var(--border);width:100%;background:none;border-left:none;border-right:none;border-top:none;font-family:var(--font);cursor:pointer;text-align:left;transition:background .1s}
.user-menu-info:hover{background:var(--s3)}
.user-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:11px 14px;background:none;border:none;color:var(--text2);font-family:var(--font);font-size:14px;cursor:pointer;transition:background .1s}
.user-menu-item:hover{background:var(--s3);color:var(--text)}
.sticky-search{padding:8px 14px;background:rgba(20,24,28,.93);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);position:sticky;top:89px;z-index:19;border-bottom:1px solid var(--border)}
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
.rc{display:flex;flex-direction:column;background:var(--s1);border-radius:8px;margin-bottom:12px;margin-left:auto;margin-right:auto;width:95%;border:1px solid var(--border);transition:border-color .15s}
.rc:hover{border-color:var(--border2)}
.rc-art{position:relative;width:100%;height:220px;overflow:hidden;cursor:pointer;border-radius:6px 6px 0 0}
.rc-art-img{width:100%;height:100%;object-fit:contain;display:block;transition:transform .3s;background:#0a0c0e}
.rc:hover .rc-art-img{transform:scale(1.01)}
.rc-art-bg{width:100%;height:100%;background:linear-gradient(135deg,hsl(calc(var(--h,200)*1deg),35%,12%),hsl(calc((var(--h,200)+50)*1deg),30%,8%))}
.rc-art-fade{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 45%,rgba(20,24,28,.95) 100%)}
.rc-art-stars{position:absolute;bottom:10px;right:10px}
.rc-art-badge{position:absolute;top:10px;left:10px;background:rgba(20,24,28,.6);backdrop-filter:blur(6px);color:rgba(255,255,255,.6);font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;padding:3px 7px;border-radius:3px}
.rc-body{padding:11px 13px 0}
.rc-track-row{cursor:pointer;margin-bottom:8px}
.rc-track-name{font-family:var(--serif);font-size:17px;font-style:italic;color:var(--text);line-height:1.2}
.rc-track-sub{font-size:12px;color:var(--text3);margin-top:2px}
.rc-artist-link{background:none;border:none;padding:0;font-size:12px;color:var(--text3);cursor:pointer;font-family:var(--font);transition:color .1s}
.rc-artist-link:hover{color:var(--green)}
.rc-meta-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.rc-author{display:flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;padding:0}
.rc-author-name{font-size:12px;font-weight:600;color:var(--text2);transition:color .1s}
.rc-author:hover .rc-author-name{color:var(--green)}
.rc-date{font-size:11px;color:var(--text4)}
.rc-menu-btn{background:none;border:none;cursor:pointer;padding:4px;display:flex;align-items:center}
.rc-menu-drop{position:absolute;bottom:calc(100% + 4px);right:0;background:var(--s2);border:1px solid var(--border2);border-radius:7px;overflow:hidden;z-index:999;min-width:110px;box-shadow:0 6px 20px rgba(0,0,0,.7);animation:slideUp .12s ease}
.rc-menu-drop button{display:block;width:100%;padding:10px 14px;background:none;border:none;color:var(--text2);font-family:var(--font);font-size:13px;text-align:left;cursor:pointer;transition:background .1s}
.rc-menu-drop button:hover{background:var(--s3);color:var(--text)}
.rc-menu-drop button.danger{color:#e44}
.rc-menu-drop button.danger:hover{background:rgba(228,68,68,.12)}
.rc-snippet{font-size:13px;color:var(--text2);line-height:1.6;margin-bottom:9px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;cursor:pointer}
.rc-snippet p{margin-bottom:4px}
.rc-snippet strong{color:var(--text)}
.rc-snippet em{font-style:italic}
.rc-snippet blockquote{border-left:2px solid var(--green);padding-left:8px;color:var(--text3);font-style:italic}
.rc-actions{display:flex;gap:12px;padding-bottom:13px;padding-top:4px}
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
.ps{flex:1;text-align:center;padding:4px 0;border-radius:8px;transition:background .1s}
.ps-link{cursor:pointer}
.ps-link:hover{background:var(--s2)}
.ps-n{font-size:20px;font-weight:700;color:var(--text);font-family:var(--serif)}
.ps-l{font-size:11px;color:var(--text3);margin-top:1px;letter-spacing:.3px;text-transform:uppercase}
.follow-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:400;display:flex;align-items:flex-end;justify-content:center;animation:fadeIn .15s ease}
.follow-modal{background:var(--s1);border-radius:16px 16px 0 0;width:100%;max-width:430px;max-height:72vh;display:flex;flex-direction:column;animation:slideUp .2s ease}
.follow-modal-hdr{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px;border-bottom:1px solid var(--border);flex-shrink:0}
.follow-modal-list{overflow-y:auto;flex:1;padding:6px 0 24px}
.follow-modal-row{display:flex;align-items:center;gap:12px;padding:10px 16px}
.follow-modal-user{display:flex;align-items:center;gap:10px;flex:1;background:none;border:none;cursor:pointer;padding:0;text-align:left;min-width:0}
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
.rd-stream{padding:12px 0 4px}
.rd-stream-label{font-size:11px;font-weight:700;color:var(--text3);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px}
.rd-stream-links{display:flex;gap:8px;flex-wrap:wrap}
.rd-sl{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;font-family:var(--font);text-decoration:none;padding:6px 11px;border-radius:20px;border:1px solid var(--border2);color:var(--text2);transition:all .15s;white-space:nowrap}
.rd-sl:hover{border-color:var(--text2);color:var(--text)}
.rd-sl-preview{border-color:var(--green);color:var(--green)}
.rd-sl-preview:hover{background:var(--green);color:#000}
.rd-sl-apple:hover{border-color:#fc3c44;color:#fc3c44}
.rd-sl-spotify:hover{border-color:#1DB954;color:#1DB954}
.rd-sl-tidal:hover{border-color:#00FFFF;color:#00FFFF}
.rd-sl-ytmusic:hover{border-color:#FF0000;color:#FF0000}
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
.rich-body{padding:11px 13px;min-height:180px;outline:none;color:var(--text2);font-family:var(--font);font-size:14px;line-height:1.65;caret-color:var(--green)}
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
.lib-shelf-scroll{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;cursor:grab}
.lib-shelf-scroll::-webkit-scrollbar{display:none}
.lib-shelf-scroll:active{cursor:grabbing}
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
.tab-badge{position:absolute;top:-5px;right:-7px;min-width:16px;height:16px;padding:0 4px;background:var(--green);color:#000;font-size:9px;font-weight:800;border-radius:8px;display:flex;align-items:center;justify-content:center;line-height:1;pointer-events:none}
.notif-item{display:flex;align-items:flex-start;gap:12px;padding:13px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .12s}
.notif-item:hover{background:var(--s2)}
.notif-item.notif-new{background:rgba(0,192,48,.05)}
.notif-body{flex:1;min-width:0}
.notif-text{font-size:13px;color:var(--text2);line-height:1.45;margin-bottom:3px}
.notif-actor{font-weight:700;color:var(--text)}
.notif-title{font-weight:600;color:var(--text)}
.notif-quote{font-size:12px;color:var(--text3);font-style:italic;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.notif-time{font-size:11px;color:var(--text4)}
.notif-icon{font-size:14px;flex-shrink:0;padding-top:1px;color:var(--text3)}
.notif-item.notif-new .notif-icon{color:var(--green)}
.name-edit-row{display:flex;align-items:center;gap:8px;margin-bottom:3px}
.name-edit-input{background:var(--s2);border:1px solid var(--green);border-radius:5px;color:var(--text);font-family:var(--serif);font-size:19px;font-weight:700;font-style:italic;padding:3px 9px;outline:none;min-width:0;flex:1;max-width:240px}
.name-edit-save{background:var(--green);border:none;color:#000;font-family:var(--font);font-size:12px;font-weight:700;padding:5px 11px;border-radius:4px;cursor:pointer;display:flex;align-items:center;gap:5px}
.name-edit-save:disabled{opacity:.5;cursor:not-allowed}
.name-edit-cancel{background:none;border:none;color:var(--text4);font-size:16px;cursor:pointer;padding:4px;line-height:1;transition:color .12s}
.name-edit-cancel:hover{color:var(--text2)}
.name-pencil-btn{background:none;border:none;color:var(--text4);cursor:pointer;padding:4px;display:flex;align-items:center;transition:color .12s;flex-shrink:0}
.name-pencil-btn:hover{color:var(--green)}
.avatar-upload-wrap{position:relative;cursor:pointer;display:inline-flex;flex-shrink:0}
.avatar-upload-overlay{position:absolute;inset:0;border-radius:50%;background:rgba(0,0,0,0);display:flex;align-items:center;justify-content:center;transition:background .15s;opacity:0}
.avatar-upload-wrap:hover .avatar-upload-overlay{background:rgba(0,0,0,.6);opacity:1}
.auo-actions{display:flex;flex-direction:column;align-items:center;gap:5px}
.auo-btn{background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.35);color:#fff;font-family:var(--font);font-size:10px;font-weight:700;padding:4px 10px;border-radius:4px;cursor:pointer;letter-spacing:.4px;text-transform:uppercase;transition:background .1s;white-space:nowrap}
.auo-btn:hover{background:rgba(255,255,255,.2)}
.avatar-view-wrap{display:inline-flex;flex-shrink:0;cursor:pointer;border-radius:50%;transition:opacity .15s}
.avatar-view-wrap:hover{opacity:.85}
.lightbox-bg{position:fixed;inset:0;background:rgba(0,0,0,.82);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);z-index:600;display:flex;align-items:center;justify-content:center;animation:fadeIn .15s ease;cursor:pointer}
.lightbox-img{width:min(300px,80vw);height:min(300px,80vw);border-radius:50%;object-fit:cover;box-shadow:0 24px 64px rgba(0,0,0,.9);cursor:default;animation:popIn .2s cubic-bezier(.34,1.56,.64,1)}
.lightbox-close{position:fixed;top:18px;right:18px;background:rgba(255,255,255,.12);border:none;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;z-index:601}
.lightbox-close:hover{background:rgba(255,255,255,.22)}
.preview-btn{position:absolute;bottom:4px;right:4px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.7);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;backdrop-filter:blur(4px);transition:background .15s;z-index:2}
.preview-btn:hover{background:rgba(0,0,0,.9)}
.preview-btn-lg{width:34px;height:34px;bottom:7px;right:7px}
.apple-music-link{display:inline-flex;align-items:center;gap:6px;color:var(--text3);font-size:13px;font-family:var(--font);text-decoration:none;padding:6px 10px;border:1px solid var(--border);border-radius:6px;transition:color .15s,border-color .15s}
.apple-music-link:hover{color:#fc3c44;border-color:#fc3c44}
.crop-modal{position:fixed;inset:0;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}
.crop-modal-inner{background:var(--s1);border-radius:16px;padding:24px;display:flex;flex-direction:column;align-items:center;width:100%;max-width:340px;border:1px solid var(--border)}
.crop-container{border-radius:50%;overflow:hidden;background:#000;position:relative;flex-shrink:0;touch-action:none;cursor:grab;user-select:none}
.crop-container:active{cursor:grabbing}
.crop-controls{width:100%;margin-top:20px;display:flex;flex-direction:column;gap:12px}
.crop-slider-row{display:flex;align-items:center;gap:12px}
.crop-slider-label{font-size:12px;color:var(--text3);width:44px;flex-shrink:0;text-align:right}
.crop-slider-row input[type=range]{flex:1;accent-color:var(--green);height:4px}
.crop-cancel-btn{flex:1;background:var(--s2);border:1px solid var(--border);color:var(--text);font-family:var(--font);font-size:14px;font-weight:600;padding:12px;border-radius:8px;cursor:pointer}
.crop-save-btn{flex:1;background:var(--green);border:none;color:#000;font-family:var(--font);font-size:14px;font-weight:700;padding:12px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px}
.crop-save-btn:disabled{opacity:.5;cursor:not-allowed}
`;
