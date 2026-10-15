/* Leitura de CSV / TSV / XLSX e escrita de CSV — sem dependências. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OPAParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- texto ---------- */
  function decodeBuffer(buf) {
    const u8 = new Uint8Array(buf);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
    catch (e) { return new TextDecoder('windows-1252').decode(u8); }
  }

  function detectDelimiter(text) {
    const head = text.slice(0, 5000);
    let inQ = false, line = '';
    for (const ch of head) {
      if (ch === '"') inQ = !inQ;
      if (!inQ && (ch === '\n' || ch === '\r')) break;
      line += ch;
    }
    let best = ',', bn = -1;
    for (const d of [',', ';', '\t']) {
      let n = 0, q = false;
      for (const ch of line) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
      if (n > bn) { bn = n; best = d; }
    }
    return best;
  }

  // CSV (RFC 4180) -> matriz de strings
  function parseCSV(text, delimiter) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const d = delimiter || detectDelimiter(text);
    const rows = [];
    let row = [], f = '', q = false;
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { f += '"'; i++; } else q = false;
        } else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === d) { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = '';
        rows.push(row); row = [];
      } else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",;\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function rowsToCSV(rows, fields, headers) {
    const out = [fields.map(f => csvCell(headers[f])).join(',')];
    for (const r of rows) out.push(fields.map(f => csvCell(r[f])).join(','));
    return '\ufeff' + out.join('\r\n') + '\r\n';
  }

  /* ---------- XLSX (zip + xml, sem bibliotecas) ---------- */
  async function inflateRaw(u8) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf.buffer ? buf.buffer : buf);
    let e = u8.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('Arquivo XLSX inválido (não é um zip).');
    const count = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    const files = {};
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      files[name] = { method, csize, lho };
      p += 46 + nlen + xlen + clen;
    }
    async function read(name) {
      const f = files[name];
      if (!f) return null;
      const nl = dv.getUint16(f.lho + 26, true), xl = dv.getUint16(f.lho + 28, true);
      const start = f.lho + 30 + nl + xl;
      const data = u8.subarray(start, start + f.csize);
      const raw = f.method === 0 ? data : await inflateRaw(data);
      return dec.decode(raw);
    }
    return { names: Object.keys(files), read };
  }

  const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

  function colIndex(ref) {
    const m = ref.match(/^([A-Z]+)/); let n = 0;
    for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
  }

  function isDateFormat(id, custom) {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    const f = custom[id];
    if (!f) return false;
    return /[dmyh]/i.test(f.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, ''));
  }

  function serialToISO(n) {
    const ms = Math.round((n - 25569) * 86400000 / 60000) * 60000;
    const d = new Date(ms), p = x => String(x).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  async function readXLSX(buffer) {
    const z = await unzip(buffer);
    const wb = await z.read('xl/workbook.xml');
    if (!wb) throw new Error('Arquivo XLSX inválido (sem workbook).');
    const rels = (await z.read('xl/_rels/workbook.xml.rels')) || '';
    const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => ({
      name: unxml((m[0].match(/name="([^"]*)"/) || [])[1] || ''),
      rid: (m[0].match(/r:id="([^"]*)"/) || [])[1]
    }));
    const relMap = {};
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = (m[0].match(/\bId="([^"]*)"/) || [])[1], tg = (m[0].match(/Target="([^"]*)"/) || [])[1];
      if (id && tg) relMap[id] = tg.startsWith('/') ? tg.slice(1) : 'xl/' + tg;
    }
    const shared = [];
    const ss = await z.read('xl/sharedStrings.xml');
    if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
    }
    const custom = {}, xfDate = [];
    const st = await z.read('xl/styles.xml');
    if (st) {
      for (const m of st.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) custom[+m[1]] = unxml(m[2]);
      const cx = st.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
      if (cx) for (const m of cx[1].matchAll(/<xf\b[^>]*>/g)) {
        const id = +((m[0].match(/numFmtId="(\d+)"/) || [])[1] || 0);
        xfDate.push(isDateFormat(id, custom));
      }
    }
    // escolhe a aba "Dados" se existir; senão a primeira
    const pick = sheets.find(s => /^dados$/i.test(s.name)) || sheets[0];
    const path = relMap[pick.rid] || 'xl/worksheets/sheet1.xml';
    const xml = await z.read(path);
    if (!xml) throw new Error('Não consegui abrir a aba do arquivo XLSX.');
    const out = [];
    for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNum = +((rm[0].match(/\br="(\d+)"/) || [])[1] || out.length + 1);
      const arr = [];
      if (rm[1]) for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1], body = cm[2] || '';
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        const t = (attrs.match(/\bt="(\w+)"/) || [])[1];
        const s = +((attrs.match(/\bs="(\d+)"/) || [])[1] || 0);
        let val = '';
        const v = body.match(/<v>([\s\S]*?)<\/v>/);
        if (t === 's' && v) val = shared[+v[1]] || '';
        else if (t === 'inlineStr') val = unxml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
        else if (t === 'str' || t === 'e') val = v ? unxml(v[1]) : '';
        else if (t === 'b') val = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
        else if (v) {
          const num = parseFloat(v[1]);
          val = xfDate[s] && isFinite(num) ? serialToISO(num) : v[1];
        }
        if (ref) arr[colIndex(ref)] = val;
      }
      for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = '';
      out[rowNum - 1] = arr;
    }
    for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = [];
    return out;
  }

  /* ---------- entrada genérica ---------- */
  async function tableFromFile(file) {
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf, 0, 4);
    const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
    if (isZip || /\.xlsx$/i.test(file.name)) return { table: await readXLSX(buf), kind: 'XLSX' };
    if (/\.xls$/i.test(file.name)) throw new Error('Arquivos .xls antigos não são suportados. Salve como .xlsx ou .csv.');
    return { table: parseCSV(decodeBuffer(buf)), kind: 'CSV' };
  }
  const tableFromText = text => ({ table: parseCSV(text), kind: 'texto colado' });

  return { parseCSV, readXLSX, rowsToCSV, decodeBuffer, tableFromFile, tableFromText, detectDelimiter };
});
