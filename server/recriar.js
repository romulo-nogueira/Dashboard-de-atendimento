#!/usr/bin/env node
'use strict';
/* Refaz o banco do zero a partir de um arquivo (CSV ou XLSX), guardando todas as colunas
 * do relatório, exceto os dados que identificam o cliente.
 *
 *   node server/recriar.js relatorio.xlsx
 *
 * - O banco atual NÃO é apagado: vira um backup  opa.db.bak-AAAAMMDD-HHMMSS
 * - As configurações (mínimo de avaliações, teto do TMA, De-Para) são copiadas para o banco novo.
 * - PARE o servidor antes de rodar (no Docker: docker compose stop dashboard).
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('./db.js');
const E = require('../js/engine.js');
const P = require('../js/parser.js');

const file = process.argv[2];
if (!file) { console.error('Uso: node server/recriar.js <arquivo.csv|xlsx>'); process.exit(1); }
const DB = process.env.DB_PATH || path.join(__dirname, '..', 'storage', 'opa.db');

(async () => {
  // 1) lê o arquivo ANTES de mexer no banco: se der erro, nada muda
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const { table, kind } = await P.tableFromFile({ name: file, arrayBuffer: async () => ab });
  const res = E.canonicalize(table);
  if (res.error) throw new Error(res.error);
  (res.warnings || []).forEach(w => console.warn('Aviso:', w));

  // 2) guarda as configurações do banco antigo e move os arquivos para backup
  let kv = [], backup = null;
  if (fs.existsSync(DB)) {
    try {
      const old = new DatabaseSync(DB, { readOnly: true });
      kv = old.prepare("SELECT k, v FROM kv WHERE k IN ('settings','depara')").all().map(r => ({ ...r }));
      old.close();
    } catch (e) { console.warn('Aviso: não consegui ler as configurações do banco antigo (' + e.message + ').'); }
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    backup = `${DB}.bak-${stamp}`;
    for (const suf of ['', '-wal', '-shm']) if (fs.existsSync(DB + suf)) fs.renameSync(DB + suf, backup + suf);
  }

  // 3) cria o banco novo e carrega
  const store = new Store(DB);
  for (const r of kv) { try { store.setKV(r.k, JSON.parse(r.v)); } catch (e) { /* ignora */ } }
  const r = store.saveRows(res.rows, { replace: true, arquivo: path.basename(file) + ` (${kind}, banco refeito)` });
  console.log(`OK: banco refeito em ${DB}`);
  console.log(`  ${r.total} atendimentos gravados.`);
  console.log(`  Colunas do relatório mantidas: ${E.FIELDS.length}` + (res.extrasCols.length ? ` + extras: ${res.extrasCols.join(', ')}` : ''));
  console.log(`  Dados do cliente descartados: ${res.descartadas.length ? res.descartadas.join(', ') : '(nenhuma coluna do tipo encontrada)'}`);
  if (backup) console.log(`  Banco anterior guardado em: ${backup}`);
  if (kv.length) console.log('  Configurações (De-Para, teto do TMA...) copiadas do banco anterior.');
})().catch(e => { console.error('Erro:', e.message); process.exit(1); });
