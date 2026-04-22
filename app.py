import json, os, re, secrets, threading, queue as q_mod
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs

import requests as http
import stripe
from authlib.integrations.flask_client import OAuth
from dotenv import load_dotenv
from flask import (Flask, Response, flash, jsonify, redirect,
                   render_template, request, send_file, stream_with_context, url_for)
from flask_cors import CORS
from flask_login import (LoginManager, UserMixin, current_user,
                         login_required, login_user, logout_user)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()

# ── app setup ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
# Force https in url_for() when running behind Render's proxy
app.wsgi_app = __import__('werkzeug.middleware.proxy_fix', fromlist=['ProxyFix']).ProxyFix(
    app.wsgi_app, x_proto=1, x_host=1
)
app.config.update(
    SECRET_KEY              = os.getenv("SECRET_KEY", "change-me"),
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL", "sqlite:///gdrive.db"),
    SQLALCHEMY_TRACK_MODIFICATIONS = False,
)

stripe.api_key         = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_PRICE_ID        = os.getenv("STRIPE_PRICE_ID", "")
STRIPE_WEBHOOK_SECRET  = os.getenv("STRIPE_WEBHOOK_SECRET", "")
APP_URL                = os.getenv("APP_URL", "http://localhost:8080")
DOWNLOAD_DIR           = Path(os.getenv("DOWNLOAD_DIR", str(Path.home() / "Downloads")))
FREE_LIMIT             = int(os.getenv("FREE_LIMIT", "3"))   # lifetime, not monthly

db  = SQLAlchemy(app)
lm  = LoginManager(app)
lm.login_view = "login"
lm.login_message_category = "info"

# CORS for Chrome extension API calls
CORS(app, resources={r"/api/v1/*": {"origins": "*",
     "allow_headers": ["Content-Type", "X-API-Key"]}})

