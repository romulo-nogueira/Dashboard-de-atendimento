'use strict';
/* Servidor do Dashboard: serve o site e a API que lê/grava no banco SQLite.
 *
 * Variáveis de ambiente:
 *   ADMIN_PASSWORD  (obrigatória para gravar) senha de quem atualiza dados e configurações
 *   VIEW_PASSWORD   (opcional) se definida, o site inteiro pede essa senha para ser aberto
 *   DB_PATH         caminho do arquivo do banco (padrão: ./storage/opa.db)
 *   PORT            porta (padrão 3000)
 *   TRUST_PROXY=1   use atrás de proxy/HTTPS (lê X-Forwarded-For / X-Forwarded-Proto)
 *   MAX_UPLOAD_MB   limite de cada envio (padrão 50)
 *   SEED_FROM_DATA=0  não carrega data/*.csv no primeiro start
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Store, ALL_COLS } = require('./db.js');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'storage', 'opa.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const VIEW_PASSWORD = process.env.VIEW_PASSWORD || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_BODY = (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024;

const store = new Store(DB_PATH);
const seeded = store.seedIfEmpty(ROOT);
if (store.migrado && store.migrado.length) console.warn(`Banco atualizado: colunas novas (${store.migrado.join(', ')}) ficaram vazias nas linhas antigas. Para preenchê-las, recarregue o arquivo original: node server/recriar.js <arquivo>`);

/* ---------- utilitários ---------- */
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const httpErr = (status, message) => Object.assign(new Error(message), { status });

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}
// limite simples contra tentativa de adivinhar senha: 10 erros / 10 min por IP
const fails = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (v.t < now) fails.delete(k); }, 60000).unref();
const blocked = ip => { const f = fails.get(ip); return !!f && f.t > Date.now() && f.n >= 10; };
const addFail = ip => { const f = fails.get(ip); if (f && f.t > Date.now()) f.n++; else fails.set(ip, { n: 1, t: Date.now() + 600000 }); };

function isAdmin(req) {
  const p = req.headers['x-admin-password'];
  return !!ADMIN_PASSWORD && typeof p === 'string' && safeEq(p, ADMIN_PASSWORD);
}
function viewOk(req) {
  if (!VIEW_PASSWORD) return true;
  if (isAdmin(req)) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const pass = dec.slice(dec.indexOf(':') + 1);
  return safeEq(pass, VIEW_PASSWORD);
}
function requireAdmin(req) {
  const ip = clientIp(req);
  if (!ADMIN_PASSWORD) throw httpErr(403, 'Gravação desativada: defina a variável ADMIN_PASSWORD no servidor.');
  if (blocked(ip)) throw httpErr(429, 'Muitas tentativas. Aguarde alguns minutos.');
  if (!isAdmin(req)) { addFail(ip); throw httpErr(401, 'Senha de administrador incorreta.'); }
}

function headers(req, extra) {
  const h = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
    ...extra
  };
  if (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') h['Strict-Transport-Security'] = 'max-age=15552000';
  return h;
}

function send(req, res, status, body, extra) {
  const h = headers(req, extra);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { ...h, 'Content-Length': buf.length });
  res.end(req.method === 'HEAD' ? undefined : buf);
}
function sendJSON(req, res, status, obj, extra) {
  send(req, res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
}
function readJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpErr(413, `Arquivo maior que o limite de ${Math.round(MAX_BODY / 1048576)} MB.`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(httpErr(400, 'JSON inválido.')); } });
    req.on('error', reject);
  });
}

/* ---------- cache da base serializada (gzip) por versão ---------- */
let cache = { version: -1, raw: null, gz: null };
function dadosPayload() {
  const st = store.status();
  if (cache.version !== st.version || !cache.raw) {
    const raw = Buffer.from(JSON.stringify({ version: st.version, updatedAt: st.updatedAt, total: st.total, fields: ALL_COLS, rows: store.allRows() }));
    cache = { version: st.version, raw, gz: zlib.gzipSync(raw, { level: 6 }) };
  }
  return { cache, version: st.version };
}

