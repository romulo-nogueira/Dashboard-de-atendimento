#!/usr/bin/env node
'use strict';
/* Carrega o cadastro de clientes (Id do Cliente -> Bairro / Condomínio / Cidade / Região).
 *   node server/importar-clientes.js cadastro.csv                 acrescenta/atualiza
 *   node server/importar-clientes.js cadastro.xlsx --substituir   apaga o cadastro e carrega este
 * Só o Id e a localização são lidos: nome, telefone, endereço etc. são descartados. */
const fs = require('fs');
const path = require('path');
const { Store } = require('./db.js');
const E = require('../js/engine.js');
const P = require('../js/parser.js');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('Uso: node server/importar-clientes.js <arquivo.csv|xlsx> [--substituir]'); process.exit(1); }
(async () => {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const { table, kind } = await P.tableFromFile({ name: file, arrayBuffer: async () => ab });
  const res = E.canonicalizeClientes(table);
  if (res.error) throw new Error(res.error);
  const store = new Store(process.env.DB_PATH || path.join(__dirname, '..', 'storage', 'opa.db'));
  const r = store.saveClientes(res.rows, { replace: args.includes('--substituir'), arquivo: path.basename(file) + ` (${kind}, terminal)` });
  console.log(`OK: ${r.recebidas} clientes recebidos, ${r.total} no cadastro.`);
  console.log(`  Colunas lidas: ${res.colunas.join(', ')}`);
  if (res.descartadas.length) console.log(`  Descartadas: ${res.descartadas.join(', ')}`);
  const st = store.status().cobertura;
  console.log(`  Atendimentos com bairro: ${st.comBairro}/${st.total} · com condomínio: ${st.comCondominio}/${st.total}`);
})().catch(e => { console.error('Erro:', e.message); process.exit(1); });