# Google OAuth
oauth = OAuth(app)
google_oauth = oauth.register(
    name="google",
    client_id=os.getenv("GOOGLE_CLIENT_ID", ""),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET", ""),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)


# ── models ────────────────────────────────────────────────────────────────────
class User(UserMixin, db.Model):
    id                     = db.Column(db.Integer, primary_key=True)
    name                   = db.Column(db.String(120), nullable=False)
    email                  = db.Column(db.String(255), unique=True, nullable=False)
    password_hash          = db.Column(db.String(255))          # nullable for Google users
    google_id              = db.Column(db.String(120), unique=True)
    api_key                = db.Column(db.String(64), unique=True)
    plan                   = db.Column(db.String(20), default="free")
    stripe_customer_id     = db.Column(db.String(120))
    stripe_subscription_id = db.Column(db.String(120))
    cookies_json           = db.Column(db.Text, default="{}")
    total_downloads        = db.Column(db.Integer, default=0)   # lifetime counter
    is_admin               = db.Column(db.Boolean, default=False)
    created_at             = db.Column(db.DateTime, default=datetime.utcnow)
    downloads              = db.relationship("Download", backref="user", lazy=True,
                                             order_by="Download.created_at.desc()")

    def set_password(self, pw):
        self.password_hash = generate_password_hash(pw)

    def check_password(self, pw):
        if not self.password_hash:
            return False
        return check_password_hash(self.password_hash, pw)

    def can_download(self):
        if self.plan == "pro":
            return True
        return self.total_downloads < FREE_LIMIT

    def remaining_downloads(self):
        if self.plan == "pro":
            return None
        return max(0, FREE_LIMIT - self.total_downloads)

    def increment_downloads(self):
        self.total_downloads += 1
        db.session.commit()

    def get_or_create_api_key(self):
        if not self.api_key:
            self.api_key = secrets.token_urlsafe(32)
            db.session.commit()
        return self.api_key

    @property
    def cookies(self):
        try:
            return json.loads(self.cookies_json or "{}")
        except Exception:
            return {}

    @cookies.setter
    def cookies(self, value):
        self.cookies_json = json.dumps(value)


class Download(db.Model):
    id         = db.Column(db.Integer, primary_key=True)
    user_id    = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    filename   = db.Column(db.String(500))
    video_id   = db.Column(db.String(200))
    size_mb    = db.Column(db.Float)
    status     = db.Column(db.String(50), default="completed")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


@lm.user_loader
def load_user(uid):
    return User.query.get(int(uid))


# ── per-user SSE state ────────────────────────────────────────────────────────
_states: dict = {}
_lock = threading.Lock()

def _get_state(uid):
    with _lock:
        if uid not in _states:
            _states[uid] = {"busy": False, "status": "Ready",
                            "progress": 0.0, "clients": []}
        return _states[uid]

def _broadcast(uid, data):
    msg = f"data: {json.dumps(data)}\n\n"
    for q in list(_get_state(uid)["clients"]):
        try:
            q.put_nowait(msg)
        except Exception:
            pass

def _set_status(uid, status, progress=None):
    st = _get_state(uid)
    st["status"] = status
    if progress is not None:
        st["progress"] = round(progress, 1)
    _broadcast(uid, {"status": st["status"], "progress": st["progress"]})


# ── download helpers ──────────────────────────────────────────────────────────
MIME_EXT = {
    "application/pdf":                                                          ".pdf",
    "application/msword":                                                       ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":  ".docx",
    "application/vnd.ms-excel":                                                 ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":        ".xlsx",
    "application/vnd.ms-powerpoint":                                            ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":".pptx",
    "application/zip":                                                          ".zip",
    "application/x-zip-compressed":                                            ".zip",
    "image/jpeg":  ".jpg", "image/png": ".png", "image/gif": ".gif",
    "image/webp":  ".webp", "image/svg+xml": ".svg",
    "text/plain":  ".txt", "text/csv": ".csv",
    "audio/mpeg":  ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav",
    "video/mp4":   ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
}

def extract_file_id(text):
    m = re.search(r'/(?:file|document|spreadsheets|presentation)/d/([a-zA-Z0-9_-]+)', text)
    if m:
        return m.group(1)
    qs = parse_qs(urlparse(text).query)
    if 'id' in qs:
        return qs['id'][0]
    return text.strip()

# Keep old name as alias for compatibility
extract_video_id = extract_file_id

def detect_gdoc_type(url):
    """Return (export_url, ext) for Google Workspace files, else (None, None)."""
    if "/document/d/"     in url: return "docx"
    if "/spreadsheets/d/" in url: return "xlsx"
    if "/presentation/d/" in url: return "pptx"
    if "/forms/d/"        in url: return "pdf"
    return None

def get_video_info(file_id, cookies):
    """Try Drive's video streaming API — returns (stream_url, title) or (None, None)."""
    url = (f"https://drive.google.com/u/0/get_video_info"
           f"?docid={file_id}&drive_originator_app=303")
    r = http.get(url, cookies=cookies, timeout=30)
    cookies.update(r.cookies.get_dict())
    video_url = title = None
    for part in r.text.split("&"):
        if part.startswith("title=") and not title:
            title = unquote(part.split("=", 1)[1])
        elif "videoplayback" in part and not video_url:
            video_url = unquote(part).split("|")[-1]
        if video_url and title:
            break
    return video_url, title

def get_direct_download(file_id, cookies):
    """
    Get download URL and filename for any Drive file.
    Handles Google's large-file virus-scan confirmation page.
    Returns (download_url, filename, ext).
    """
    base = f"https://drive.google.com/uc?export=download&id={file_id}"
    session = http.Session()
    for k, v in cookies.items():
        session.cookies.set(k, v)

    r = session.get(base, stream=True, timeout=30, allow_redirects=True)
    cookies.update(session.cookies.get_dict())

    # Google shows an HTML confirmation page for large files
    ct = r.headers.get("Content-Type", "")
    if "text/html" in ct:
        # Extract confirmation token
        confirm = re.search(r'confirm=([^&"\'>\s]+)', r.text)
        uuid    = re.search(r'uuid=([^&"\'>\s]+)',    r.text)
        if not confirm:
            return None, None, None
        dl_url = f"{base}&confirm={confirm.group(1)}"
        if uuid:
            dl_url += f"&uuid={uuid.group(1)}"
        # Re-fetch headers only
        r = session.head(dl_url, allow_redirects=True, timeout=30)
        cookies.update(session.cookies.get_dict())
        ct = r.headers.get("Content-Type", "")
    else:
        dl_url = base

    # Derive extension from MIME type
    mime = ct.split(";")[0].strip()
    ext  = MIME_EXT.get(mime, "")

    # Derive filename from Content-Disposition
    cd    = r.headers.get("Content-Disposition", "")
    fname = None
    if cd:
        m = re.search(r"filename\*?=(?:UTF-8'')?[\"']?([^\"';\r\n]+)", cd, re.I)
        if m:
            fname = unquote(m.group(1).strip().strip('"\''))
    if not fname:
        fname = file_id

    # Ensure correct extension
    if ext and not fname.lower().endswith(ext):
        fname += ext

    return dl_url, fname, ext

def download_gdoc_export(uid, file_id, gdoc_type, cookies, out_path):
    """
    Stream-download a Google Workspace file as Office format.
    Uses a cookie session to follow all Google auth redirects properly.
    Returns size_mb.
    """
    fmt_map  = {"docx": "docx", "xlsx": "xlsx", "pptx": "pptx", "pdf": "pdf"}
    type_map = {"docx": "document", "xlsx": "spreadsheets",
                "pptx": "presentation", "pdf": "document"}
    fmt      = fmt_map.get(gdoc_type, "pdf")
    doc_type = type_map.get(gdoc_type, "document")
    export_url = (f"https://docs.google.com/{doc_type}/d/{file_id}"
                  f"/export?format={fmt}")

    session = http.Session()
    session.headers.update({
        "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0.0.0 Safari/537.36")
    })
    for k, v in cookies.items():
        session.cookies.set(k, v)

    _set_status(uid, f"Exporting as .{fmt}…", 5)
    r = session.get(export_url, stream=True, allow_redirects=True, timeout=120)

    # Guard: if Google returned HTML (error / login page) raise clearly
    ct = r.headers.get("Content-Type", "")
    if "text/html" in ct:
        body = r.text[:300]
        raise RuntimeError(
            "Google returned an error page. Make sure your cookies are fresh "
            f"and you have access to this file. Detail: {body[:120]}"
        )

    total = int(r.headers.get("content-length", 0))
    received = 0
    with open(out_path, "wb") as f:
        for chunk in r.iter_content(65536):
            if chunk:
                f.write(chunk)
                received += len(chunk)
                if total:
                    pct = received / total * 100
                    _set_status(uid, f"Downloading… {pct:.1f}%", pct)

    cookies.update(session.cookies.get_dict())
    return received / 1048576