/* ---------- rotas da API ---------- */
async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  switch (route) {
    case 'GET /api/status':
      return sendJSON(req, res, 200, { ...store.status(), canWrite: !!ADMIN_PASSWORD });
    case 'GET /api/dados': {
      const { cache: c, version } = dadosPayload();
      const etag = `"v${version}"`;
      if (req.headers['if-none-match'] === etag) return send(req, res, 304, '', { ETag: etag, 'Cache-Control': 'no-cache' });
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      return send(req, res, 200, gz ? c.gz : c.raw, {
        'Content-Type': 'application/json; charset=utf-8', ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {})
      });
    }
    case 'GET /api/config':
      return sendJSON(req, res, 200, store.getConfig());
    case 'GET /api/admin/check':
      requireAdmin(req);
      return sendJSON(req, res, 200, { ok: true });
    case 'POST /api/dados': {
      requireAdmin(req);
      const body = await readJSON(req);
      if (!Array.isArray(body.rows)) throw httpErr(400, 'Envie { modo, arquivo, rows: [...] }.');
      if (!['substituir', 'acrescentar'].includes(body.modo)) throw httpErr(400, 'modo deve ser "substituir" ou "acrescentar".');
      const r = store.saveRows(body.rows, { replace: body.modo === 'substituir', arquivo: body.arquivo });
      console.log(`[${new Date().toISOString()}] carga ${body.modo}: ${r.recebidas} linhas (${r.total} no banco) · ${body.arquivo || ''}`);
      return sendJSON(req, res, 200, { ok: true, ...r });
    }
    case 'POST /api/clientes': {
      requireAdmin(req);
      const body = await readJSON(req);
      if (!Array.isArray(body.rows)) throw httpErr(400, 'Envie { modo, arquivo, rows: [...] }.');
      if (!['substituir', 'acrescentar'].includes(body.modo)) throw httpErr(400, 'modo deve ser "substituir" ou "acrescentar".');
      const r = store.saveClientes(body.rows, { replace: body.modo === 'substituir', arquivo: body.arquivo });
      console.log(`[${new Date().toISOString()}] cadastro de clientes ${body.modo}: ${r.recebidas} clientes (${r.total} no cadastro) · ${body.arquivo || ''}`);
      return sendJSON(req, res, 200, { ok: true, ...r });
    }
    case 'PUT /api/config': {
      requireAdmin(req);
      const body = await readJSON(req);
      return sendJSON(req, res, 200, { ok: true, ...store.saveConfig(body) });
    }
    default:
      throw httpErr(404, 'Rota não encontrada.');
  }
}

/* ---------- arquivos estáticos (lista permitida) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const allowed = p === '/index.html' || p === '/robots.txt' || p.startsWith('/css/') || p.startsWith('/js/');
  const file = path.normalize(path.join(ROOT, p));
  if (!allowed || !file.startsWith(ROOT + path.sep) || path.basename(file).startsWith('.')) throw httpErr(404, 'Não encontrado.');
  let st;
  try { st = fs.statSync(file); } catch (e) { throw httpErr(404, 'Não encontrado.'); }
  if (!st.isFile()) throw httpErr(404, 'Não encontrado.');
  const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) return send(req, res, 304, '', { ETag: etag });
  send(req, res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ETag: etag, 'Cache-Control': 'no-cache' });
}

/* ---------- servidor ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return send(req, res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (!viewOk(req)) {
      const ip = clientIp(req);
      if (blocked(ip)) throw httpErr(429, 'Muitas tentativas. Aguarde alguns minutos.');
      if (req.headers.authorization) addFail(ip);
      return send(req, res, 401, 'Acesso restrito.', { 'WWW-Authenticate': 'Basic realm="Dashboard de Atendimentos", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw httpErr(405, 'Método não permitido.');
    serveStatic(req, res, url);
  } catch (e) {
    if (e.status) return sendJSON(req, res, e.status, { erro: e.message });
    console.error(e);
    sendJSON(req, res, 500, { erro: 'Erro interno do servidor.' });
  }
});

server.listen(PORT, () => {
  const st = store.status();
  console.log(`Dashboard no ar: http://localhost:${PORT}`);
  console.log(`Banco: ${DB_PATH} · ${st.total} atendimentos${seeded.rows ? ' (carga inicial de data/atendimentos.csv)' : ''}`);
  if (!ADMIN_PASSWORD) console.warn('ATENÇÃO: ADMIN_PASSWORD não definida. O painel funciona, mas ninguém consegue atualizar os dados.');
  if (!VIEW_PASSWORD) console.warn('Aviso: VIEW_PASSWORD não definida. Qualquer pessoa com o link vê o painel.');
});
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }));
