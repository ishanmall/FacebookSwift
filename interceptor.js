(function () {
  if (window.__facebookswiftV34Loaded) return;
  window.__facebookswiftV34Loaded = true;

  let backgroundScanLockEnabled = false;

  // Stores captured Facebook GraphQL pagination requests by section ("posts" vs "reels")
  const graphqlTemplates = {
    posts: null,
    reels: null,
    any: null
  };

  const latestCursors = {
    posts: null,
    reels: null,
    any: null
  };

  window.addEventListener(
    "visibilitychange",
    (e) => {
      if (backgroundScanLockEnabled) e.stopImmediatePropagation();
    },
    true
  );

  window.addEventListener(
    "blur",
    (e) => {
      if (backgroundScanLockEnabled) e.stopImmediatePropagation();
    },
    true
  );

  function enableSafeVisibilityOverride() {
    backgroundScanLockEnabled = true;
    try {
      Object.defineProperty(Document.prototype, "hidden", {
        get: function () { return false; },
        configurable: true
      });
      Object.defineProperty(Document.prototype, "visibilityState", {
        get: function () { return "visible"; },
        configurable: true
      });
      Document.prototype.hasFocus = function () { return true; };
    } catch (_) {}
  }

  function emitToContent(type, data) {
    window.postMessage(
      {
        source: "FBSWIFT_MAIN",
        type,
        pagePath: window.location.pathname + window.location.search,
        ...data
      },
      "*"
    );
  }

  function extractCursorsFromPayload(obj, pagePath) {
    const visited = new WeakSet();
    const isReelsPage = String(pagePath || "").toLowerCase().includes("reels") || String(pagePath || "").toLowerCase().includes("videos");

    function walk(node) {
      if (!node || typeof node !== "object" || visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node.page_info && node.page_info.has_next_page && node.page_info.end_cursor) {
        const cur = String(node.page_info.end_cursor);
        latestCursors.any = cur;
        if (isReelsPage) latestCursors.reels = cur;
        else latestCursors.posts = cur;
      }
      for (const k of Object.keys(node)) {
        walk(node[k]);
      }
    }
    walk(obj);
  }

  function parseFacebookResponseText(rawText, reqUrl, pagePath) {
    if (!rawText || typeof rawText !== "string") return 0;

    const cleaned = rawText.replace(/^for\s*\(;;\);?\s*/, "").trim();
    const lines = cleaned.split(/\r?\n/);
    let parsedCount = 0;

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("{") && !t.startsWith("[")) continue;
      try {
        const parsed = JSON.parse(t);
        parsedCount++;
        extractCursorsFromPayload(parsed, pagePath);
        emitToContent("INTERCEPTED_JSON", {
          url: reqUrl,
          pagePath,
          payload: parsed,
          cursors: { ...latestCursors }
        });
      } catch (_) {}
    }
    return parsedCount;
  }

  function inspectGraphqlOutgoingBody(bodyStr) {
    try {
      if (typeof bodyStr !== "string" || !bodyStr.includes("doc_id=")) return;
      const params = new URLSearchParams(bodyStr);
      const docId = params.get("doc_id");
      const friendly = params.get("fb_api_req_friendly_name") || "";
      const vars = params.get("variables") || "";

      if (!docId || (!vars.includes("cursor") && !vars.includes("count") && !vars.includes("first"))) return;

      const tpl = { docId, friendly, bodyStr };
      graphqlTemplates.any = tpl;

      const fl = friendly.toLowerCase();
      if (fl.includes("reel") || fl.includes("shorts") || fl.includes("clip") || fl.includes("video")) {
        graphqlTemplates.reels = tpl;
      } else if (fl.includes("photo") || fl.includes("timeline") || fl.includes("profile") || fl.includes("feed")) {
        graphqlTemplates.posts = tpl;
      }
    } catch (_) {}
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const pagePathAtStart = window.location.pathname + window.location.search;
    try {
      if (typeof args[1]?.body === "string") inspectGraphqlOutgoingBody(args[1].body);
    } catch (_) {}

    const response = await origFetch.apply(this, args);
    try {
      const reqUrl = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
      if (reqUrl.includes("/api/graphql") || reqUrl.includes("graphql") || reqUrl.includes("/ajax/")) {
        const clone = response.clone();
        clone.text().then((txt) => {
          parseFacebookResponseText(txt, reqUrl, pagePathAtStart);
        }).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__fbUrl = typeof url === "string" ? url : String(url || "");
    this.__fbPagePath = window.location.pathname + window.location.search;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (typeof args[0] === "string") inspectGraphqlOutgoingBody(args[0]);
    } catch (_) {}

    this.addEventListener("load", function () {
      try {
        const url = this.__fbUrl || "";
        if (url.includes("/api/graphql") || url.includes("graphql") || url.includes("/ajax/")) {
          parseFacebookResponseText(this.responseText || "", url, this.__fbPagePath || window.location.pathname);
        }
      } catch (_) {}
    });
    return origSend.apply(this, args);
  };

  // Active GraphQL Cursor Paginator: Runs via fetch() in MAIN world so it NEVER stops when Chrome is minimized or in another tab!
  async function paginateGraphqlDirectly(section, explicitCursor) {
    try {
      const tpl = graphqlTemplates[section] || graphqlTemplates.any;
      const cursorToUse = explicitCursor || latestCursors[section] || latestCursors.any;
      if (!tpl || !cursorToUse) return { ok: false, hasMore: false };

      const params = new URLSearchParams(tpl.bodyStr);
      const varsObj = JSON.parse(params.get("variables") || "{}");

      // Inject next cursor into all standard Relay pagination variable keys
      varsObj.cursor = cursorToUse;
      if ("after" in varsObj) varsObj.after = cursorToUse;
      if (varsObj.input && typeof varsObj.input === "object" && "cursor" in varsObj.input) {
        varsObj.input.cursor = cursorToUse;
      }
      params.set("variables", JSON.stringify(varsObj));

      const prevCursor = cursorToUse;
      const res = await origFetch("https://www.facebook.com/api/graphql/", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": tpl.friendly
        },
        body: params.toString(),
        credentials: "include"
      });

      if (!res.ok) return { ok: false, hasMore: false };
      const txt = await res.text();
      parseFacebookResponseText(txt, "https://www.facebook.com/api/graphql/", window.location.pathname + window.location.search);

      const newCursor = latestCursors[section] || latestCursors.any;
      return {
        ok: true,
        hasMore: Boolean(newCursor && newCursor !== prevCursor),
        nextCursor: newCursor
      };
    } catch (_) {
      return { ok: false, hasMore: false };
    }
  }

  async function fetchStandaloneMediaHtml(targetUrl) {
    try {
      const res = await origFetch(targetUrl, {
        method: "GET",
        headers: { "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
        credentials: "same-origin"
      });
      if (!res.ok) return { ok: false, html: "" };
      const html = await res.text();
      return { ok: true, html };
    } catch (_) {
      return { ok: false, html: "" };
    }
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== "FBSWIFT_CONTENT") return;
    const { cmd, reqId, payload } = event.data;

    if (cmd === "ENABLE_BG_SCAN_LOCK") {
      enableSafeVisibilityOverride();
      emitToContent("CMD_RESPONSE", { reqId, result: { ok: true } });
    }
    else if (cmd === "PAGINATE_GRAPHQL_DIRECT") {
      const result = await paginateGraphqlDirectly(payload.section, payload.cursor);
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_MEDIA_PAGE_HTML") {
      const result = await fetchStandaloneMediaHtml(payload.url);
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
  });
})();