def _dl_chunk(url, cookies, start, end, pnum, tmpdir):
    try:
        r = http.get(url, headers={"Range": f"bytes={start}-{end}"},
                     cookies=cookies, stream=True, timeout=60)
        if r.status_code in (200, 206):
            path = os.path.join(tmpdir, f"part_{pnum:04d}.tmp")
            with open(path, "wb") as f:
                for chunk in r.iter_content(8192):
                    if chunk:
                        f.write(chunk)
            return pnum, path
    except Exception:
        pass
    return pnum, None

def download_file(uid, dl_url, cookies, out_path, threads=8, chunk_mb=6):
    """Multi-threaded chunked downloader. Falls back to streaming for small files."""
    head = http.head(dl_url, cookies=cookies, allow_redirects=True, timeout=30)
    size = int(head.headers.get("content-length", 0))

    if not size:
        # Streaming fallback (no content-length header)
        _set_status(uid, "Downloading…", 5)
        with http.get(dl_url, cookies=cookies, stream=True, timeout=120) as r:
            with open(out_path, "wb") as f:
                for chunk in r.iter_content(65536):
                    if chunk:
                        f.write(chunk)
        return os.path.getsize(out_path) / 1048576

    _set_status(uid, f"Size: {size/1048576:.1f} MB — downloading…", 0)
    chunk  = chunk_mb * 1048576
    ranges = [(i, min(i + chunk - 1, size - 1), idx)
              for idx, i in enumerate(range(0, size, chunk))]
    tmpdir = out_path + ".parts"
    os.makedirs(tmpdir, exist_ok=True)
    done, received = {}, 0
    with ThreadPoolExecutor(max_workers=threads) as ex:
        futs = {ex.submit(_dl_chunk, dl_url, cookies, s, e, pn, tmpdir): pn
                for s, e, pn in ranges}
        for f in as_completed(futs):
            pn, path = f.result()
            if path:
                done[pn] = path
                received += os.path.getsize(path)
                pct = received / size * 100
                _set_status(uid, f"Downloading… {pct:.1f}%  "
                    f"({received/1048576:.1f} / {size/1048576:.1f} MB)", pct)
    _set_status(uid, "Merging…", 99)
    with open(out_path, "wb") as out:
        for pn in sorted(done):
            with open(done[pn], "rb") as f:
                out.write(f.read())
            os.remove(done[pn])
    os.rmdir(tmpdir)
    return size / 1048576

