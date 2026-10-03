var http = require('http');
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

// ============================================================
// 守护番茄镇 - 后端服务（零依赖）
// 职责：静态资源服务（gzip + ETag/304 + 缓存头）+ 数据/配置 API
// 前端静态根：../frontend；后端数据：./data；美术素材：项目根 art/
//   （art/ 按约定保留在项目根不随 frontend/ 移动，服务端对 /art/ 前缀做回退映射）
// 性能设计（零依赖约束下）：
//   - ETag = size+mtime 强校验器，命中 If-None-Match 直接 304（省重传）
//   - API 数据文件（units/map）按 mtime 失效做进程内缓存，避免每请求 readFile
//   - 文本响应的 gzip 结果按 etag 缓存（LRU：条数/总字节双上限），
//     500KB 级 JS/HTML 从"每请求 gzipSync"降为"每版本一次"
//   - Cache-Control：美术/音频/Spine 等一年 immutable；页面与 JS 走
//     no-cache + ETag 重验证（契合 sql -> 生成器 -> js 的再生成流程）
// ============================================================

var ROOT = path.join(__dirname, '..', 'frontend');
var PROJECT_ROOT = path.join(__dirname, '..');       // art/ 所在的项目根
var ART_PREFIX = '/art/';                            // 仅此前缀允许回退到项目根
var ART_ROOT = path.join(PROJECT_ROOT, 'art');       // 穿越防护边界（精确到目录）
var DATA_DIR = path.join(__dirname, 'data');
var PORT = Number(process.env.PORT) || 8080;         // 本地默认 8080，可用 PORT 环境变量覆盖

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.spine': 'application/octet-stream',
  '.asset': 'text/plain; charset=utf-8',
  '.bytes': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// 可压缩的文本类型（≤4MB 才压缩，避免大文件同步压缩阻塞）
var COMPRESSIBLE = {
  '.html': 1, '.js': 1, '.json': 1, '.css': 1,
  '.atlas': 1, '.svg': 1, '.xml': 1, '.txt': 1, '.md': 1, '.asset': 1, '.bytes': 1
};
var GZIP_MAX_BYTES = 4 * 1024 * 1024;

// 内容长期不变的静态资源（美术/音频/字体/Spine 骨架）→ 一年 immutable
var IMMUTABLE = {
  '.png': 1, '.jpg': 1, '.jpeg': 1, '.gif': 1, '.webp': 1, '.ico': 1,
  '.mp3': 1, '.ogg': 1, '.wav': 1,
  '.atlas': 1, '.skel': 1, '.spine': 1, '.bytes': 1,
  '.woff': 1, '.woff2': 1, '.ttf': 1
};

// ---------- ETag / 条件请求 ----------

// 强校验器：内容文件被生成器重写后 mtime/size 变化，ETag 随之更新。
// 已知边界：同尺寸且同毫秒内完成的重写会漏 304，本地场景可接受。
function etagFor(stat) {
  return '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
}

// If-None-Match: 按逗号拆分、去空白、兼容 W/ 弱前缀与 *
function etagMatches(headerValue, etag) {
  if (!headerValue) return false;
  var candidates = headerValue.split(',');
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i].trim();
    if (candidate === '*') return true;
    if (candidate.indexOf('W/') === 0 || candidate.indexOf('w/') === 0) candidate = candidate.slice(2);
    if (candidate === etag) return true;
  }
  return false;
}

// ---------- gzip 结果缓存（LRU：条数 ≤48 且总字节 ≤8MB） ----------

var gzipCache = new Map();          // key: etag + ext -> Buffer（已压缩）
var gzipCacheBytes = 0;
var GZIP_CACHE_MAX_ENTRIES = 48;
var GZIP_CACHE_MAX_BYTES = 8 * 1024 * 1024;

function gzipCacheGet(key) {
  var value = gzipCache.get(key);
  if (value !== undefined) {
    // Map 按插入序淘汰：重新插入刷新为最近使用
    gzipCache.delete(key);
    gzipCache.set(key, value);
  }
  return value;
}

function gzipCacheSet(key, value) {
  var previous = gzipCache.get(key);
  if (previous !== undefined) {
    gzipCacheBytes -= previous.length;
    gzipCache.delete(key);
  }
  gzipCache.set(key, value);
  gzipCacheBytes += value.length;
  while ((gzipCache.size > GZIP_CACHE_MAX_ENTRIES || gzipCacheBytes > GZIP_CACHE_MAX_BYTES) && gzipCache.size > 1) {
    var oldestKey = gzipCache.keys().next().value;
    gzipCacheBytes -= gzipCache.get(oldestKey).length;
    gzipCache.delete(oldestKey);
  }
}

function gzipOrCached(data, key) {
  if (data.length > GZIP_MAX_BYTES) return null;
  var cached = gzipCacheGet(key);
  if (cached) return cached;
  var compressed = zlib.gzipSync(data);
  gzipCacheSet(key, compressed);
  return compressed;
}

