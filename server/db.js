'use strict';
/* Camada de armazenamento (SQLite embutido no Node 22+, sem dependências). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const E = require('../js/engine.js');
const P = require('../js/parser.js');

const FIELDS = E.FIELDS;
const GEO = E.GEO_FIELDS;
const CLI_FIELDS = E.CLI_FIELDS;           // idCliente + bairro, condominio, cidade, regiao
const ALL_COLS = [...FIELDS, 'extras'];   // extras = JSON com colunas novas que o painel ainda não conhece
if (process.env.COLUNAS_SENSIVEIS) E.addSensitive(process.env.COLUNAS_SENSIVEIS.split(',').map(x => x.trim()).filter(Boolean));
const DATE_FIELDS = ['abertoEm', 'assumidoEm', 'encerradoEm'];
const MAX_LEN = { motivos: 1000 };

function sanitizeRow(r) {
  const o = {};
  let any = false;
  for (const f of FIELDS) {
    let v = r && r[f] != null ? String(r[f]).trim() : '';
    if (v === '-') v = '';
    if (DATE_FIELDS.includes(f) && v) { const t = E.parseDate(v); if (t != null) v = E.fmtISO(t); }
    v = v.slice(0, MAX_LEN[f] || 300);
    o[f] = v;
    if (v) any = true;
  }
  // colunas extras: mantidas, exceto as que parecem dados do cliente (o servidor também filtra)
  const ex = {};
  if (r && r.extras && typeof r.extras === 'object') {
    for (const [k, val] of Object.entries(r.extras)) {
      const v = val == null ? '' : String(val).trim().slice(0, 500);
      if (v && !E.isSensitiveHeader(k)) ex[String(k).slice(0, 100)] = v;
    }
  }
  o.extras = Object.keys(ex).length ? JSON.stringify(ex).slice(0, 5000) : '';
  // precisa de canal ou de alguma data para ser um atendimento
  return any && (o.canal || o.assumidoEm || o.abertoEm) ? o : null;
}

function rowKey(o) {
  if (o.protocolo) return 'p:' + o.protocolo;
  if (o.id) return 'i:' + o.id;
  return 'h:' + crypto.createHash('sha1').update(FIELDS.map(f => o[f]).join('\u0001')).digest('hex');
}

class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS atendimentos (
        k TEXT PRIMARY KEY,
        ${ALL_COLS.map(f => f + ' TEXT').join(', ')}
      );
      CREATE INDEX IF NOT EXISTS idx_assumido ON atendimentos(assumidoEm);
      CREATE TABLE IF NOT EXISTS clientes (
        idCliente TEXT PRIMARY KEY, ${GEO.map(g => g + ' TEXT').join(', ')}
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS cargas (
        id INTEGER PRIMARY KEY AUTOINCREMENT, em TEXT, arquivo TEXT, modo TEXT,
        linhas_recebidas INTEGER, total_apos INTEGER
      );`);
    // Bancos criados por versões anteriores: acrescenta as colunas que faltam (não apaga nada)
    const have = new Set(this.db.prepare('PRAGMA table_info(atendimentos)').all().map(c => c.name));
    const falta = ALL_COLS.filter(c => !have.has(c));
    for (const c of falta) this.db.exec(`ALTER TABLE atendimentos ADD COLUMN ${c} TEXT`);
    this.migrado = falta;
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_cliente ON atendimentos(idCliente)');
    this.insCli = this.db.prepare(`INSERT INTO clientes (idCliente, ${GEO.join(', ')}) VALUES (?, ${GEO.map(() => '?').join(', ')})
      ON CONFLICT(idCliente) DO UPDATE SET ${GEO.map(g => `${g} = COALESCE(NULLIF(excluded.${g}, ''), clientes.${g})`).join(', ')}`);
    this.ins = this.db.prepare(`INSERT OR REPLACE INTO atendimentos (k, ${ALL_COLS.join(', ')}) VALUES (?, ${ALL_COLS.map(() => '?').join(', ')})`);
  }

  count() { return this.db.prepare('SELECT COUNT(*) AS n FROM atendimentos').get().n; }

  getKV(k, def) {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    if (!r) return def;
    try { return JSON.parse(r.v); } catch (e) { return def; }
  }
  setKV(k, v) { this.db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, JSON.stringify(v)); }

  touch() {
    const version = (this.getKV('version', 0) || 0) + 1;
    this.setKV('version', version);
    this.setKV('updatedAt', new Date().toISOString());
    return version;
  }

  /** replace=true apaga tudo antes; senão acrescenta/atualiza pela chave (Protocolo, id ou hash da linha). */
  saveRows(rows, { replace, arquivo }) {
    const clean = [];
    for (const r of rows) { const o = sanitizeRow(r); if (o) clean.push(o); }
    if (replace && !clean.length) throw Object.assign(new Error('Nenhuma linha válida no arquivo: o banco não foi alterado.'), { status: 400 });
    this.db.exec('BEGIN');
    try {
      if (replace) this.db.exec('DELETE FROM atendimentos');
      for (const o of clean) this.ins.run(rowKey(o), ...ALL_COLS.map(f => o[f]));
      const total = this.count();
      this.touch();
      this.db.prepare('INSERT INTO cargas (em, arquivo, modo, linhas_recebidas, total_apos) VALUES (?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), String(arquivo || '').slice(0, 200), replace ? 'substituir' : 'acrescentar', clean.length, total);
      this.db.exec('COMMIT');
      return { recebidas: clean.length, ignoradas: rows.length - clean.length, total };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Base completa; bairro/condomínio/cidade/região vazios no atendimento são completados pelo cadastro de clientes (pelo Id). */
  allRows() {
    const sel = ALL_COLS.map(f => GEO.includes(f) ? `COALESCE(NULLIF(a.${f}, ''), c.${f}, '') AS ${f}` : `a.${f} AS ${f}`).join(', ');
    return this.db.prepare(`SELECT ${sel} FROM atendimentos a LEFT JOIN clientes c ON c.idCliente = a.idCliente AND a.idCliente <> ''
      ORDER BY COALESCE(NULLIF(a.assumidoEm, ''), a.abertoEm), a.k`).all().map(r => ALL_COLS.map(f => r[f]));
  }

  /** Cadastro de clientes: só Id + localização. Qualquer outro campo é ignorado. */
  saveClientes(rows, { replace, arquivo }) {
    const clean = [];
    for (const r of rows) {
      const id = String(r && r.idCliente != null ? r.idCliente : '').trim().slice(0, 100);
      if (!id) continue;
      const o = { idCliente: id };
      let any = false;
      for (const g of GEO) { o[g] = String(r[g] != null ? r[g] : '').trim().slice(0, 200); if (o[g]) any = true; }
      if (any) clean.push(o);
    }
    if (!clean.length) throw Object.assign(new Error('Nenhum cliente com Id e localização no arquivo: o banco não foi alterado.'), { status: 400 });
    this.db.exec('BEGIN');
    try {
      if (replace) this.db.exec('DELETE FROM clientes');
      for (const o of clean) this.insCli.run(o.idCliente, ...GEO.map(g => o[g]));
      const total = this.db.prepare('SELECT COUNT(*) AS n FROM clientes').get().n;
      this.touch();
      this.db.prepare('INSERT INTO cargas (em, arquivo, modo, linhas_recebidas, total_apos) VALUES (?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), String(arquivo || '').slice(0, 200), replace ? 'cadastro: substituir' : 'cadastro: acrescentar', clean.length, total);
      this.db.exec('COMMIT');
      return { recebidas: clean.length, ignoradas: rows.length - clean.length, total };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  status() {
    const m = this.db.prepare(`SELECT COUNT(*) AS total, MIN(COALESCE(NULLIF(assumidoEm, ''), abertoEm)) AS first,
      MAX(COALESCE(NULLIF(assumidoEm, ''), abertoEm)) AS last FROM atendimentos`).get();
    const g = this.db.prepare(`SELECT COUNT(*) AS n,
        SUM(CASE WHEN a.idCliente <> '' THEN 1 ELSE 0 END) AS comId,
        SUM(CASE WHEN COALESCE(NULLIF(a.bairro, ''), c.bairro, '') <> '' THEN 1 ELSE 0 END) AS comBairro,
        SUM(CASE WHEN COALESCE(NULLIF(a.condominio, ''), c.condominio, '') <> '' THEN 1 ELSE 0 END) AS comCondominio
        FROM atendimentos a LEFT JOIN clientes c ON c.idCliente = a.idCliente AND a.idCliente <> ''`).get();
    return {
      clientes: this.db.prepare('SELECT COUNT(*) AS n FROM clientes').get().n,
      cobertura: { total: g.n, comId: g.comId || 0, comBairro: g.comBairro || 0, comCondominio: g.comCondominio || 0 },
      total: m.total, first: m.first || null, last: m.last || null,
      version: this.getKV('version', 0), configVersion: this.getKV('configVersion', 0), updatedAt: this.getKV('updatedAt', null),
      cargas: this.db.prepare('SELECT em, arquivo, modo, linhas_recebidas AS recebidas, total_apos AS total FROM cargas ORDER BY id DESC LIMIT 8').all().map(r => ({ ...r }))
    };
  }

  getConfig() {
    return { settings: this.getKV('settings', {}), depara: this.getKV('depara', []), version: this.getKV('configVersion', 0) };
  }
  saveConfig({ settings, depara }) {
    const s = {};
    if (settings && typeof settings === 'object') {
      const min = Number(settings.minAval), tma = Number(settings.tmaMaxH);
      if (isFinite(min) && min >= 1 && min <= 1000) s.minAval = Math.round(min);
      if (isFinite(tma) && tma >= 0 && tma <= 720) s.tmaMaxH = tma;
    }
    const d = [];
    if (Array.isArray(depara)) {
      if (depara.length > 5000) throw Object.assign(new Error('De-Para grande demais.'), { status: 400 });
      for (const it of depara) {
        const key = E.motivoKey(it && it.key != null ? it.key : ''), padrao = String(it && it.padrao != null ? it.padrao : '').trim().slice(0, 200);
        if (key && padrao) d.push({ key: key.slice(0, 300), padrao });
      }
    }
    this.setKV('settings', s); this.setKV('depara', d);
    this.setKV('configVersion', (this.getKV('configVersion', 0) || 0) + 1);
    return { settings: s, depara: d };
  }

  /** Primeira execução: carrega data/atendimentos.csv e data/depara_motivos.csv, se existirem. */
  seedIfEmpty(root) {
    const out = { rows: 0, depara: 0 };
    if (process.env.SEED_FROM_DATA === '0') return out;
    try {
      const f = path.join(root, 'data', 'atendimentos.csv');
      if (this.count() === 0 && fs.existsSync(f)) {
        const res = E.canonicalize(P.parseCSV(P.decodeBuffer(fs.readFileSync(f))));
        if (!res.error && res.rows.length) out.rows = this.saveRows(res.rows, { replace: true, arquivo: 'data/atendimentos.csv (carga inicial)' }).total;
      }
      const d = path.join(root, 'data', 'depara_motivos.csv');
      if (!this.getKV('depara', null) && fs.existsSync(d)) {
        const list = P.parseCSV(P.decodeBuffer(fs.readFileSync(d))).slice(1).filter(r => r[0] && r[1]).map(r => ({ key: r[0], padrao: r[1] }));
        this.saveConfig({ settings: this.getKV('settings', {}), depara: list });
        out.depara = list.length;
      }
    } catch (e) { console.error('Falha na carga inicial:', e.message); }
    return out;
  }
}

module.exports = { Store, sanitizeRow, rowKey, FIELDS, ALL_COLS };