def _worker(uid, queue):
    total = len(queue)
    for idx, item in enumerate(queue):
        file_id  = item["id"]
        orig_url = item.get("url", "")
        _set_status(uid, f"[{idx+1}/{total}] Fetching info…", 0)
        try:
            with app.app_context():
                user = User.query.get(uid)
                if not user or not user.can_download():
                    _set_status(uid, "Download limit reached. Upgrade to Pro.")
                    break
                cookies = dict(user.cookies)

                gdoc_type = detect_gdoc_type(orig_url)
                tmpdir = Path("/tmp/driveload") / str(uid)
                tmpdir.mkdir(parents=True, exist_ok=True)

                # 1. Google Workspace files — stream export directly
                if gdoc_type:
                    fmt_map  = {"docx":"docx","xlsx":"xlsx","pptx":"pptx","pdf":"pdf"}
                    fmt      = fmt_map.get(gdoc_type, "pdf")
                    filename = re.sub(r'[\\/*?:"<>|]', "_", file_id) + f".{fmt}"
                    out      = str(tmpdir / filename)
                    _set_status(uid, f"[{idx+1}/{total}] Exporting {filename}…", 0)
                    size_mb  = download_gdoc_export(uid, file_id, gdoc_type, cookies, out)

                else:
                    dl_url = filename = None

                    # 2. Try video streaming API
                    video_url, title = get_video_info(file_id, cookies)
                    if video_url:
                        dl_url   = video_url
                        filename = (title or file_id).replace("+", " ")
                        if not filename.lower().endswith(".mp4"):
                            filename += ".mp4"

                    # 3. General direct download (PDF, images, etc.)
                    if not dl_url:
                        dl_url, filename, _ = get_direct_download(file_id, cookies)

                    if not dl_url:
                        _set_status(uid, f"[{idx+1}/{total}] Could not get download URL — skipped")
                        continue

                    filename = re.sub(r'[\\/*?:"<>|]', "_", filename or file_id)
                    out      = str(tmpdir / filename)
                    _set_status(uid, f"[{idx+1}/{total}] {filename}", 0)
                    size_mb  = download_file(uid, dl_url, cookies, out)

                dl = Download(user_id=uid, filename=filename,
                              video_id=file_id, size_mb=round(size_mb, 1))
                db.session.add(dl)
                user.increment_downloads()
                db.session.commit()

                st = _get_state(uid)
                st.setdefault("ready_files", []).append({"filename": filename, "path": out})
                _set_status(uid, f"[{idx+1}/{total}] Done: {filename}", 100)
        except Exception as e:
            _set_status(uid, f"[{idx+1}/{total}] Error: {e}")
    st = _get_state(uid)
    st["busy"] = False
    _broadcast(uid, {"status": f"All {total} download(s) complete!",
                     "progress": 100, "done": True})


# ── public routes ─────────────────────────────────────────────────────────────
@app.route("/")
def landing():
    return render_template("landing.html")