// ---------- API 数据文件缓存（mtime 失效） ----------

var apiCache = {};                  // 绝对路径 -> {mtimeMs, size, raw, etag, gzip}

function getApiData(dataFile, callback) {
  fs.stat(dataFile, function (err, stat) {
    if (err) return callback(err);
    var entry = apiCache[dataFile];
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      fs.readFile(dataFile, function (err2, raw) {
        if (err2) return callback(err2);
        entry = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          raw: raw,
          etag: etagFor(stat),
          gzip: null
        };
        apiCache[dataFile] = entry;
        callback(null, entry);
      });
      return;
    }
    callback(null, entry);
  });
}

function sendJson(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}

function handleApi(req, res, pathname, isHead) {
  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      ts: Date.now()
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }
  var dataFile = null;
  if (pathname === '/api/units') dataFile = path.join(DATA_DIR, 'units.json');
  else if (pathname === '/api/map') dataFile = path.join(DATA_DIR, 'map.json');
  if (!dataFile) {
    return sendJson(res, 404, { ok: false, error: 'unknown api: ' + pathname });
  }
  getApiData(dataFile, function (err, entry) {
    if (err) {
      return sendJson(res, 500, { ok: false, error: 'data file missing: ' + path.basename(dataFile) });
    }
    if (etagMatches(req.headers['if-none-match'], entry.etag)) {
      res.writeHead(304, { ETag: entry.etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    var headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      ETag: entry.etag
    };
    var acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (acceptsGzip) {
      if (!entry.gzip) entry.gzip = zlib.gzipSync(entry.raw);
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(200, headers);
      return res.end(isHead ? undefined : entry.gzip);
    }
    res.writeHead(200, headers);
    res.end(isHead ? undefined : entry.raw);
  });
}

http.createServer(function (req, res) {
  var isHead = req.method === 'HEAD';
  var urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  if (urlPath.lastIndexOf('/api/', 0) === 0) {
    return handleApi(req, res, urlPath, isHead);
  }

  if (req.method !== 'GET' && !isHead) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  if (urlPath.endsWith('/')) urlPath += 'index.html';

  // 解析服务根：/art/ 前缀回退到项目根（art/ 按约定留在项目根），其余一律限定在 frontend/
  var serveRoot = ROOT;
  if (urlPath.lastIndexOf(ART_PREFIX, 0) === 0) serveRoot = PROJECT_ROOT;
  var filePath = path.normalize(path.join(serveRoot, urlPath));

  // 穿越防护：解析结果必须落在允许的根内（art 需精确到 art/ 目录边界，防止 /art../backend 逃逸）
  var inFrontend = filePath.startsWith(ROOT);
  var inArt = filePath === ART_ROOT || filePath.startsWith(ART_ROOT + path.sep);
  if (!inFrontend && !inArt) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, function (err, stat) {
    var target = (!err && stat.isDirectory()) ? path.join(filePath, 'index.html') : filePath;
    var ext = path.extname(target).toLowerCase();

    // ETag 以实际响应文件（目录索引时可能是 index.html）的 stat 为准
    fs.stat(target, function (err1, targetStat) {
      if (err1) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      var etag = etagFor(targetStat);
      if (etagMatches(req.headers['if-none-match'], etag)) {
        var notModifiedHeaders = { ETag: etag };
        if (IMMUTABLE[ext]) {
          notModifiedHeaders['Cache-Control'] = 'public, max-age=31536000, immutable';
        } else {
          notModifiedHeaders['Cache-Control'] = 'no-cache';
        }
        res.writeHead(304, notModifiedHeaders);
        return res.end();
      }

      fs.readFile(target, function (err2, data) {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('404 Not Found');
        }

        var headers = {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          ETag: etag
        };

        // 缓存策略：美术/音频/Spine 资源一年 immutable；页面与 js 实时校验
        if (IMMUTABLE[ext]) {
          headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        } else {
          headers['Cache-Control'] = 'no-cache';
        }

        // gzip：仅文本类型且 ≤4MB，且客户端支持；结果按 etag 缓存，同版本只压缩一次
        var acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
        if (acceptsGzip && COMPRESSIBLE[ext]) {
          var compressed = gzipOrCached(data, etag + ':' + ext);
          if (compressed) {
            headers['Content-Encoding'] = 'gzip';
            headers['Vary'] = 'Accept-Encoding';
            res.writeHead(200, headers);
            return res.end(isHead ? undefined : compressed);
          }
        }

        res.writeHead(200, headers);
        res.end(isHead ? undefined : data);
      });
    });
  });
}).listen(PORT, '127.0.0.1', function () {
  console.log('Backend server running at http://127.0.0.1:' + PORT + '/');
  console.log('  static root: ' + ROOT);
  console.log('  art fallback: ' + ART_ROOT + ' (' + ART_PREFIX + '* only)');
  console.log('  api: /api/health, /api/units, /api/map');
  console.log('  features: ETag/304, api cache, gzip LRU');
});
