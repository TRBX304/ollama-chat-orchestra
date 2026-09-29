const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
// "localhost" だとWindowsでIPv6(::1)を先に試して失敗するケースがあるため
// 127.0.0.1 を明示的に指定する（"socket hang up" の典型的な原因の一つ）
const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;

// Ollamaへの接続専用のkeep-alive Agent
// (デフォルトのグローバルAgentは同時接続数が限られており、
//  ストリーミング応答が複数同時に走るとソケットを使い切って
//  以降のリクエストが詰まる = 「定期的にプロキシが止まる」の主因になりうる)
const ollamaAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
});

// /ollama/* で許可するエンドポイントのホワイトリスト
// api/delete, api/pull, api/create, api/push 等の破壊的・重い操作はデフォルト禁止
const OLLAMA_ALLOWED_PREFIXES = [
  "/api/generate",
  "/api/chat",
  "/api/tags",
  "/api/show",
  "/api/embeddings",
  "/api/embed",
  "/api/ps",
];

// 静的配信を許可する拡張子のホワイトリスト
const ALLOWED_STATIC_EXTENSIONS = new Set([
  ".html", ".js", ".css", ".json", ".jsonl", ".md", ".png", ".jpg", ".jpeg",
  ".gif", ".svg", ".ico", ".webp", ".woff", ".woff2", ".txt", ".webmanifest",
]);

// ── アクセスログ設定 ──
// リクエスト/レスポンスの本文(チャット内容そのもの)はログに含めない。
// あくまで「誰が・いつ・どのエンドポイントに・どのくらいの時間で」アクセスしたかのメタ情報のみ記録する。
const LOG_DIR = path.join(__dirname, "logs");
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  console.error("ログディレクトリの作成に失敗しました:", err.message);
}

function todayLogFilePath() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return path.join(LOG_DIR, `access-${y}-${m}-${d}.log`);
}

function getClientIp(req) {
  // ngrok等のリバースプロキシ越しの場合、実クライアントIPは X-Forwarded-For に入る
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "-";
}

// ── コンソール表示用の色付け(ファイルには色コードを書き込まない) ──
const ANSI = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function colorForStatus(statusCode) {
  if (statusCode === "ABORTED") return ANSI.gray;
  if (statusCode >= 500) return ANSI.red;
  if (statusCode >= 400) return ANSI.yellow;
  if (statusCode >= 300) return ANSI.cyan;
  return ANSI.green;
}

function colorForMethod(method) {
  switch (method) {
    case "GET": return ANSI.cyan;
    case "POST": return ANSI.magenta;
    default: return ANSI.gray;
  }
}

function logAccess({ req, statusCode, durationMs }) {
  const timestamp = new Date().toISOString();
  const ip = getClientIp(req);
  const method = req.method;
  const url = req.url;
  const ua = req.headers["user-agent"] || "-";

  // ファイル用: 色コードなしのプレーンテキスト
  const plainLine = `[${timestamp}] ${ip} ${method} ${url} ${statusCode} ${durationMs}ms UA:"${ua}"`;

  // コンソール用: ステータスコード/メソッドに応じて色付け
  const statusColor = colorForStatus(statusCode);
  const methodColor = colorForMethod(method);
  const consoleLine =
    `${ANSI.gray}[${timestamp}]${ANSI.reset} ` +
    `${ip} ` +
    `${methodColor}${method}${ANSI.reset} ` +
    `${url} ` +
    `${statusColor}${statusCode}${ANSI.reset} ` +
    `${ANSI.gray}${durationMs}ms${ANSI.reset}`;

  console.log(consoleLine);

  fs.appendFile(todayLogFilePath(), plainLine + "\n", (err) => {
    if (err) {
      console.error("アクセスログの書き込みに失敗しました:", err.message);
    }
  });
}