@app.route("/pricing")
def pricing():
    return render_template("pricing.html")


OWNER_EMAIL = "pediatricahmed@gmail.com"

def _apply_owner_grants(user):
    """Always give the owner admin + pro, no matter what."""
    if user.email == OWNER_EMAIL:
        if not user.is_admin or user.plan != "pro":
            user.is_admin = True
            user.plan     = "pro"
            db.session.commit()

# ── auth: email/password ──────────────────────────────────────────────────────
@app.route("/register", methods=["GET", "POST"])
def register():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))
    if request.method == "POST":
        name  = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip().lower()
        pw    = request.form.get("password", "")
        if not name or not email or not pw:
            flash("All fields are required.", "error")
        elif len(pw) < 6:
            flash("Password must be at least 6 characters.", "error")
        elif User.query.filter_by(email=email).first():
            flash("Email already registered.", "error")
        else:
            u = User(name=name, email=email)
            u.set_password(pw)
            db.session.add(u)
            db.session.commit()
            login_user(u)
            flash(f"Welcome, {name}!", "success")
            return redirect(url_for("dashboard"))
    return render_template("register.html")

@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        pw    = request.form.get("password", "")
        u     = User.query.filter_by(email=email).first()
        if u and u.check_password(pw):
            _apply_owner_grants(u)
            login_user(u, remember=request.form.get("remember") == "on")
            return redirect(request.args.get("next") or url_for("dashboard"))
        flash("Invalid email or password.", "error")
    return render_template("login.html")

@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("landing"))


# ── auth: Google OAuth ────────────────────────────────────────────────────────
@app.route("/auth/google")
def auth_google():
    if not os.getenv("GOOGLE_CLIENT_ID"):
        flash("Google login is not configured yet.", "error")
        return redirect(url_for("login"))
    redirect_uri = url_for("auth_google_callback", _external=True)
    return google_oauth.authorize_redirect(redirect_uri)

@app.route("/auth/google/callback")
def auth_google_callback():
    try:
        token     = google_oauth.authorize_access_token()
        user_info = token.get("userinfo")
        email     = user_info["email"].lower()
        name      = user_info.get("name", email.split("@")[0])
        google_id = user_info["sub"]

        # find existing user by google_id or email
        user = (User.query.filter_by(google_id=google_id).first() or
                User.query.filter_by(email=email).first())

        if user:
            if not user.google_id:
                user.google_id = google_id
                db.session.commit()
        else:
            user = User(name=name, email=email, google_id=google_id)
            db.session.add(user)
            db.session.commit()

        _apply_owner_grants(user)
        login_user(user)
        flash(f"Welcome, {user.name}!", "success")
        return redirect(url_for("dashboard"))
    except Exception as e:
        flash(f"Google login failed: {e}", "error")
        return redirect(url_for("login"))


# ── dashboard routes ──────────────────────────────────────────────────────────
@app.route("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html", history=current_user.downloads[:10])

@app.route("/api/cookies/save", methods=["POST"])
@login_required
def api_cookies_save():
    raw = request.json.get("cookies", "")
    try:
        data = json.loads(raw)
        cookies = ({item["name"]: item["value"] for item in data
                    if "name" in item} if isinstance(data, list) else data)
    except Exception as e:
        return jsonify(ok=False, message=f"Parse error: {e}"), 400
    if not cookies:
        return jsonify(ok=False, message="No cookies found"), 400
    current_user.cookies = cookies
    db.session.commit()
    return jsonify(ok=True, message=f"{len(cookies)} cookies saved")

@app.route("/api/cookies/clear", methods=["POST"])
@login_required
def api_cookies_clear():
    current_user.cookies = {}
    db.session.commit()
    return jsonify(ok=True, message="Cookies cleared")

@app.route("/api/cookies/status")
@login_required
def api_cookies_status():
    n = len(current_user.cookies)
    return jsonify(ok=bool(n), count=n,
                   message=f"{n} cookies saved" if n else "No cookies saved")

