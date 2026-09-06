// ============================================================================================================
// Kitchen Mama Operation System — SHARED API TRANSPORT (F1-7N-FB-4E)
// ------------------------------------------------------------------------------------------------------------
// ONE endpoint authority. ONE request state machine. ONE classifier. ONE retry policy. ONE timing record.
//
// WHY THIS FILE EXISTS. Six pages — Site Inventory, Order Planning, Factory Inventory, Overseas Inventory,
// FC Summary and Shipment Draft — failed in one browser session with HTTP 404 / text-html answers, empty
// selectors and "尚未連接資料來源". That is not six business defects; those pages share a transport, and the
// transport could not say WHICH URL answered, WHO answered it, or WHETHER the answer belonged to the request.
// Specifically, before this file existed:
//
//   · ~59 call sites each wrote their own `fetch(OP_DB_API_BASE_URL, {...})`, their own parse and their own
//     error mapping, so a fix had 59 places to miss;
//   · the endpoint check accepted ANY https URL — a `/dev` URL, an Apps Script editor URL, an expired
//     `script.googleusercontent.com` echo URL and the site's own GitHub Pages origin all passed and were
//     fetched, and only the network could say no;
//   · on `!resp.ok` the runners returned `'API HTTP ' + status` and DISCARDED `resp.url`, `resp.redirected`,
//     the content type and the body — deleting the only evidence that could tell a GitHub Pages 404 from an
//     Apps Script deployment 404 from a Google login page from an expired redirect target;
//   · a POST answered by `doGet` was decided by REGEX-MATCHING THE ROUTER'S PROSE, ignoring the typed fields
//     (`code` / `received_method` / `sent_as_post`) the router already sends for exactly this purpose.
//
// WHAT THIS FILE IS NOT. It holds no business rule, no table name, no sheet index, no domain field vocabulary
// and no page DOM. It never decides what a row means. It answers exactly one question — "what happened to this
// request?" — and answers it with a code, a phase, a masked identity and a duration.
//
// DETERMINISM. `now`, `random` and `sleep` are injected (defaulting to the real ones) so every timing,
// jitter and backoff assertion in the suite is exact rather than approximate. No wall-clock is read for a
// decision; time is recorded, never branched on.
//
// SAFETY. It never logs or returns a credential, a token, a full private URL, a Script ID, a query value or a
// row. HTML bodies are reduced to a FINGERPRINT — a set of booleans and a bounded, tag-stripped token list —
// and the raw body is never exposed to a page or to a completion report.
// ============================================================================================================
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root) { root.KM = root.KM || {}; root.KM.transport = root.KM.transport || api.create(); root.KM.transportFactory = api; }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // ==========================================================================================================
  // CONTRACT VERSION (§H)
  // ----------------------------------------------------------------------------------------------------------
  // The FRONTEND transport contract. It is a separate axis from the deployed ACTION contract: a stale frontend,
  // a stale Apps Script deployment, a partial sync and a wrong endpoint are four different faults and must
  // produce four different reason codes. `missing_actions=[]` cannot see any of them.
  // ==========================================================================================================
  var TRANSPORT_CONTRACT_VERSION = 1;
  var TRANSPORT_BUILD = 'F1-7N-FB-4E-R4A1';

  // ==========================================================================================================
  // THE STATE MACHINE (§C). Every request walks these in order and stops at SUCCESS or TYPED_FAILURE.
  // The phase is reported on failure, which is what turns "it broke" into "it broke BEFORE the network".
  // ==========================================================================================================
  var PHASE = {
    BUILD: 'BUILD',
    DISPATCH: 'DISPATCH',
    REDIRECT_RESPONSE: 'REDIRECT_RESPONSE',
    PARSE: 'PARSE',
    CONTRACT_VALIDATE: 'CONTRACT_VALIDATE',
    SUCCESS: 'SUCCESS',
    TYPED_FAILURE: 'TYPED_FAILURE'
  };
  var PHASE_ORDER = [PHASE.BUILD, PHASE.DISPATCH, PHASE.REDIRECT_RESPONSE, PHASE.PARSE, PHASE.CONTRACT_VALIDATE];

  // The typed failure vocabulary. Every one of these is a DIFFERENT fix, which is the whole reason they are
  // separate codes rather than one "read failed".
  var CODES = {
    API_ENDPOINT_CONFIGURATION_INVALID: 'API_ENDPOINT_CONFIGURATION_INVALID',
    HTTP_NOT_FOUND_HTML: 'HTTP_NOT_FOUND_HTML',
    AUTH_OR_ACCESS_HTML: 'AUTH_OR_ACCESS_HTML',
    TRANSPORT_NON_JSON_RESPONSE: 'TRANSPORT_NON_JSON_RESPONSE',
    HTTP_TRANSPORT_ERROR: 'HTTP_TRANSPORT_ERROR',
    // F1-7N-FB-4E-R4A1 — A REDIRECT TARGET THAT 404s IS NOT A BUSINESS 404, AND THE DIFFERENCE IS ACTIONABLE.
    //
    // Apps Script answers every /exec request with a 302 to script.googleusercontent.com/macros/echo. When THAT
    // target cannot be read the answer is a 404 page — and the live evidence showed a DIFFERENT user_content_key
    // on each attempt, so it is not a stale cached URL being reused. It says nothing about whether the
    // deployment exists, which is precisely what a deployment 404 (script.google.com) or a frontend-origin 404
    // does say. Same status code, opposite meanings, opposite fixes: this one is worth ONE fresh attempt from
    // the stable /exec; the others are not worth any, and are still HTTP_NOT_FOUND_HTML.
    REDIRECT_TARGET_NOT_FOUND: 'REDIRECT_TARGET_NOT_FOUND',
    REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
    REQUEST_TIMEOUT_WRITE_INDETERMINATE: 'REQUEST_TIMEOUT_WRITE_INDETERMINATE',
    REQUEST_ABORTED: 'REQUEST_ABORTED',
    DEPLOYMENT_CONTRACT_MISMATCH: 'DEPLOYMENT_CONTRACT_MISMATCH',
    RESPONSE_ACTION_MISMATCH: 'RESPONSE_ACTION_MISMATCH',
    RESPONSE_REQUEST_ID_MISMATCH: 'RESPONSE_REQUEST_ID_MISMATCH',
    RESPONSE_CORRELATION_UNPROVEN: 'RESPONSE_CORRELATION_UNPROVEN',
    REQUEST_METHOD_DOWNGRADED: 'REQUEST_METHOD_DOWNGRADED',
    BACKEND_BUSINESS_REJECTION: 'BACKEND_BUSINESS_REJECTION'
  };

  // The seven mutually exclusive UI states (§F). Exported so a page cannot invent an eighth, and so
  // "transport failed" can never be spelled the same way as "there is no data source".
  var UI_STATE = {
    LOADING: 'LOADING',
    READY_WITH_DATA: 'READY_WITH_DATA',
    READY_EMPTY: 'READY_EMPTY',
    EMPTY_CONFIGURATION: 'EMPTY_CONFIGURATION',
    TRANSIENT_ERROR: 'TRANSIENT_ERROR',
    NON_RETRYABLE_CONFIGURATION_OR_DEPLOYMENT_ERROR: 'NON_RETRYABLE_CONFIGURATION_OR_DEPLOYMENT_ERROR',
    ABORTED_SUPERSEDED: 'ABORTED_SUPERSEDED'
  };

  function str(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  // ==========================================================================================================
  // §B — THE ENDPOINT AUTHORITY.
  // ----------------------------------------------------------------------------------------------------------
  // The rule is not "prefer /exec". The rule is: anything that is not the stable Web App /exec URL is REFUSED
  // LOCALLY, BEFORE the network, with API_ENDPOINT_CONFIGURATION_INVALID and a named reason. The previous check
  // accepted any https string, so the four URLs that actually cause this incident class — a `/dev` test URL, an
  // editor URL, a consumed `script.googleusercontent.com` echo target, and the site's own origin — were all
  // dispatched and then diagnosed from a 404 HTML page. A URL fault is knowable without asking the network.
  //
  // A REDIRECT RESPONSE URL IS NEVER PROMOTED. `classify()` rejects the googleusercontent host outright, so
  // even if some future code path captured `resp.url` and fed it back as configuration, it could not become the
  // base URL. That is §B2 enforced by the type of the value rather than by remembering not to do it.
  // ==========================================================================================================
  var ENDPOINT_CLASS = {
    STABLE_EXEC: 'STABLE_EXEC',                       // the one legal production value
    BLANK: 'BLANK',
    RELATIVE: 'RELATIVE',
    NOT_HTTPS: 'NOT_HTTPS',
    FRONTEND_ORIGIN: 'FRONTEND_ORIGIN',
    APPS_SCRIPT_DEV: 'APPS_SCRIPT_DEV',               // /dev — bound to the editor session, never production
    APPS_SCRIPT_EDITOR: 'APPS_SCRIPT_EDITOR',         // /edit, /home/projects, script.new …
    USERCONTENT_REDIRECT: 'USERCONTENT_REDIRECT',     // a consumed/expired echo target
    MALFORMED_EXEC: 'MALFORMED_EXEC',                 // script.google.com but not /macros/s/<id>/exec
    PLACEHOLDER: 'PLACEHOLDER',                       // PASTE_WEB_APP_EXEC_URL_HERE and friends
    FOREIGN_HOST: 'FOREIGN_HOST',
    LOCAL_DEV: 'LOCAL_DEV'                            // http://localhost — legal ONLY on a local dev host
  };
  var EXEC_RE = /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[A-Za-z0-9_-]{20,}\/exec(\?|$)/;

  // Only the ORIGIN plus a fixed shape is ever recorded (§A/§B7). The Script ID is the credential-equivalent
  // part of this URL and never appears in a diagnostic, a log line, a page message or a report.
  function maskEndpoint(u) {
    var s = str(u);
    if (s === '') return '';
    var m = s.match(/^(https?:\/\/[^/?#]+)/);
    var origin = m ? m[1] : '(unparseable)';
    // The PATH SHAPE is kept (it is the diagnostic half) and the deployment id is dropped (it is the secret
    // half), so a masked identity still tells /exec apart from /dev and from an editor URL.
    if (/script\.google\.com$/i.test(origin.replace(/^https?:\/\//, ''))) {
      if (/\/macros\/s\/[^/]+\/exec/.test(s)) return origin + '/macros/s/<redacted>/exec';
      if (/\/macros\/s\/[^/]+\/dev/.test(s)) return origin + '/macros/s/<redacted>/dev';
      return origin + '/<non-webapp-path>';
    }
    if (/script\.googleusercontent\.com$/i.test(origin.replace(/^https?:\/\//, ''))) return origin + '/macros/echo?<redacted>';
    return origin + '/…';
  }

  function classifyEndpoint(url, opts) {
    opts = opts || {};
    var s = str(url);
    var frontendOrigin = str(opts.frontendOrigin);
    var out = function (cls, reason) {
      return { ok: cls === ENDPOINT_CLASS.STABLE_EXEC || cls === ENDPOINT_CLASS.LOCAL_DEV,
        endpointClass: cls, reason: reason, url: s, maskedEndpoint: maskEndpoint(s) };
    };
    if (s === '') return out(ENDPOINT_CLASS.BLANK, 'No API endpoint is configured.');
    if (/^PASTE_|_HERE$|^TODO/i.test(s)) return out(ENDPOINT_CLASS.PLACEHOLDER, 'The API endpoint is still the placeholder value.');
    if (!/^https?:\/\//i.test(s)) return out(ENDPOINT_CLASS.RELATIVE, 'The API endpoint is relative, so it would resolve against the website origin.');
    var host = (s.match(/^https?:\/\/([^/?#]+)/) || [])[1] || '';
    var isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
    if (isLocalHost) return out(ENDPOINT_CLASS.LOCAL_DEV, '');
    if (/^http:\/\//i.test(s)) return out(ENDPOINT_CLASS.NOT_HTTPS, 'The API endpoint is not https.');
    if (/script\.googleusercontent\.com$/i.test(host)) {
      return out(ENDPOINT_CLASS.USERCONTENT_REDIRECT,
        'This is an Apps Script REDIRECT TARGET, not the Web App endpoint. It is single-use and expires, so it can never be used as configuration.');
    }
    if (frontendOrigin && s.indexOf(frontendOrigin) === 0) {
      return out(ENDPOINT_CLASS.FRONTEND_ORIGIN, 'The API endpoint points back at the website itself, so the site would answer its own API request with a page.');
    }
    if (/script\.google\.com$/i.test(host)) {
      if (/\/macros\/s\/[A-Za-z0-9_-]+\/dev(\?|$|\/)/.test(s)) {
        return out(ENDPOINT_CLASS.APPS_SCRIPT_DEV, 'This is the /dev URL. It serves the editor session, requires the editor owner to be signed in, and is never the published Web App.');
      }
      if (/\/(edit|home\/projects|d\/|new)/.test(s) || /\/macros\/d\//.test(s)) {
        return out(ENDPOINT_CLASS.APPS_SCRIPT_EDITOR, 'This is an Apps Script EDITOR URL, not a Web App endpoint.');
      }
      if (!EXEC_RE.test(s)) {
        return out(ENDPOINT_CLASS.MALFORMED_EXEC, 'This is a script.google.com URL but not a stable /macros/s/<deployment>/exec Web App URL.');
      }
      return out(ENDPOINT_CLASS.STABLE_EXEC, '');
    }
    return out(ENDPOINT_CLASS.FOREIGN_HOST, 'The API endpoint is not an Apps Script Web App host.');
  }

  // ==========================================================================================================
  // §A — THE HTML FINGERPRINT. "It returned a web page" is not a diagnosis; there are five different web pages
  // and five different fixes. This distinguishes them from evidence the browser genuinely has: the final URL's
  // host/path shape, the status, the content type and a bounded set of markers in the body.
  //
  // The raw body NEVER leaves this function. What comes out is booleans plus at most 6 short tokens, which is
  // enough to name the source and not enough to leak a signed URL, an account name or a row.
  // ==========================================================================================================
  var HTML_SOURCE = {
    GITHUB_PAGES_404: 'GITHUB_PAGES_404',
    APPS_SCRIPT_DEPLOYMENT_404: 'APPS_SCRIPT_DEPLOYMENT_404',
    GOOGLE_AUTH_OR_ACCESS: 'GOOGLE_AUTH_OR_ACCESS',
    EXPIRED_USERCONTENT_REDIRECT: 'EXPIRED_USERCONTENT_REDIRECT',
    FRONTEND_ORIGIN_RESPONSE: 'FRONTEND_ORIGIN_RESPONSE',
    GOOGLE_GENERIC_ERROR: 'GOOGLE_GENERIC_ERROR',
    UNKNOWN_HTML: 'UNKNOWN_HTML'
  };
  function hostOf(u) { return (str(u).match(/^https?:\/\/([^/?#]+)/) || [])[1] || ''; }
  function fingerprintHtml(info) {
    info = info || {};
    var body = str(info.body).slice(0, 4096);
    var low = body.toLowerCase();
    var status = (typeof info.status === 'number') ? info.status : null;
    var finalUrl = str(info.finalUrl);
    var fHost = hostOf(finalUrl);
    var reqHost = hostOf(info.requestedUrl);
    var frontendOrigin = str(info.frontendOrigin);
    var markers = {
      googleAccounts: /accounts\.google\.com|signinchooser|servicelogin|please\s+sign\s+in|需要授權|授權存取/i.test(body),
      googleUnauthorized: /you\s+need\s+(permission|access)|unauthorized|request\s+access|沒有存取權/i.test(low),
      appsScriptNotFound: /script\s+function\s+not\s+found|the\s+script\s+completed\s+but|sorry,\s+unable\s+to\s+open/i.test(low),
      githubPages: /github\s*pages|there\s+isn.?t\s+a\s+github\s+pages\s+site|404[^<]{0,40}(file\s+not\s+found|page\s+not\s+found)/i.test(low),
      googleChrome404: /<ins>that.?s\s+all\s+we\s+know|error\s*404\s*\(not\s+found\)/i.test(low)
    };
    var source = HTML_SOURCE.UNKNOWN_HTML;
    if (frontendOrigin && finalUrl && finalUrl.indexOf(frontendOrigin) === 0) source = HTML_SOURCE.FRONTEND_ORIGIN_RESPONSE;
    else if (markers.githubPages) source = HTML_SOURCE.GITHUB_PAGES_404;
    else if (markers.googleAccounts || markers.googleUnauthorized) source = HTML_SOURCE.GOOGLE_AUTH_OR_ACCESS;
    else if (/script\.googleusercontent\.com$/i.test(fHost)) source = HTML_SOURCE.EXPIRED_USERCONTENT_REDIRECT;
    else if (/script\.google\.com$/i.test(fHost)) source = HTML_SOURCE.APPS_SCRIPT_DEPLOYMENT_404;
    else if (markers.appsScriptNotFound) source = HTML_SOURCE.APPS_SCRIPT_DEPLOYMENT_404;
    else if (markers.googleChrome404 && /\.google\.com$/i.test(fHost)) source = HTML_SOURCE.GOOGLE_GENERIC_ERROR;

    // A bounded, tag-stripped, length-capped token list. Enough to recognise a page; never enough to carry a
    // signed URL, an email address or a row value.
    var tokens = body.replace(/<[^>]*>/g, ' ').replace(/[^A-Za-z0-9 .:'-]+/g, ' ')
      .split(/\s+/).filter(function (t) { return t.length >= 4 && t.length <= 24; }).slice(0, 6);
    return {
      source: source,
      httpStatus: status,
      contentType: str(info.contentType) || null,
      maskedFinalEndpoint: maskEndpoint(finalUrl),
      maskedRequestedEndpoint: maskEndpoint(info.requestedUrl),
      finalHostClass: /script\.google\.com$/i.test(fHost) ? 'APPS_SCRIPT'
        : /script\.googleusercontent\.com$/i.test(fHost) ? 'USERCONTENT_ECHO'
        : (frontendOrigin && finalUrl.indexOf(frontendOrigin) === 0) ? 'FRONTEND_ORIGIN'
        : fHost ? 'OTHER' : 'UNKNOWN',
      hostChanged: !!(fHost && reqHost && fHost !== reqHost),
      redirected: info.redirected === true,
      bodyBytes: str(info.body).length,
      markers: markers,
      tokens: tokens
    };
  }

  // Map a fingerprint to the typed transport code. AUTH is its own code because the fix is "sign in / change
  // the deployment's access policy", which no retry can perform.
  function codeForHtml(fp) {
    if (!fp) return CODES.TRANSPORT_NON_JSON_RESPONSE;
    if (fp.source === HTML_SOURCE.GOOGLE_AUTH_OR_ACCESS) return CODES.AUTH_OR_ACCESS_HTML;
    // F1-7N-FB-4E-R4A1 §6 — ordered BEFORE the generic 404 on purpose. The redirect target is the only 404
    // source that is worth asking again about, and it is identified by three facts together, not by the status
    // alone: the request was redirected, it ended on the echo host, and that host answered 404.
    if (fp.httpStatus === 404 && fp.redirected === true && fp.source === HTML_SOURCE.EXPIRED_USERCONTENT_REDIRECT) {
      return CODES.REDIRECT_TARGET_NOT_FOUND;
    }
    if (fp.httpStatus === 404) return CODES.HTTP_NOT_FOUND_HTML;
    if (fp.source === HTML_SOURCE.GITHUB_PAGES_404 || fp.source === HTML_SOURCE.FRONTEND_ORIGIN_RESPONSE) return CODES.HTTP_NOT_FOUND_HTML;
    return CODES.TRANSPORT_NON_JSON_RESPONSE;
  }

  // ==========================================================================================================
  // §C — RETRY POLICY. Stated as data so it is auditable, and so a test asserts the POLICY rather than a path
  // through it. A 404 is deliberately NOT here: its source has to be determined first, and none of the four
  // sources is fixed by asking again.
  // ==========================================================================================================
  var RETRYABLE_STATUS = { 408: 1, 429: 1, 500: 1, 502: 1, 503: 1, 504: 1 };
  var NEVER_AUTO_RETRY_CODES = {};
  [CODES.API_ENDPOINT_CONFIGURATION_INVALID, CODES.HTTP_NOT_FOUND_HTML, CODES.AUTH_OR_ACCESS_HTML,
    CODES.DEPLOYMENT_CONTRACT_MISMATCH, CODES.RESPONSE_ACTION_MISMATCH, CODES.RESPONSE_REQUEST_ID_MISMATCH,
    CODES.RESPONSE_CORRELATION_UNPROVEN, CODES.BACKEND_BUSINESS_REJECTION, CODES.REQUEST_ABORTED,
    CODES.REQUEST_TIMEOUT_WRITE_INDETERMINATE, CODES.TRANSPORT_NON_JSON_RESPONSE
  ].forEach(function (c) { NEVER_AUTO_RETRY_CODES[c] = 1; });

  // A WRITE is never automatically replayed — not on a timeout, not on a lost response, not on a 5xx. The
  // server may have committed after the browser stopped listening, and the existing idempotency keys and
  // reconciliation rules remain the authority on what to do about that.
  function isAutoRetryable(o) {
    o = o || {};
    if (str(o.kind) === 'write') return false;
    var code = str(o.code);
    if (NEVER_AUTO_RETRY_CODES[code]) return false;
    if (code === CODES.REQUEST_TIMEOUT) return false;                 // the bound already elapsed; asking again doubles the wait
    if (code === CODES.HTTP_TRANSPORT_ERROR) {
      var st = (typeof o.httpStatus === 'number') ? o.httpStatus : null;
      if (st === null) return true;                                    // a genuine network failure with no response
      return RETRYABLE_STATUS[st] === 1;
    }
    if (code === CODES.REQUEST_METHOD_DOWNGRADED) return true;         // the deployment is fine; the hop lost the body
    // F1-7N-FB-4E-R4A1 — the deployment is fine; one hop's target could not be read. A fresh attempt from the
    // STABLE /exec gets a new redirect target. Reads only (the guard above), and bounded to one by maxRetries.
    if (code === CODES.REDIRECT_TARGET_NOT_FOUND) return true;
    return false;
  }
  // Bounded exponential delay with jitter. `random` is injected, so the suite asserts the exact number.
  function retryDelayMs(attempt, random, baseMs, capMs) {
    var base = (baseMs > 0) ? baseMs : 400;
    var cap = (capMs > 0) ? capMs : 4000;
    var raw = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
    var r = (typeof random === 'function') ? random() : 0.5;
    return Math.round(raw * (0.5 + (r * 0.5)));                        // 50%–100% of the ceiling
  }

  // ==========================================================================================================
  // THE INSTANCE
  // ==========================================================================================================
  function create(deps) {
    deps = deps || {};
    var _fetch = (typeof deps.fetch === 'function') ? deps.fetch : ((typeof fetch !== 'undefined') ? fetch : null);
    var _now = (typeof deps.now === 'function') ? deps.now
      : function () { return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; };
    var _random = (typeof deps.random === 'function') ? deps.random : function () { return 0.5; };
    var _sleep = (typeof deps.sleep === 'function') ? deps.sleep
      : function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var _readTimeoutMs = (deps.readTimeoutMs > 0) ? deps.readTimeoutMs : 60000;
    var _writeTimeoutMs = (deps.writeTimeoutMs > 0) ? deps.writeTimeoutMs : 300000;

    // ---- endpoint resolution ---------------------------------------------------------------------------
    // §B5 — IMMUTABLE FOR ONE REQUEST, RECOVERABLE ON THE NEXT. The value is read once per request and never
    // re-read mid-flight (so a request cannot change endpoint under itself), and it is NOT memoised across
    // requests (so a bootstrap that had not yet run cannot poison the session). There is no cached rejected
    // promise anywhere in this path, which is why §D2 holds by construction.
    function rawEndpoint() {
      if (typeof deps.baseUrl === 'string') return deps.baseUrl;
      if (typeof deps.getBaseUrl === 'function') { try { return str(deps.getBaseUrl()); } catch (e) { return ''; } }
      if (typeof window !== 'undefined' && window.KM && window.KM.DB && typeof window.KM.DB.getApiBaseUrl === 'function') {
        try { return str(window.KM.DB.getApiBaseUrl()); } catch (e2) { return ''; }
      }
      return '';
    }
    function frontendOrigin() {
      if (typeof deps.frontendOrigin === 'string') return deps.frontendOrigin;
      try { return (typeof window !== 'undefined' && window.location && window.location.origin) ? String(window.location.origin) : ''; }
      catch (e) { return ''; }
    }
    function endpoint() { return classifyEndpoint(rawEndpoint(), { frontendOrigin: frontendOrigin() }); }

    // ---- metrics (§D/§E) -------------------------------------------------------------------------------
    // Counts and durations only. No URL, no action payload, no row. `requests` is the number that makes
    // "exactly one request" a measured fact instead of a claim in a comment.
    // ============================================================================================================
    // F1-7N-FC-1B-E3-R4-A2-R1-R6-R5 §2 — A DURATION IS NOT A TIMELINE.
    //
    // Every sample carried `ms` and no timestamps, so two requests that ran back to back and two that ran on
    // top of each other produced identical records. Every previous round's overlap claim was therefore an
    // INFERENCE FROM DURATIONS, which is exactly what §2 forbids — and it is the inference that matters here,
    // because the live evidence (four requests, three small reads at 5.4-6.7s each, one large read at the 60s
    // bound) reads completely differently depending on whether those four were concurrent or sequential.
    //
    // What is added is the smallest thing that settles it: a monotonic sequence, the dispatch offset from a
    // fixed epoch, the settle offset, and HOW MANY REQUESTS WERE ALREADY OPEN when this one was dispatched.
    // The last is the whole point — peak concurrency is a fact about the boot, not about any one request.
    //
    // `owner` and `reason` are carried when a caller declares them and left null when it does not. An
    // undeclared owner is reported as undeclared: inventing a plausible one would make the attribution
    // unfalsifiable, and attribution is what is in question.
    // ============================================================================================================
    var _epoch = _now();
    var _openRequests = 0;                 // requests dispatched and not yet settled
    var _peakConcurrent = 0;
    var _seq = 0;
    var _metrics = { requests: 0, retries: 0, coalesced: 0, recoveries: 0, byAction: {}, byCode: {}, samples: [], shareSkipped: {} };
    function bump(map, key) { if (!key) return; map[key] = (map[key] || 0) + 1; }
    function record(sample) {
      _metrics.requests += 1;
      bump(_metrics.byAction, sample.action);
      bump(_metrics.byCode, sample.code || 'SUCCESS');
      if (_metrics.samples.length < 400) _metrics.samples.push(sample);      // bounded: never an unbounded log
    }
    // The chronological overlap report §2 asks for. Built from the recorded samples, never from durations.
    function timeline() {
      var rows = _metrics.samples.filter(function (s) { return typeof s.dispatch_ms === 'number'; })
        .map(function (s) {
          return { seq: s.seq, action: s.action, kind: s.kind || 'read', owner: s.owner || null, reason: s.reason || null,
            payload_fingerprint: s.payload_fingerprint || null,
            dispatch_ms: s.dispatch_ms, settled_ms: s.settled_ms, elapsed_ms: s.ms,
            concurrent_at_dispatch: s.concurrent_at_dispatch,
            code: s.code || null, phase: s.phase || null, http_status: s.http_status,
            redirected: s.redirected === true, server_answered: s.server_answered, server_ms: s.server_ms,
            request_id: s.request_id || null, attempts: s.attempts,
            // §5 — OBSERVED or EXTERNAL_RECONSTRUCTED. A row whose interval was reconstructed from a duration
            // must not be read as though it had been timed at dispatch, and the only way to keep that true is
            // to say so on the row itself.
            marks_source: s.marks_source || 'OBSERVED',
            routes_in_payload: (typeof s.routes_in_payload === 'number') ? s.routes_in_payload : null,
            allocation_draft_id: s.allocation_draft_id || null,
            allocation_draft_line_ids: s.allocation_draft_line_ids || null,
            changed_fields: s.changed_fields || null,
            outcome: s.outcome || null };
        })
        .sort(function (a, b) { return a.dispatch_ms - b.dispatch_ms || a.seq - b.seq; });
      // Two requests OVERLAP when each was open while the other was. Computed from the recorded intervals, so
      // it is a measurement and not a guess about what "probably" ran together.
      function overlaps(row) {
        return rows.filter(function (o) {
          return o.seq !== row.seq && o.dispatch_ms < row.settled_ms && row.dispatch_ms < o.settled_ms;
        }).map(function (o) { return o.action; });
      }
      var withOverlap = rows.map(function (r) {
        var o = {};
        for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) o[k] = r[k];
        o.overlapped_with = overlaps(r);
        return o;
      });
      return {
        epoch_offset_ms: 0,
        request_timeline: withOverlap,
        // §5 — the mutations, alone. `timeline()` answered 'what did the page request?' and was read as
        // 'what did the page WRITE?'. Those are the same list only when every write is in it.
        mutations: withOverlap.filter(function (r) { return r.kind === 'write'; }),
        mutation_requests: withOverlap.filter(function (r) { return r.kind === 'write'; }).length,
        peak_concurrent_requests: _peakConcurrent,
        requests: withOverlap.length,
        // A request that was ALONE for its whole life had no contention to blame, whatever it cost.
        solitary_requests: withOverlap.filter(function (r) { return r.overlapped_with.length === 0; })
          .map(function (r) { return r.action; })
      };
    }

    function metrics() {
      return {
        transport_build: TRANSPORT_BUILD,
        transport_contract_version: TRANSPORT_CONTRACT_VERSION,
        requests: _metrics.requests, retries: _metrics.retries,
        // F1-7N-FB-4E-R3 §E — how many reads ATTACHED to an already-open request instead of issuing one.
        // Reported because §E's whole claim is "navigating away and back creates zero additional requests",
        // and a claim about requests that were never made needs a counter of its own to be checkable.
        coalesced: _metrics.coalesced,
        // F1-7N-FB-4E-R4A1 §8 — how many reads needed the bounded redirect-target recovery. Reported because
        // a recovery is a SECOND physical request with its own request id, and a recovery that were happening on
        // every read would mean the primary path is wrong. Silent recovery would hide exactly that.
        recoveries: _metrics.recoveries,
        byAction: JSON.parse(JSON.stringify(_metrics.byAction)),
        byCode: JSON.parse(JSON.stringify(_metrics.byCode)),
        // §16.3 — why reads were not shared, so `coalesced` can be read as a fact rather than a puzzle.
        share_skipped: JSON.parse(JSON.stringify(_metrics.shareSkipped || {})),
        // R6-R5 §2 — peak concurrency is a property of the BURST, so it is reported beside the counts.
        peak_concurrent_requests: _peakConcurrent,
        open_requests: _openRequests,
        samples: _metrics.samples.slice()
      };
    }
    function resetMetrics() {
      _metrics = { requests: 0, retries: 0, coalesced: 0, recoveries: 0, byAction: {}, byCode: {}, samples: [], shareSkipped: {} };
      _epoch = _now(); _peakConcurrent = 0; _seq = 0;
      // `_openRequests` is deliberately NOT reset: requests already in flight will decrement it when they
      // settle, and zeroing it here would drive the counter negative and misreport every later dispatch.
    }
    // The legacy runners (the workspace POST path and the getTable reader) still own their own fetch, so they
    // report their outcome HERE rather than being rewritten wholesale in one round. Without this the §E report
    // would be structurally empty in production while looking like a measurement — which is worse than no
    // report. It records the same bounded sample shape and takes no URL, no payload and no row.
    // The clock belongs HERE, not in the caller. km-api-foundation.js is held to a determinism rule that
    // forbids reading a wall clock at all (its own suite asserts it), and that rule is worth keeping: a
    // transport-foundation layer that branches on time is untestable. So an observer calls this, gets a closure,
    // and never touches a clock itself.
    function beginExternal(action, kind) {
        var t0 = _now();
        return function done(code, bytes) {
            return recordExternal({ action: action, kind: kind, code: code || null,
                phase: code ? 'DISPATCH' : 'SUCCESS', ms: (_now() - t0), bytes: bytes || 0 });
        };
    }
    // F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R2 §5 — AN EXTERNAL SAMPLE NOW REACHES THE TIMELINE.
    //
    // MEASURED on the 2026-09-06 incident: `timeline()` keeps only samples carrying `dispatch_ms`, and that
    // field is set exclusively by this module's own `run()`. Every mutation in the application is issued by
    // `_kmWeeklyCommand_`, which owns its fetch and reports here — so two writes that changed two production
    // routes were recorded in `metrics()` and were STRUCTURALLY ABSENT from `timeline()`. The operator read
    // the timeline, saw only workspace reads, and concluded no mutation had been sent. The evidence was not
    // wrong; it was answering a narrower question than it appeared to.
    //
    // The two offsets are RECONSTRUCTED from the reported duration rather than observed at dispatch, which is
    // exactly the inference §2 forbids making SILENTLY. So it is labelled: `marks_source` says which rows were
    // observed and which were reconstructed, and a reader can discount an overlap computed from the latter.
    // A missing duration stays missing — a row with no `ms` is not given a fabricated interval.
    function recordExternal(sample) {
        sample = isObj(sample) ? sample : {};
        var _ms = (typeof sample.ms === 'number' && sample.ms >= 0) ? sample.ms : null;
        var _settled = _now() - _epoch;
        var _extMarks = (_ms === null) ? {} : {
          seq: ++_seq,
          dispatch_ms: Math.max(0, _settled - _ms),
          settled_ms: _settled,
          concurrent_at_dispatch: _openRequests,
          marks_source: 'EXTERNAL_RECONSTRUCTED'
        };
        record(Object.assign({ action: str(sample.action) || '(unknown)', kind: (str(sample.kind) === 'write') ? 'write' : 'read',
            code: sample.code ? str(sample.code) : null, phase: str(sample.phase) || null,
            ms: (typeof sample.ms === 'number' && sample.ms >= 0) ? sample.ms : 0,
            bytes: (typeof sample.bytes === 'number' && sample.bytes >= 0) ? sample.bytes : 0,
            attempts: (typeof sample.attempts === 'number') ? sample.attempts : 1,
            // §16.1 — an EXTERNALLY recorded sample (a legacy runner that owns its own fetch) usually cannot
            // supply these. They are carried when present and left EXPLICITLY null when not, so "the runner
            // did not tell us" is distinguishable from "the server did not answer". A classifier that read a
            // missing field as a negative would turn a reporting gap into a false finding.
            http_status: (typeof sample.http_status === 'number') ? sample.http_status : null,
            redirected: sample.redirected === true,
            server_answered: (typeof sample.server_answered === 'boolean') ? sample.server_answered : null,
            server_ms: (typeof sample.server_ms === 'number') ? sample.server_ms : null,
            request_id: sample.request_id ? str(sample.request_id) : null,
            // §5 — THE MUTATION'S OWN SHAPE. Identities, counts and FIELD NAMES only: which rows a request
            // addressed and which columns it would set is the whole question after an unexplained write, and
            // none of it requires carrying a quantity, a note or any other value.
            routes_in_payload: (typeof sample.routes_in_payload === 'number') ? sample.routes_in_payload : null,
            allocation_draft_id: sample.allocation_draft_id ? str(sample.allocation_draft_id) : null,
            allocation_draft_line_ids: Array.isArray(sample.allocation_draft_line_ids) ? sample.allocation_draft_line_ids.map(str) : null,
            changed_fields: Array.isArray(sample.changed_fields) ? sample.changed_fields.map(str) : null,
            outcome: sample.outcome ? str(sample.outcome) : null,
            external: true }, _extMarks));
        return true;
    }

    // ---- single-flight for SESSION-STABLE METADATA ONLY (§D) -------------------------------------------
    // The allowlist is the point. Coalescing a BUSINESS workspace would merge two different scopes into one
    // answer, which is a correctness bug dressed as a performance win — so a key that is not declared here is
    // never coalesced, and `singleFlight` says so rather than silently sharing.
    var METADATA_KEYS = {
      'system.health': 1, 'getClientCapabilities': 1, 'inventoryScope.registry.get': 1,
      'methodRegistry.get': 1, 'deploymentContract.probe': 1
    };
    var _inflight = {};
    function isMetadataKey(k) { return METADATA_KEYS[str(k)] === 1; }
    function singleFlight(key, fn) {
      var k = str(key);
      if (!isMetadataKey(k)) return Promise.resolve().then(fn);          // business scope: never shared
      if (_inflight[k]) return _inflight[k];
      var p = Promise.resolve().then(fn);
      _inflight[k] = p;
      // §D2 — EVICT ON EITHER OUTCOME, IMMEDIATELY. A rejected metadata promise that stays in the map is the
      // classic "reload fixes it" bug: every later consumer inherits the old failure and issues no request.
      var evict = function () { if (_inflight[k] === p) delete _inflight[k]; };
      p.then(evict, evict);
      return p;
    }
    function inflightKeys() { return Object.keys(_inflight); }

    // ------------------------------------------------------------------------------------------------------
    // F1-7N-FB-4E-R3 §E — SCOPE-KEYED IN-FLIGHT REUSE, AND WHY IT IS A SEPARATE FACILITY.
    //
    // `singleFlight` above refuses to share anything that is not a METADATA key, and that refusal is correct:
    // its key is the ACTION ALONE, and two business reads of the same action are routinely two DIFFERENT reads.
    // Sharing those would hand one scope's rows to another scope's page, which is a data-correctness fault and
    // strictly worse than a duplicate request. So this does NOT relax that guard and does NOT add business
    // actions to METADATA_KEYS.
    //
    // What it adds is the thing that makes sharing SAFE: a key that carries the whole scope. R3 §E.2 requires
    // in-flight reads to be keyed by action + canonical scope + payload version, and with such a key two
    // requests that collide are, by construction, requests for the same answer.
    //
    // FAIL-CLOSED. If either the action or the scope key is missing, this does NOT invent a key and does NOT
    // share — it simply runs the function, which is exactly today's behaviour. An unshareable read stays
    // unshared rather than becoming a guess.
    //
    // EVICTS ON EITHER OUTCOME, for the same reason the metadata latch does: a rejected promise left in the map
    // is the "reload fixes it" bug, and §E.6 requires that a failed request never poisons anything. Nothing is
    // retained after settlement, so this cannot serve a stale answer — it shares an OPEN request only. Bounded
    // TTL / stale-while-revalidate is a separate decision and is deliberately NOT taken here.
    // ------------------------------------------------------------------------------------------------------
    var _scopedInflight = {};
    function scopeKeyOf(action, scope) {
      var a = str(action), sc = str(scope);
      if (a === '' || sc === '') return '';
      return a + '\u0000' + sc;
    }
    function scopedSingleFlight(action, scope, fn) {
      var k = scopeKeyOf(action, scope);
      if (k === '') return Promise.resolve().then(fn);                  // unshareable: run it, share nothing
      if (_scopedInflight[k]) { _metrics.coalesced += 1; return _scopedInflight[k]; }
      var p = Promise.resolve().then(fn);
      _scopedInflight[k] = p;
      var evict = function () { if (_scopedInflight[k] === p) delete _scopedInflight[k]; };
      p.then(evict, evict);
      return p;
    }
    function scopedInflightKeys() { return Object.keys(_scopedInflight); }
    // F1-7N-FC-1B-E3-R4-A2-R1-R3 §16.3 — a read that was NOT eligible for in-flight sharing says why.
    // Counted per (action, reason). `coalesced: 0` beside two identical requests is ambiguous on its own, and
    // the ambiguity is what sent the last investigation to the wrong table.
    function noteShareSkipped(action, reason) {
      var a = str(action) || '(unknown)', r = str(reason) || 'UNSPECIFIED';
      _metrics.shareSkipped[a + ' :: ' + r] = (_metrics.shareSkipped[a + ' :: ' + r] || 0) + 1;
    }
    // A stable serialization for a request payload: sorted keys at every level, so two equivalent payloads
    // produce the SAME key regardless of construction order, and two different ones never collide.
    function canonicalScope(value) {
      function walk(v) {
        if (v === null || v === undefined) return 'n';
        if (Array.isArray(v)) return '[' + v.map(walk).join(',') + ']';
        if (typeof v === 'object') {
          var ks = Object.keys(v).sort();
          return '{' + ks.map(function (k) { return k + ':' + walk(v[k]); }).join(',') + '}';
        }
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        return JSON.stringify(str(v));
      }
      try { return walk(value); } catch (e) { return ''; }             // uncomputable scope => unshareable
    }

    // ---- the request ----------------------------------------------------------------------------------
    function fail(phase, code, message, details, timings) {
      return { success: false, phase: phase, code: code, message: message,
        details: details || {}, data: null, timings: timings || {}, retryable: false };
    }

    // One request through the whole machine. `opts`:
    //   action    the router action (required — a blank action is refused in BUILD, before the network)
    //   requestId correlation id echoed back and CHECKED (§C RESPONSE_REQUEST_ID_MISMATCH)
    //   payload   the request body object (merged with action/requestId)
    //   kind      'read' | 'write'  — decides the timeout bound and the retry ban
    //   signal    an AbortSignal; an abort is ABORTED/SUPERSEDED, never a red error (§C/§F)
    //   maxRetries default 1 for reads, always 0 for writes
    // ------------------------------------------------------------------------------------------------------
    // F1-7N-FB-4E-R4A1 §2/§3 — THE CANONICAL READ URL, AND THE ENDPOINT AUTHORITY RULE.
    //
    // A read is dispatched as a GET whose query string carries the SAME body a POST would have sent, under
    // `km_body`. Chosen from the executed matrix, not from preference: a POST crossing the Apps Script 302 loses
    // its body by specification, and the live evidence shows both consequences (an unreadable echo target, and
    // an echo that resolves back into doGet with nothing). A GET has nothing to lose.
    //
    // ENDPOINT AUTHORITY. Every attempt — first or recovery — is built HERE from `endpoint()`, which is the
    // stable script.google.com/macros/s/<id>/exec and nothing else. A googleusercontent target is never stored,
    // never re-requested and never returned as a next target: `classifyEndpoint` already refuses that host, and
    // the recovery below rebuilds from ep.url rather than from anything the response said.
    //
    // NO EXTRA CACHE-BUSTING VALUE IS ADDED, and that is a measured decision rather than an omission. §1 showed
    // a DIFFERENT user_content_key on every attempt, so browser redirect reuse is not what is failing; and the
    // request id is already in the query, so two physical reads never share a URL. `cache: 'no-store'` stays.
    // Adding a nonce would also have to be excluded from the single-flight key by hand, and a key dimension that
    // must be remembered to be excluded is a defect waiting to happen.
    // ------------------------------------------------------------------------------------------------------
    function readQuery(action, body, requestId) {
      var qp = 'action=' + encodeURIComponent(action) + '&km_via=get&km_tc=' + TRANSPORT_CONTRACT_VERSION;
      if (requestId) qp += '&km_rid=' + encodeURIComponent(requestId);
      var payload = JSON.stringify(isObj(body) ? body : {});
      if (payload !== '{}') qp += '&km_body=' + encodeURIComponent(payload);
      return qp;
    }
    // The size a read would occupy as a URL. Exposed so the URL-size proof measures the real thing.
    function readUrl(action, body, requestId) {
      var ep2 = endpoint();
      var base = ep2.ok ? ep2.url : '';
      return base + (base.indexOf('?') < 0 ? '?' : '&') + readQuery(str(action), body, str(requestId));
    }
    // Well under Google's practical URL ceiling. A read that exceeds it is REFUSED before dispatch with a named
    // reason — never silently truncated, and never silently switched to the verb that is known to fail.
    var READ_URL_MAX = 6000;

    function request(opts) {
      opts = opts || {};
      var action = str(opts.action);
      var kind = (str(opts.kind) === 'write') ? 'write' : 'read';
      var requestId = str(opts.requestId);
      var t = { start: _now(), endpoint: 0, queue: 0, network: 0, bodyRead: 0, parse: 0, validate: 0, total: 0 };
      // R6-R5 §2 — the marks. Taken HERE, before any await, so `concurrent_at_dispatch` is the number of
      // requests genuinely open at the moment this one entered the transport.
      var _mySeq = ++_seq;
      var _dispatchMs = t.start - _epoch;
      _openRequests += 1;
      var _concurrentAtDispatch = _openRequests;
      if (_openRequests > _peakConcurrent) _peakConcurrent = _openRequests;
      var _settled = false;
      function _closeRequest() { if (_settled) return; _settled = true; _openRequests -= 1; }
      var _owner = str(opts.owner) || null;
      var _reason = str(opts.reason) || null;
      var _payloadFp = isObj(opts.payload) ? canonicalScope(opts.payload).slice(0, 200) : null;
      function _marks() {
        return { seq: _mySeq, dispatch_ms: _dispatchMs, settled_ms: _now() - _epoch,
          concurrent_at_dispatch: _concurrentAtDispatch, owner: _owner, reason: _reason,
          payload_fingerprint: _payloadFp };
      }
      var maxRetries = (kind === 'write') ? 0 : ((typeof opts.maxRetries === 'number') ? Math.max(0, Math.min(1, opts.maxRetries)) : 1);

      // ---- BUILD ----
      if (action === '') {
        var b = fail(PHASE.BUILD, CODES.API_ENDPOINT_CONFIGURATION_INVALID,
          'No action was supplied, so no request was issued.', { action: null, zero_write: true, retryable: false }, t);
        _closeRequest();
        record(Object.assign({ action: '(blank)', kind: kind, code: b.code, phase: b.phase, ms: 0, bytes: 0 }, _marks()));
        return Promise.resolve(b);
      }
      var t0 = _now();
      var ep = endpoint();
      t.endpoint = _now() - t0;
      if (!ep.ok) {
        // §B6 — refused LOCALLY. No socket is opened, so this can never be confused with a network fault.
        var e0 = fail(PHASE.BUILD, CODES.API_ENDPOINT_CONFIGURATION_INVALID,
          'The API endpoint is not the stable Apps Script Web App /exec URL, so no request was sent. ' + ep.reason,
          { action: action, request_id: requestId || null, endpoint_class: ep.endpointClass,
            masked_endpoint: ep.maskedEndpoint, zero_write: true, retryable: false,
            next_action: 'Correct the configured Web App /exec URL. Retrying cannot change the configuration.' }, t);
        e0.endpointClass = ep.endpointClass;
        _closeRequest();
        record(Object.assign({ action: action, kind: kind, code: e0.code, phase: e0.phase, ms: 0, bytes: 0, endpointClass: ep.endpointClass }, _marks()));
        return Promise.resolve(e0);
      }
      if (typeof _fetch !== 'function') {
        var e1 = fail(PHASE.BUILD, CODES.API_ENDPOINT_CONFIGURATION_INVALID, 'No fetch implementation is available.',
          { action: action, zero_write: true, retryable: false }, t);
        _closeRequest();
        record(Object.assign({ action: action, kind: kind, code: e1.code, phase: e1.phase, ms: 0, bytes: 0 }, _marks()));
        return Promise.resolve(e1);
      }

      var dto = Object.assign({}, isObj(opts.payload) ? opts.payload : {}, { action: action });
      if (requestId) dto.requestId = requestId;
      // §M — action + request id ALSO travel in the query string. This is CORRELATION ONLY: it lets the router
      // and this classifier name a method downgrade instead of reporting an anonymous missing parameter. It is
      // NOT a workaround — no workspace payload is ever put in the query, no write payload is ever put in the
      // query, and the POST is never converted to a GET.
      var isRead = (kind !== 'write');
      // F1-7N-FB-4E-R4A1 — WRITES ARE UNCHANGED. POST, body in the body, action and id ALSO in the query for
      // correlation only (§M). No write is ever dispatched as a GET, and maxRetries is already 0 for a write, so
      // no write can enter the read recovery path below.
      function postQuery(rid) {
        var q = 'action=' + encodeURIComponent(action) + '&km_via=post&km_tc=' + TRANSPORT_CONTRACT_VERSION;
        if (rid) q += '&km_rid=' + encodeURIComponent(rid);
        return q;
      }
      var body = JSON.stringify(dto);
      function urlFor(rid) {
        var q = isRead ? readQuery(action, Object.assign({}, dto, rid ? { requestId: rid } : {}), rid) : postQuery(rid);
        return ep.url + (ep.url.indexOf('?') < 0 ? '?' : '&') + q;
      }
      // A read whose parameters will not fit a URL is refused HERE, before any socket is opened. It is not
      // silently truncated (a different request), and it is not silently sent as a POST (the verb the matrix
      // proved fails). No read in this application is anywhere near the limit; this exists so that if one ever
      // becomes so, it says so.
      if (isRead) {
        var probeUrl = urlFor(requestId);
        if (probeUrl.length > READ_URL_MAX) {
          var eBig = fail(PHASE.BUILD, CODES.API_ENDPOINT_CONFIGURATION_INVALID,
            'This read\'s parameters are too large to send as a URL (' + probeUrl.length + ' > ' + READ_URL_MAX + ' characters), so no request was issued.',
            { action: action, request_id: requestId || null, url_chars: probeUrl.length, url_chars_max: READ_URL_MAX,
              zero_write: true, retryable: false,
              next_action: 'Narrow the read (fewer filters, a smaller page) or give this action a scoped server-side parameter. Retrying cannot make the URL shorter.' }, t);
          record({ action: action, kind: kind, code: eBig.code, phase: eBig.phase, ms: 0, bytes: 0 });
          return Promise.resolve(eBig);
        }
      }

      // The id THIS physical attempt carries. A recovery is a SECOND physical request, so R4A's rule applies to
      // it in full: it gets its own id, and its answer is validated against that id — never against the first
      // attempt's, and never against a consumer's.
      function ridForAttempt(n) { return (n <= 1 || !requestId) ? requestId : (requestId + '-R' + n); }

      function attempt(n) {
        var attemptRid = ridForAttempt(n);
        var url = urlFor(attemptRid);
        // ---- DISPATCH ----
        var ctl = null;
        try { ctl = (typeof AbortController === 'function') ? new AbortController() : null; } catch (e) { ctl = null; }
        var init = isRead
          ? { method: 'GET', cache: 'no-store' }
          : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' }, body: body };
        if (ctl) init.signal = ctl.signal;
        var ms = (kind === 'write') ? _writeTimeoutMs : _readTimeoutMs;
        var timedOut = false, aborted = false, timer = null;
        var external = opts.signal || null;
        if (external && external.aborted) {
          return Promise.resolve(fail(PHASE.DISPATCH, CODES.REQUEST_ABORTED, 'The request was superseded before it was sent.',
            { action: action, request_id: requestId || null, zero_write: true, retryable: false, superseded: true }, t));
        }
        var onExternalAbort = function () { aborted = true; try { if (ctl) ctl.abort(); } catch (e) {} };
        if (external && typeof external.addEventListener === 'function') external.addEventListener('abort', onExternalAbort);

        var netStart = _now();
        var expiry = new Promise(function (_res, rej) {
          timer = setTimeout(function () {
            timedOut = true;
            try { if (ctl) ctl.abort(); } catch (e2) {}
            var er = new Error('REQUEST_TIMEOUT'); er.kmTimeout = true; rej(er);
          }, ms);
        });

        return Promise.race([Promise.resolve().then(function () { return _fetch(url, init); }), expiry])
          .then(function (resp) {
            if (timer) clearTimeout(timer);
            t.network = _now() - netStart;
            // ---- REDIRECT/RESPONSE ----
            // Everything the previous runners discarded is captured HERE, once, and it is the only reason the
            // four 404 sources can be told apart at all.
            var status = (typeof resp.status === 'number') ? resp.status : null;
            var ctype = '';
            try { if (resp.headers && typeof resp.headers.get === 'function') ctype = resp.headers.get('content-type') || ''; } catch (e3) { ctype = ''; }
            var finalUrl = str(resp.url);
            var redirected = resp.redirected === true;
            var brStart = _now();
            var textP = (typeof resp.text === 'function') ? Promise.resolve(resp.text())
              : (typeof resp.json === 'function') ? Promise.resolve(resp.json()).then(function (v) { return JSON.stringify(v); })
              : Promise.resolve('');
            return textP.then(function (raw) {
              t.bodyRead = _now() - brStart;
              var text = str(raw);
              var bytes = String(raw == null ? '' : raw).length;
              var wire = {
                httpStatus: status, contentType: ctype || null, responseBytes: bytes, redirected: redirected,
                maskedFinalEndpoint: maskEndpoint(finalUrl), maskedRequestedEndpoint: maskEndpoint(url),
                endpointClass: ep.endpointClass, attempt: n
              };
              var looksHtml = text === '' || /^<(!doctype|html|\?xml|head|body)/i.test(text) || (/text\/html/i.test(ctype) && text.charAt(0) !== '{');
              if (looksHtml) {
                var fp = fingerprintHtml({ body: text, status: status, contentType: ctype, finalUrl: finalUrl,
                  requestedUrl: url, redirected: redirected, frontendOrigin: frontendOrigin() });
                var code = codeForHtml(fp);
                var r = fail(PHASE.REDIRECT_RESPONSE, code, messageForHtml(code, fp, action),
                  Object.assign({}, wire, { action: action, request_id: attemptRid || null, zero_write: (kind !== 'write'),
                    html_source: fp.source, fingerprint: fp, retryable: false,
                    next_action: nextActionForHtml(fp.source) }), t);
                r.fingerprint = fp;
                return r;
              }
              if (!(status === null || (status >= 200 && status < 300))) {
                // JSON-shaped but a non-2xx status — a real HTTP failure, and the only place a bounded retry is
                // even considered.
                return fail(PHASE.REDIRECT_RESPONSE, CODES.HTTP_TRANSPORT_ERROR, 'The API answered HTTP ' + status + '.',
                  Object.assign({}, wire, { action: action, request_id: attemptRid || null, zero_write: (kind !== 'write'),
                    retryable: isAutoRetryable({ kind: kind, code: CODES.HTTP_TRANSPORT_ERROR, httpStatus: status }) }), t);
              }
              // ---- PARSE ----
              var pStart = _now();
              var json;
              try { json = JSON.parse(text); }
              catch (pe) {
                t.parse = _now() - pStart;
                return fail(PHASE.PARSE, CODES.TRANSPORT_NON_JSON_RESPONSE, 'The API answered with a body that is not JSON.',
                  Object.assign({}, wire, { action: action, request_id: requestId || null, zero_write: (kind !== 'write'), retryable: false }), t);
              }
              t.parse = _now() - pStart;
              // ---- CONTRACT_VALIDATE ----
              var vStart = _now();
              // Validated against the id THIS attempt sent, and told the verb THIS attempt used. Passing 'POST'
              // for a GET would make the five-fact downgrade proof claim a POST was dispatched when none was.
              var v = validate(json, { action: action, requestId: attemptRid, kind: kind, wire: wire,
                dispatchedMethod: isRead ? 'GET' : 'POST' });
              // The router's own answer, kept verbatim beside the classification. The workspace layer classifies
              // from the envelope, so handing it back is what lets ONE dispatch boundary serve both.
              if (v && !v.envelope) v.envelope = json;
              t.validate = _now() - vStart;
              return v;
            });
          }, function (err) {
            if (timer) clearTimeout(timer);
            t.network = _now() - netStart;
            if (aborted || (err && (err.name === 'AbortError' || err.kmAbort))) {
              return fail(PHASE.DISPATCH, CODES.REQUEST_ABORTED, 'The request was superseded and its answer discarded.',
                { action: action, request_id: requestId || null, zero_write: true, retryable: false, superseded: true }, t);
            }
            if (timedOut || (err && err.kmTimeout)) {
              return (kind === 'write')
                ? fail(PHASE.DISPATCH, CODES.REQUEST_TIMEOUT_WRITE_INDETERMINATE,
                    'No answer arrived within ' + Math.round(ms / 1000) + 's. The write may or may not have been committed — verify before retrying.',
                    { action: action, request_id: requestId || null, zero_write: false, indeterminate: true, retryable: false, timeout_ms: ms }, t)
                : fail(PHASE.DISPATCH, CODES.REQUEST_TIMEOUT, 'No answer arrived within ' + Math.round(ms / 1000) + 's.',
                    { action: action, request_id: requestId || null, zero_write: true, retryable: false, timeout_ms: ms }, t);
            }
            return fail(PHASE.DISPATCH, CODES.HTTP_TRANSPORT_ERROR,
              'The request could not reach the API: ' + str((err && err.message) || err),
              { action: action, request_id: requestId || null, zero_write: (kind !== 'write'), httpStatus: null, retryable: (kind === 'read') }, t);
          })
          ['catch'](function (err) {
            if (timer) clearTimeout(timer);
            return fail(PHASE.DISPATCH, CODES.HTTP_TRANSPORT_ERROR, str((err && err.message) || err),
              { action: action, request_id: requestId || null, zero_write: (kind !== 'write'), retryable: false }, t);
          })
          .then(function (res) {
            if (external && typeof external.removeEventListener === 'function') external.removeEventListener('abort', onExternalAbort);
            if (res.success) return res;
            if (n <= maxRetries && isAutoRetryable({ kind: kind, code: res.code, httpStatus: res.details && res.details.httpStatus })) {
              _metrics.retries += 1;
              // F1-7N-FB-4E-R4A1 §6 — the recovery is COUNTED and NAMED, and it states where it will start:
              // the stable /exec, rebuilt from endpoint(), never the redirect target that just failed.
              if (res.code === CODES.REDIRECT_TARGET_NOT_FOUND) {
                _metrics.recoveries += 1;
                res.details.recovery_from = 'STABLE_EXEC';
                res.details.recovery_request_id = ridForAttempt(n + 1);
              }
              var d = retryDelayMs(n, _random, deps.retryBaseMs, deps.retryCapMs);
              res.details.retry_scheduled_ms = d;
              return Promise.resolve(_sleep(d)).then(function () { return attempt(n + 1); });
            }
            return res;
          });
      }

      return attempt(1).then(function (res) {
        t.total = _now() - t.start;
        res.timings = t;
        res.maskedEndpoint = ep.maskedEndpoint;
        res.endpointClass = ep.endpointClass;
        // ==========================================================================================
        // F1-7N-FC-1B-E3-R4-A2-R1-R3 §16.1 — DID THE REQUEST REACH THE SERVER AT ALL?
        //
        // A live report classified five timeouts across FOUR different actions and could not answer that
        // question, because a sample carried only action / kind / code / phase / ms / bytes / attempts.
        // With no server evidence in the record, "the 19-table workspace read is too slow" and "nothing we
        // sent was ever accepted" are indistinguishable — and the first reading is the one people reach
        // for, because it names something they already know is slow.
        //
        // Every field added here was ALREADY computed on this code path and thrown away at this line. None
        // of it is new measurement and none of it is a payload, a URL or a row:
        //
        //   http_status      the response status, or null when NO response ever arrived
        //   redirected       whether the platform's /exec → script.googleusercontent hop happened
        //   server_answered  whether a parseable envelope came back (the router ran)
        //   server_ms        the server's own execution time, when the envelope reports one
        //   request_id       the correlation id, so a client sample can be matched to a server execution
        //
        // `server_answered:false` with `http_status:null` on several DIFFERENT actions is what makes a
        // SHARED transport/dispatch fault decidable rather than assumed.
        var _d = res.details || {};
        var _env = res.envelope || null;
        var _meta = (_env && _env.meta) || null;
        _closeRequest();
        record(Object.assign({ action: action, kind: kind, code: res.success ? null : res.code, phase: res.phase,
          ms: t.total, bytes: _d.responseBytes || 0, attempts: _d.attempt || 1,
          http_status: (typeof _d.httpStatus === 'number') ? _d.httpStatus : null,
          redirected: _d.redirected === true,
          server_answered: !!_env,
          // R6-R5 §3 — the server's own stage evidence, carried through to the sample when the envelope
          // reports it. `server_ms` alone cannot separate "queued behind three other executions" from
          // "executed slowly"; `server_stages` can.
          server_ms: (_meta && typeof _meta.serverDurationMs === 'number') ? _meta.serverDurationMs : null,
          server_stages: (_meta && _meta.stages) ? _meta.stages : null,
          server_request_id: (_meta && _meta.requestId) ? str(_meta.requestId) : null,
          request_id: requestId || null,
          endpoint_class: ep.endpointClass || null,
          timeout_ms: (typeof _d.timeout_ms === 'number') ? _d.timeout_ms : null }, _marks()));
        return res;
      });
    }

    // ------------------------------------------------------------------------------------------------------
    // §L — THE CONTRACT VALIDATOR, AND THE END OF DECIDING BY PROSE.
    //
    // The previous classifier concluded REQUEST_METHOD_DOWNGRADED from a REGEX ON THE ROUTER'S MESSAGE
    // (/Use:\s*getOperationDb\s*,\s*getTable/). That is unsound in both directions: any doGet answer carrying
    // that sentence is labelled a downgrade even when no POST was involved, and the resulting message asserted
    // that "its body — and therefore its action — was dropped in transit" WHILE THE ACTION WAS SITTING IN THE
    // QUERY STRING AND HAD JUST BEEN ECHOED BACK BY THE ROUTER. Both halves of that sentence cannot be true.
    //
    // The five facts §L requires are now each read from a specific place, and all five must hold:
    //   1. the client dispatched POST                 — we did; this transport has no GET path at all
    //   2. the request reached the router as a GET     — router `received_method === 'GET'`
    //   3. doGet actually answered                     — router `handler === 'doGet'` or `code === 'POST_ONLY_ACTION_ON_GET'`
    //   4. the POST body was unavailable               — router `post_body_present === false` (or the typed code)
    //   5. the answer correlates to THIS request       — router `request_id` === our km_rid
    // Anything short of that is reported as the narrower thing it actually is, up to and including
    // RESPONSE_CORRELATION_UNPROVEN, rather than promoted to a downgrade claim.
    // ------------------------------------------------------------------------------------------------------
    function validate(env, ctx) {
      var wire = ctx.wire || {};
      var base = { action: ctx.action, request_id: ctx.requestId || null };
      if (!isObj(env)) {
        return fail(PHASE.CONTRACT_VALIDATE, CODES.TRANSPORT_NON_JSON_RESPONSE, 'The API answered with a value that is not an envelope.',
          Object.assign({}, wire, base, { zero_write: (ctx.kind !== 'write'), retryable: false }));
      }
      // Request-id correlation. Only a genuine MISMATCH fails; a deployment that does not echo one yet is a
      // separate, reported condition (unproven correlation), never silently accepted as proof.
      var echoedRid = str(env.request_id || (isObj(env.meta) && env.meta.requestId) || '');
      var ridState = !ctx.requestId ? 'NOT_REQUESTED' : (echoedRid === '' ? 'NOT_ECHOED' : (echoedRid === ctx.requestId ? 'MATCH' : 'MISMATCH'));
      if (ridState === 'MISMATCH') {
        return fail(PHASE.CONTRACT_VALIDATE, CODES.RESPONSE_REQUEST_ID_MISMATCH,
          'The answer carried a different request id than the one sent, so it belongs to another request and was discarded.',
          Object.assign({}, wire, base, { answered_request_id: echoedRid, zero_write: true, retryable: true,
            next_action: 'Retry the read once. If it repeats, reload the page so the session redirect is re-established.' }));
      }
      var serverAction = str((isObj(env.meta) && env.meta.action) || env.attempted_action || '');
      if (serverAction && serverAction.toLowerCase() !== str(ctx.action).toLowerCase() && env.code !== 'POST_ONLY_ACTION_ON_GET') {
        return fail(PHASE.CONTRACT_VALIDATE, CODES.RESPONSE_ACTION_MISMATCH,
          'The deployment answered a different action than the one requested (asked "' + ctx.action + '", answered "' + serverAction + '").',
          Object.assign({}, wire, base, { answered_action: serverAction, zero_write: true, retryable: true }));
      }

      if (env.success === true) {
        return { success: true, phase: PHASE.SUCCESS, code: null, message: '', data: (env.data === undefined ? null : env.data),
          meta: isObj(env.meta) ? env.meta : null, details: Object.assign({}, wire, base, { request_id_correlation: ridState }),
          timings: {}, retryable: false, envelope: env };
      }

      // ---- the router's terminal answers -------------------------------------------------------------
      var errText = str(env.error || (Array.isArray(env.errors) && env.errors[0] && (env.errors[0].message || env.errors[0].code)) || '');
      var routerCode = str(env.code);
      var receivedMethod = str(env.received_method).toUpperCase();
      var handler = str(env.handler);
      var sentAsPost = env.sent_as_post === true;
      var bodyPresent = env.post_body_present;

      // The five-fact proof. Note what it does NOT accept: a 302 having happened, a final GET to
      // googleusercontent, an absent errors[], an HTML body, or a generic unknown-action sentence.
      var evidence = {
        client_dispatched_post: ctx.dispatchedMethod === 'POST',
        router_received_method: receivedMethod || null,
        router_handler: handler || (routerCode === 'POST_ONLY_ACTION_ON_GET' ? 'doGet' : null),
        router_code: routerCode || null,
        action_present_in_query: (env.action_present_in_query === undefined) ? null : (env.action_present_in_query === true),
        post_body_present: (bodyPresent === undefined) ? null : (bodyPresent === true),
        sent_as_post_marker: sentAsPost,
        request_id_correlation: ridState
      };
      var provedGetHandler = (receivedMethod === 'GET') || (evidence.router_handler === 'doGet') || routerCode === 'POST_ONLY_ACTION_ON_GET';
      var provedBodyLost = (bodyPresent === false) || routerCode === 'POST_ONLY_ACTION_ON_GET';
      var correlated = (ridState === 'MATCH') || (!ctx.requestId && provedGetHandler);

      if (evidence.client_dispatched_post && provedGetHandler && provedBodyLost && correlated) {
        // A real downgrade. The message states ONLY what the evidence supports — and explicitly does NOT
        // claim the action was lost, because the query string carried it and the router named it back.
        var actionSurvived = evidence.action_present_in_query === true || str(env.attempted_action) !== '';
        return fail(PHASE.CONTRACT_VALIDATE, CODES.REQUEST_METHOD_DOWNGRADED,
          'This read was sent as a POST but reached the server as a GET, so the POST body was lost and the server could not run it. '
            + (actionSurvived
                ? 'The action itself survived in the request URL — that is how the server could name it — so nothing was misaddressed and nothing was read or written.'
                : 'Nothing was read or written.'),
          Object.assign({}, wire, base, { received_by: 'doGet', zero_write: true, retryable: true, evidence: evidence,
            router_message: errText || null,
            next_action: 'Retry the read once. If every first load does this, reload the page so the Apps Script session redirect is re-established.' }));
      }

      // Not proved. Say which narrower thing it is instead of guessing upward.
      var unknownAction = /^(Invalid POST action|Missing or invalid action parameter|Invalid action|Unsupported action)\b/i.test(errText);
      if (unknownAction) {
        if (provedGetHandler && !correlated) {
          return fail(PHASE.CONTRACT_VALIDATE, CODES.RESPONSE_CORRELATION_UNPROVEN,
            'The answer came from the GET handler but could not be matched to this request, so it is not evidence about this read. Nothing was read.',
            Object.assign({}, wire, base, { zero_write: true, retryable: true, evidence: evidence, router_message: errText }));
        }
        return fail(PHASE.CONTRACT_VALIDATE, CODES.DEPLOYMENT_CONTRACT_MISMATCH,
          'The deployed Apps Script Web App does not contain the action "' + ctx.action + '". Saving the code in the editor does not publish it: create a NEW DEPLOYMENT VERSION, then reload. Nothing was read or written.',
          Object.assign({}, wire, base, { missing_action: ctx.action, zero_write: true, retryable: false, evidence: evidence,
            router_message: errText, next_action: 'Publish a new Apps Script deployment version containing this action, then hard-reload the page.' }));
      }

      // A valid JSON business rejection. It is NOT a transport fault and must never be classified as one.
      var structured = (Array.isArray(env.errors) && isObj(env.errors[0])) ? env.errors[0] : null;
      return fail(PHASE.CONTRACT_VALIDATE, CODES.BACKEND_BUSINESS_REJECTION,
        (structured && str(structured.message)) || errText || 'The backend rejected the request.',
        Object.assign({}, wire, base, {
          business_code: (structured && str(structured.code)) || null,
          business_details: (structured && structured.details) || (isObj(env.data) ? env.data : null),
          zero_write: env.zero_write === true, retryable: false, evidence: evidence
        }));
    }

    function messageForHtml(code, fp, action) {
      if (code === CODES.AUTH_OR_ACCESS_HTML) {
        return 'The API endpoint answered with a Google sign-in or access page instead of data, so the request was never executed. Nothing was read.';
      }
      if (fp.source === HTML_SOURCE.GITHUB_PAGES_404 || fp.source === HTML_SOURCE.FRONTEND_ORIGIN_RESPONSE) {
        return 'The request for "' + action + '" was answered by the WEBSITE itself with a 404 page, not by the API. The configured endpoint is not reaching the Apps Script Web App.';
      }
      if (fp.source === HTML_SOURCE.EXPIRED_USERCONTENT_REDIRECT) {
        return 'The API redirect target had already expired, so the answer to "' + action + '" was a 404 page instead of data. Nothing was read.';
      }
      if (fp.source === HTML_SOURCE.APPS_SCRIPT_DEPLOYMENT_404) {
        return 'The Apps Script deployment did not answer "' + action + '" — it returned HTTP ' + fp.httpStatus + ' as a web page. The deployment may be unpublished, superseded or access-restricted.';
      }
      return 'The API answered with a web page (HTTP ' + fp.httpStatus + ', ' + (fp.contentType || 'unknown type') + ') instead of data. Nothing was read.';
    }
    function nextActionForHtml(source) {
      if (source === HTML_SOURCE.GOOGLE_AUTH_OR_ACCESS) return 'Sign in to the Google account that may run this Web App, or change the deployment access policy. Retrying will not help.';
      if (source === HTML_SOURCE.GITHUB_PAGES_404 || source === HTML_SOURCE.FRONTEND_ORIGIN_RESPONSE) return 'Correct the configured Web App /exec URL — the request is being sent to the website instead of the API.';
      if (source === HTML_SOURCE.EXPIRED_USERCONTENT_REDIRECT) return 'Retry the read once. If it repeats, reload the page so a fresh session redirect is issued.';
      if (source === HTML_SOURCE.APPS_SCRIPT_DEPLOYMENT_404) return 'Verify the Web App deployment exists and is published, then hard-reload. Retrying cannot publish a deployment.';
      return 'Run the read-only system.health check to establish whether the deployment is reachable.';
    }

    // ---- §F — THE SAFE ERROR FIELD SET, formatted ONCE ------------------------------------------------
    // §F requires every error surface to carry the reason code, the action, the request id, the retryability
    // and a suggested next action. Four pages showed "<message> [<code>]" instead, which cannot be acted on and
    // cannot be quoted in a report. This produces the same line for all of them from whatever the error carries
    // — a typed transport result, a legacy { code, message } object, or a thrown Error with `kmTransport`.
    //
    // It emits STRINGS ONLY and no markup, so a caller escapes once and cannot be made to inject. It never
    // includes a raw response body, an unmasked URL, a Script ID or a row.
    function errorFields(err) {
      err = err || {};
      var t = err.kmTransport || err.transport || (isObj(err.details) ? err.details : {}) || {};
      var code = str(err.code) || str(t.code) || 'READ_FAILED';
      var nonRetryable = (code === CODES.API_ENDPOINT_CONFIGURATION_INVALID || code === CODES.HTTP_NOT_FOUND_HTML
        || code === CODES.AUTH_OR_ACCESS_HTML || code === CODES.DEPLOYMENT_CONTRACT_MISMATCH);
      var retryable = nonRetryable ? false : (t.retryable === undefined ? true : t.retryable !== false);
      return {
        code: str(t.code) || code,
        legacy_code: code,
        action: str(t.action) || str(err.action) || null,
        request_id: str(t.request_id) || str(err.request_id) || str(err.requestId) || null,
        http_status: (t.httpStatus === undefined || t.httpStatus === null) ? null : t.httpStatus,
        content_type: str(t.contentType) || null,
        html_source: str(t.html_source) || null,
        masked_endpoint: str(t.maskedFinalEndpoint) || str(t.maskedRequestedEndpoint) || null,
        phase: str(t.phase) || null,
        retryable: retryable,
        zero_write: t.zero_write === true,
        message: str(err.message) || 'The read failed.',
        next_action: str(t.next_action) || (retryable
          ? 'Press Retry. It issues exactly one new request; no reload or navigation is needed.'
          : 'Retrying will not help: correct the Web App endpoint, sign in, or publish a new Apps Script deployment version.')
      };
    }
    // The one-line summary a page appends after its own label. Plain text; the caller escapes it.
    function errorLine(err) {
      var f = errorFields(err);
      var bits = [f.message, 'Reason: ' + f.code];
      if (f.action) bits.push('Action: ' + f.action);
      if (f.request_id) bits.push('Request: ' + f.request_id);
      if (f.http_status != null) bits.push('HTTP ' + f.http_status);
      if (f.content_type) bits.push(f.content_type);
      if (f.html_source) bits.push('Source: ' + f.html_source);
      if (f.masked_endpoint) bits.push('Endpoint: ' + f.masked_endpoint);
      bits.push(f.retryable ? 'Retryable: yes' : 'Retryable: no');
      bits.push(f.next_action);
      return bits.join(' \u00b7 ');
    }

    // ---- §F — the typed result → the ONE UI state -----------------------------------------------------
    // Exported so a page never has to decide. "尚未連接資料來源" is reachable from EMPTY_CONFIGURATION only,
    // and no failure code maps there — which is what makes §F item 11 structural instead of a guideline.
    function uiState(res, opts) {
      opts = opts || {};
      if (!res) return UI_STATE.LOADING;
      if (res.success) {
        var hasRows = (typeof opts.hasData === 'boolean') ? opts.hasData : !!(res.data && (!Array.isArray(res.data) ? Object.keys(res.data).length : res.data.length));
        if (hasRows) return UI_STATE.READY_WITH_DATA;
        return (opts.configured === false) ? UI_STATE.EMPTY_CONFIGURATION : UI_STATE.READY_EMPTY;
      }
      if (res.code === CODES.REQUEST_ABORTED) return UI_STATE.ABORTED_SUPERSEDED;
      if (res.code === CODES.API_ENDPOINT_CONFIGURATION_INVALID
        || res.code === CODES.DEPLOYMENT_CONTRACT_MISMATCH
        || res.code === CODES.AUTH_OR_ACCESS_HTML
        || res.code === CODES.HTTP_NOT_FOUND_HTML) return UI_STATE.NON_RETRYABLE_CONFIGURATION_OR_DEPLOYMENT_ERROR;
      return UI_STATE.TRANSIENT_ERROR;
    }
    // The safe error surface a page may render: reason code, action, request id, retryability, next action.
    // No raw HTML body, no URL beyond the masked identity, no token, no row.
    function describe(res) {
      if (!res || res.success) return null;
      var d = res.details || {};
      return {
        code: res.code, phase: res.phase, action: d.action || null, request_id: d.request_id || null,
        retryable: !!d.retryable, zero_write: d.zero_write === true,
        http_status: (d.httpStatus === undefined ? null : d.httpStatus), content_type: d.contentType || null,
        masked_endpoint: d.maskedFinalEndpoint || d.maskedRequestedEndpoint || null,
        html_source: d.html_source || null, ui_state: uiState(res),
        message: res.message, next_action: d.next_action || null
      };
    }

    return {
      // identity
      TRANSPORT_CONTRACT_VERSION: TRANSPORT_CONTRACT_VERSION, TRANSPORT_BUILD: TRANSPORT_BUILD,
      PHASE: PHASE, PHASE_ORDER: PHASE_ORDER, CODES: CODES, UI_STATE: UI_STATE,
      ENDPOINT_CLASS: ENDPOINT_CLASS, HTML_SOURCE: HTML_SOURCE,
      // endpoint authority
      endpoint: endpoint, classifyEndpoint: classifyEndpoint, maskEndpoint: maskEndpoint,
      // machine
      request: request, validate: validate, fingerprintHtml: fingerprintHtml, codeForHtml: codeForHtml,
      // F1-7N-FB-4E-R4A1 - the canonical read URL, exposed so the URL-size proof measures what is dispatched
      // rather than a reconstruction of it, and so the workspace layer cannot invent a second URL shape.
      readUrl: readUrl, readQuery: readQuery, READ_URL_MAX: READ_URL_MAX,
      // policy
      isAutoRetryable: isAutoRetryable, retryDelayMs: retryDelayMs,
      // concurrency
      singleFlight: singleFlight, isMetadataKey: isMetadataKey, inflightKeys: inflightKeys,
      // F1-7N-FB-4E-R3 §E — scope-keyed in-flight reuse for BUSINESS reads (separate from the metadata latch)
      scopedSingleFlight: scopedSingleFlight, scopedInflightKeys: scopedInflightKeys, canonicalScope: canonicalScope,
      noteShareSkipped: noteShareSkipped,
      metadataKeys: function () { return Object.keys(METADATA_KEYS); },
      // observation
      metrics: metrics, resetMetrics: resetMetrics, recordExternal: recordExternal, uiState: uiState, describe: describe,
      // R6-R5 §2 — the chronological overlap report, and the live in-flight count the arbiter reads.
      timeline: timeline, openRequests: function () { return _openRequests; },
      peakConcurrentRequests: function () { return _peakConcurrent; },
      errorFields: errorFields, errorLine: errorLine, beginExternal: beginExternal,
      status: function () {
        var ep = endpoint();
        return { transport_build: TRANSPORT_BUILD, transport_contract_version: TRANSPORT_CONTRACT_VERSION,
          endpoint_class: ep.endpointClass, endpoint_ok: ep.ok, masked_endpoint: ep.maskedEndpoint,
          reason: ep.reason || null, requests: _metrics.requests, retries: _metrics.retries };
      }
    };
  }

  return {
    create: create,
    TRANSPORT_CONTRACT_VERSION: TRANSPORT_CONTRACT_VERSION, TRANSPORT_BUILD: TRANSPORT_BUILD,
    PHASE: PHASE, CODES: CODES, UI_STATE: UI_STATE, ENDPOINT_CLASS: ENDPOINT_CLASS, HTML_SOURCE: HTML_SOURCE,
    classifyEndpoint: classifyEndpoint, maskEndpoint: maskEndpoint, fingerprintHtml: fingerprintHtml,
    codeForHtml: codeForHtml, isAutoRetryable: isAutoRetryable, retryDelayMs: retryDelayMs
  };
});