const server = http.createServer((req, res) => {
  const startTime = Date.now();
  let logged = false;
  const finalizeLog = (statusCodeOverride) => {
    if (logged) return;
    logged = true;
    logAccess({
      req,
      statusCode: statusCodeOverride ?? res.statusCode,
      durationMs: Date.now() - startTime,
    });
  };
  res.once("finish", () => finalizeLog());
  res.once("close", () => {
    // finish が発火せずに close だけ発火した = クライアント側の途中切断
    if (!logged) finalizeLog("ABORTED");
  });

  // ── CORS headers (ngrok経由のアクセスに対応) ──
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── 静的ファイル配信 ──
  if (req.method === "GET" && !req.url.startsWith("/ollama/")) {
    // URLからクエリ文字列を除去
    const urlPath = req.url.split("?")[0];

    // / または /index.html はチャットページ
    let filePath;
    if (urlPath === "/" || urlPath === "/index.html") {
      filePath = path.join(__dirname, "index.html");
    } else {
      // パストラバーサル対策: __dirname の外に出ないようにする
      const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, "");
      filePath = path.join(__dirname, safePath);
    }

    // __dirname の外に実際に出ていないか、resolveベースで二重チェック
    // (path.normalize + path.join の組み合わせに依存しすぎない防御を明示的に入れる)
    const rootResolved = path.resolve(__dirname);
    const targetResolved = path.resolve(filePath);
    if (
      targetResolved !== rootResolved &&
      !targetResolved.startsWith(rootResolved + path.sep)
    ) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("403 Forbidden");
      return;
    }

    // ディレクトリの場合は index.html を探す
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
    } catch (_) {
      // ファイルが存在しない場合は後続の処理で404
    }

    // サーバーのソースコード自身やdotfile(.env等)、許可外拡張子は配信しない
    const requestedExt = path.extname(filePath).toLowerCase();
    const requestedBasename = path.basename(filePath);
    if (
      requestedBasename === "server.js" ||
      requestedBasename.startsWith(".") ||
      !ALLOWED_STATIC_EXTENSIONS.has(requestedExt)
    ) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("403 Forbidden");
      return;
    }

    // MIMEタイプの判定
    const mimeTypes = {
      ".html": "text/html; charset=utf-8",
      ".js":   "application/javascript; charset=utf-8",
      ".css":  "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png":  "image/png",
      ".jpg":  "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif":  "image/gif",
      ".svg":  "image/svg+xml",
      ".ico":  "image/x-icon",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2":"font/woff2",
      ".txt":  "text/plain; charset=utf-8",
      ".webmanifest": "application/manifest+json",
    };
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || "application/octet-stream";

    try {
      const file = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(file);
    } catch (_) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
    }
    return;
  }

  // ── Ollama API プロキシ (/ollama/* → localhost:11434/*) ──
  if (req.url.startsWith("/ollama/")) {
    const ollamaPath = req.url.replace("/ollama/", "/");
    const ollamaPathOnly = ollamaPath.split("?")[0];

    // 破壊的操作(削除・pull・create等)をホワイトリスト外として拒否
    const isAllowedOllamaEndpoint = OLLAMA_ALLOWED_PREFIXES.some((prefix) =>
      ollamaPathOnly.startsWith(prefix)
    );
    if (!isAllowedOllamaEndpoint) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "このエンドポイントへのアクセスは許可されていません" }));
      return;
    }

    const headers = {
      "Content-Type": req.headers["content-type"] || "application/json",
      "host": `${OLLAMA_HOST}:${OLLAMA_PORT}`,
      // origin を渡さない → Ollama の OLLAMA_ORIGINS チェックを回避
    };
    // Content-Length は存在する場合のみ設定（undefinedを渡すとエラーになる）
    if (req.headers["content-length"]) {
      headers["Content-Length"] = req.headers["content-length"];
    }

    const options = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: ollamaPath,
      method: req.method,
      headers,
      agent: ollamaAgent, // keep-alive専用Agent。ソケット枯渇によるプロキシ詰まり対策
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        "Content-Type": proxyRes.headers["content-type"] || "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",  // ngrokのバッファリングを無効化してストリーミングをリアルタイムに
      });
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error("Ollama proxy error:", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Ollama に接続できません: " + err.message }));
      } else {
        res.end();
      }
    });

    // クライアント側が"実際に"切断した場合だけ、Ollama側への接続も破棄する。
    // 注意点1: req/res の 'close' はストリームの読み書きが完了しただけでも発火するため、
    //          実ソケットの close だけを見て「本当の切断」だけを検知する。
    // 注意点2: keep-alive接続では同じソケットが複数リクエストで使い回されるため、
    //          リスナーを付けっぱなしにすると MaxListenersExceededWarning が出る。
    //          レスポンス完了時に必ずリスナーを取り外す。
    const onClientSocketClose = () => {
      if (!proxyReq.destroyed) proxyReq.destroy();
    };
    req.socket.once("close", onClientSocketClose);
    res.once("close", () => {
      req.socket.removeListener("close", onClientSocketClose);
    });

    req.pipe(proxyReq);
    return;
  }

  // ── 404 ──
  res.writeHead(404);
  res.end("Not found");
});

// 長時間のストリーミング生成を考慮してkeep-aliveタイムアウトを調整
server.keepAliveTimeout = 65000; // ロードバランサ/ngrok越しでもソケットを維持しやすくする

server.listen(PORT, () => {
  console.log(`Ollama Chat running on http://localhost:${PORT}`);
  console.log(`Ollama proxy: http://localhost:${PORT}/ollama/ → http://localhost:${OLLAMA_PORT}/`);
});