@app.route("/api/queue/add", methods=["POST"])
@login_required
def api_queue_add():
    url = request.json.get("url", "").strip()
    if not url:
        return jsonify(ok=False, message="Empty URL"), 400
    item = {"url": url, "id": extract_video_id(url)}
    q    = _get_session_queue()
    q.append(item)
    _set_session_queue(q)
    return jsonify(ok=True, item=item, queue=q)

@app.route("/api/queue/remove", methods=["POST"])
@login_required
def api_queue_remove():
    idx = request.json.get("index")
    q   = _get_session_queue()
    if idx is None or not (0 <= idx < len(q)):
        return jsonify(ok=False, message="Invalid index"), 400
    q.pop(idx)
    _set_session_queue(q)
    return jsonify(ok=True, queue=q)

@app.route("/api/queue/clear", methods=["POST"])
@login_required
def api_queue_clear():
    _set_session_queue([])
    return jsonify(ok=True)

@app.route("/api/queue")
@login_required
def api_queue():
    return jsonify(queue=_get_session_queue())

@app.route("/api/download/start", methods=["POST"])
@login_required
def api_download_start():
    uid = current_user.id
    st  = _get_state(uid)
    if st["busy"]:
        return jsonify(ok=False, message="Already downloading"), 400
    if not current_user.cookies:
        return jsonify(ok=False, message="No cookies saved — paste your cookies first"), 400
    q = _get_session_queue()
    if not q:
        return jsonify(ok=False, message="Queue is empty"), 400
    if not current_user.can_download():
        return jsonify(ok=False,
            message=f"You've used all {FREE_LIMIT} free downloads. Upgrade to Pro for unlimited."), 403
    st["busy"] = True
    threading.Thread(target=_worker, args=(uid, list(q)), daemon=True).start()
    _set_session_queue([])
    return jsonify(ok=True)

@app.route("/api/events")
@login_required
def api_events():
    uid = current_user.id
    st  = _get_state(uid)
    cq  = q_mod.Queue()
    st["clients"].append(cq)
    cq.put_nowait(f"data: {json.dumps({'status': st['status'], 'progress': st['progress']})}\n\n")

    @stream_with_context
    def generate():
        try:
            while True:
                try:
                    yield cq.get(timeout=25)
                except q_mod.Empty:
                    yield ": ping\n\n"
        finally:
            if cq in st["clients"]:
                st["clients"].remove(cq)

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.route("/api/download/file")
@login_required
def api_download_file():
    """Stream a completed file to the user's browser then delete it."""
    uid = current_user.id
    st  = _get_state(uid)
    files = st.get("ready_files", [])
    if not files:
        return jsonify(ok=False, message="No file ready"), 404
    item = files.pop(0)
    path = item["path"]
    name = item["filename"]
    if not os.path.exists(path):
        return jsonify(ok=False, message="File not found"), 404
    return send_file(path, as_attachment=True, download_name=name,
                     mimetype="video/mp4")

def _get_session_queue():
    from flask import session
    return session.get("queue", [])

def _set_session_queue(q):
    from flask import session
    session["queue"] = q
    session.modified = True


# ── Chrome Extension API (v1) ─────────────────────────────────────────────────
@app.route("/api/v1/download", methods=["POST"])
def api_v1_download():
    """Called by the Chrome extension."""
    api_key = (request.headers.get("X-API-Key") or
               request.json.get("api_key", ""))
    user = User.query.filter_by(api_key=api_key).first()
    if not user:
        return jsonify(ok=False, message="Invalid API key"), 401

    url     = request.json.get("url", "").strip()
    cookies = request.json.get("cookies", {})

    if not url:
        return jsonify(ok=False, message="URL required"), 400
    if not user.can_download():
        return jsonify(ok=False,
            message=f"Free limit reached ({FREE_LIMIT} downloads). Upgrade to Pro."), 403

    # save cookies if provided by extension
    # Normalize: extension sends [{name,value,...}], app needs {name: value}
    if cookies:
        if isinstance(cookies, list):
            cookies = {c["name"]: c["value"] for c in cookies if "name" in c and "value" in c}
        user.cookies = cookies
        db.session.commit()

    st = _get_state(user.id)
    if st["busy"]:
        return jsonify(ok=False, message="Already downloading"), 400

    item = {"url": url, "id": extract_video_id(url)}
    st["busy"] = True
    threading.Thread(target=_worker, args=(user.id, [item]), daemon=True).start()
    return jsonify(ok=True, message="Download started")

