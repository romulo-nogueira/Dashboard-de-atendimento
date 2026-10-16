#!/usr/bin/env node
'use strict';
/* Carrega um relatório (CSV ou XLSX) direto no banco, pelo terminal do servidor.
 *   node server/importar.js relatorio.xlsx                 substitui a base
 *   node server/importar.js relatorio.csv --acrescentar    junta sem duplicar (Protocolo/id)
 * Útil para automatizar com cron. Usa DB_PATH como o servidor. */
const fs = require('fs');
const path = require('path');
const { Store } = require('./db.js');
const E = require('../js/engine.js');
const P = require('../js/parser.js');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('Uso: node server/importar.js <arquivo.csv|xlsx> [--acrescentar]'); process.exit(1); }

(async () => {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const { table, kind } = await P.tableFromFile({ name: file, arrayBuffer: async () => ab });
  const res = E.canonicalize(table);
  if (res.error) { console.error('Erro:', res.error); process.exit(1); }
  (res.warnings || []).forEach(w => console.warn('Aviso:', w));
  const store = new Store(process.env.DB_PATH || path.join(__dirname, '..', 'storage', 'opa.db'));
  const r = store.saveRows(res.rows, { replace: !args.includes('--acrescentar'), arquivo: path.basename(file) + ` (${kind}, terminal)` });
  console.log(`OK: ${r.recebidas} linhas recebidas, ${r.total} no banco.`);
})().catch(e => { console.error('Erro:', e.message); process.exit(1); });