@app.route("/api/v1/status", methods=["GET", "POST"])
def api_v1_status():
    """Poll download status — used by Chrome extension."""
    api_key = (request.headers.get("X-API-Key") or
               (request.json or {}).get("api_key", "") or
               request.args.get("api_key", ""))
    user = User.query.filter_by(api_key=api_key).first()
    if not user:
        return jsonify(ok=False, message="Invalid API key"), 401
    st = _get_state(user.id)
    return jsonify(ok=True, busy=st["busy"],
                   status=st["status"], progress=st["progress"],
                   plan=user.plan,
                   downloads_used=user.total_downloads)


# ── account ───────────────────────────────────────────────────────────────────
@app.route("/account")
@login_required
def account():
    api_key = current_user.get_or_create_api_key()
    return render_template("account.html", api_key=api_key)

@app.route("/account/update", methods=["POST"])
@login_required
def account_update():
    name = request.form.get("name", "").strip()
    if name:
        current_user.name = name
        db.session.commit()
        flash("Name updated.", "success")
    pw     = request.form.get("new_password", "")
    cur_pw = request.form.get("current_password", "")
    if pw:
        if not current_user.check_password(cur_pw):
            flash("Current password is incorrect.", "error")
        elif len(pw) < 6:
            flash("New password must be at least 6 characters.", "error")
        else:
            current_user.set_password(pw)
            db.session.commit()
            flash("Password updated.", "success")
    return redirect(url_for("account"))

@app.route("/account/regenerate-key", methods=["POST"])
@login_required
def regenerate_api_key():
    current_user.api_key = secrets.token_urlsafe(32)
    db.session.commit()
    flash("API key regenerated.", "success")
    return redirect(url_for("account"))


# ── admin ────────────────────────────────────────────────────────────────────
def admin_required(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated or not current_user.is_admin:
            return redirect(url_for("dashboard"))
        return f(*args, **kwargs)
    return decorated

@app.route("/admin")
@login_required
@admin_required
def admin_panel():
    users = User.query.order_by(User.created_at.desc()).all()
    return render_template("admin.html", users=users)

@app.route("/admin/user/<int:uid>/plan", methods=["POST"])
@login_required
@admin_required
def admin_set_plan(uid):
    u = User.query.get_or_404(uid)
    u.plan = request.form.get("plan", "free")
    db.session.commit()
    return redirect(url_for("admin_panel"))

@app.route("/admin/user/<int:uid>/reset-downloads", methods=["POST"])
@login_required
@admin_required
def admin_reset_downloads(uid):
    u = User.query.get_or_404(uid)
    u.total_downloads = 0
    db.session.commit()
    return redirect(url_for("admin_panel"))

@app.route("/admin/user/<int:uid>/delete", methods=["POST"])
@login_required
@admin_required
def admin_delete_user(uid):
    u = User.query.get_or_404(uid)
    if u.email == "pediatricahmed@gmail.com":
        return redirect(url_for("admin_panel"))  # can't delete owner
    db.session.delete(u)
    db.session.commit()
    return redirect(url_for("admin_panel"))

# ── billing ───────────────────────────────────────────────────────────────────
@app.route("/billing/checkout", methods=["POST"])
@login_required
def billing_checkout():
    if not stripe.api_key or not STRIPE_PRICE_ID:
        flash("Stripe is not configured yet.", "error")
        return redirect(url_for("pricing"))
    try:
        if not current_user.stripe_customer_id:
            customer = stripe.Customer.create(
                email=current_user.email, name=current_user.name)
            current_user.stripe_customer_id = customer.id
            db.session.commit()
        session_obj = stripe.checkout.Session.create(
            customer=current_user.stripe_customer_id,
            payment_method_types=["card"],
            line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
            mode="subscription",
            success_url=APP_URL + "/billing/success",
            cancel_url=APP_URL + "/pricing",
        )
        return redirect(session_obj.url)
    except Exception as e:
        flash(f"Stripe error: {e}", "error")
        return redirect(url_for("pricing"))

@app.route("/billing/success")
@login_required
def billing_success():
    flash("Subscription activated! Enjoy unlimited downloads.", "success")
    return redirect(url_for("dashboard"))

@app.route("/billing/portal", methods=["POST"])
@login_required
def billing_portal():
    if not current_user.stripe_customer_id:
        flash("No active subscription found.", "error")
        return redirect(url_for("dashboard"))
    try:
        portal = stripe.billing_portal.Session.create(
            customer=current_user.stripe_customer_id,
            return_url=APP_URL + "/dashboard")
        return redirect(portal.url)
    except Exception as e:
        flash(f"Error: {e}", "error")
        return redirect(url_for("dashboard"))

@app.route("/billing/webhook", methods=["POST"])
def billing_webhook():
    payload = request.get_data()
    sig     = request.headers.get("Stripe-Signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except Exception:
        return "Bad signature", 400
    if event["type"] == "checkout.session.completed":
        obj  = event["data"]["object"]
        u    = User.query.filter_by(stripe_customer_id=obj.get("customer")).first()
        if u:
            u.plan = "pro"
            u.stripe_subscription_id = obj.get("subscription")
            db.session.commit()
    elif event["type"] in ("customer.subscription.deleted",
                           "customer.subscription.updated"):
        sub = event["data"]["object"]
        u   = User.query.filter_by(stripe_customer_id=sub.get("customer")).first()
        if u:
            u.plan = "pro" if sub.get("status") in ("active", "trialing") else "free"
            db.session.commit()
    return "ok", 200


# ── init ──────────────────────────────────────────────────────────────────────
with app.app_context():
    db.create_all()
    # Auto-migrate: add new columns if they don't exist yet
    from sqlalchemy import text, inspect as sa_inspect
    inspector = sa_inspect(db.engine)
    existing = [c["name"] for c in inspector.get_columns("user")]
    with db.engine.connect() as conn:
        if "google_id" not in existing:
            conn.execute(text("ALTER TABLE user ADD COLUMN google_id VARCHAR(120)"))
        if "api_key" not in existing:
            conn.execute(text("ALTER TABLE user ADD COLUMN api_key VARCHAR(64)"))
        if "total_downloads" not in existing:
            conn.execute(text("ALTER TABLE user ADD COLUMN total_downloads INTEGER DEFAULT 0"))
        # SQLite: recreate table with all columns (allows NULL password_hash, adds is_admin)
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS user_new (
                id INTEGER PRIMARY KEY,
                name VARCHAR(120) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255),
                google_id VARCHAR(120) UNIQUE,
                api_key VARCHAR(64) UNIQUE,
                plan VARCHAR(20) DEFAULT 'free',
                stripe_customer_id VARCHAR(120),
                stripe_subscription_id VARCHAR(120),
                cookies_json TEXT DEFAULT '{}',
                total_downloads INTEGER DEFAULT 0,
                is_admin BOOLEAN DEFAULT 0,
                created_at DATETIME
            )
        """))
        # Copy existing data; is_admin defaults to 0
        conn.execute(text("""
            INSERT OR IGNORE INTO user_new
            SELECT id, name, email, password_hash, google_id, api_key, plan,
                   stripe_customer_id, stripe_subscription_id, cookies_json,
                   total_downloads, 0, created_at FROM user
        """))
        conn.execute(text("DROP TABLE user"))
        conn.execute(text("ALTER TABLE user_new RENAME TO user"))
        conn.commit()
    # Always ensure the owner account has admin + pro
    owner = User.query.filter_by(email="pediatricahmed@gmail.com").first()
    if owner:
        owner.is_admin = True
        owner.plan     = "pro"
        db.session.commit()

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    app.run(debug=False, host="0.0.0.0", port=port, threaded=True)
