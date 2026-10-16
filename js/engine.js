/* Motor de cálculo do Dashboard OPA — sem dependências.
 * Reproduz as regras da planilha (abas Atendimentos / Período / Calculos).
 * Funciona no navegador (window.OPAEngine) e no Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OPAEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TURNOS = ['Madrugada', 'Manhã', 'Tarde', 'Noite'];
  const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const DAY = 86400000;
  const NOTAS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

  const strip = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normKey = s => strip(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const pad = n => String(n).padStart(2, '0');

  /* ---------- colunas do relatório exportado ---------- */
  const ALIASES = {
    id: ['id'],
    protocolo: ['protocolo'],
    status: ['status'],
    canal: ['canal'],
    atendente: ['ultimo atendente', 'atendente'],
    departamento: ['ultimo departamento', 'departamento'],
    motivos: ['motivos do atendimento', 'motivos', 'motivo'],
    abertoEm: ['aberto em'],
    assumidoEm: ['assumido em'],
    encerradoEm: ['encerrado em'],
    avaliacao: ['avaliacao', 'avaliacao do cliente', 'nota'],
    tempoAtendimento: ['tempo em atendimento'],
    tempoEspera: ['tempo em espera'],
    // colunas guardadas para análises futuras (não entram nos cálculos atuais)
    etiquetas: ['etiquetas do atendimento', 'etiquetas'],
    abertoPor: ['aberto por'],
    encerradoPor: ['encerrado por'],
    mensagensEnviadas: ['mensagens enviadas'],
    mensagensRecebidas: ['mensagens recebidas'],
    aiEvaluation: ['aievaluation', 'ai evaluation'],
    waitingTimeInLastDepartment: ['waitingtimeinlastdepartment', 'waiting time in last department'],
    // identificação interna do cliente e localização (para reincidência e análise por região)
    idCliente: ['id do cliente', 'id cliente', 'codigo do cliente', 'cod cliente', 'codigo cliente'],
    bairro: ['bairro', 'bairro do cliente'],
    condominio: ['condominio', 'condominio do cliente'],
    cidade: ['cidade', 'cidade do cliente', 'municipio'],
    regiao: ['regiao', 'regiao do cliente', 'localidade']
  };
  const GEO_FIELDS = ['bairro', 'condominio', 'cidade', 'regiao'];
  const GEO_HINTS = [['bairro', 'bairro'], ['condominio', 'condominio'], ['cidade', 'cidade']];
  // Cabeçalhos usados ao exportar (iguais aos do sistema de origem)
  const EXPORT_HEADERS = {
    id: 'id', protocolo: 'Protocolo', status: 'Status', canal: 'Canal', atendente: 'Último atendente',
    departamento: 'Último departamento', motivos: 'Motivos do atendimento', abertoEm: 'Aberto em',
    assumidoEm: 'Assumido em', encerradoEm: 'Encerrado em', avaliacao: 'Avaliação',
    tempoAtendimento: 'Tempo em atendimento', tempoEspera: 'Tempo em espera',
    etiquetas: 'Etiquetas do atendimento', abertoPor: 'Aberto por', encerradoPor: 'Encerrado por',
    mensagensEnviadas: 'Mensagens enviadas', mensagensRecebidas: 'Mensagens recebidas',
    aiEvaluation: 'aiEvaluation', waitingTimeInLastDepartment: 'waitingTimeInLastDepartment',
    idCliente: 'Id do Cliente', bairro: 'Bairro', condominio: 'Condomínio', cidade: 'Cidade', regiao: 'Região'
  };

  // Dados que identificam o cliente: NUNCA são guardados (nem no navegador, nem no banco).
  // Vale para colunas que não são reconhecidas pelo painel; as demais colunas são mantidas em "extras".
  let sensitiveTerms = ['contato', 'cliente', 'telefone', 'celular', 'fone', 'cpf', 'cnpj', 'email', 'e mail', 'endereco', 'documento', 'nome', 'cep', 'whatsapp', 'rg'];
  const addSensitive = terms => { (terms || []).forEach(t => { const k = normKey(t); if (k && !sensitiveTerms.includes(k)) sensitiveTerms.push(k); }); };
  const isSensitiveHeader = h => {
    const k = ' ' + normKey(h) + ' ';
    return sensitiveTerms.some(t => k.includes(' ' + t + ' '));
  };
  const FIELDS = Object.keys(EXPORT_HEADERS);

  /* ---------- conversões ---------- */
  function mk(y, mo, d, h, mi) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    return Date.UTC(y, mo - 1, d, h, mi);
  }
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes());
    if (typeof v === 'number') return v > 20000 && v < 80000 ? Math.round((v - 25569) * DAY / 60000) * 60000 : null;
    const s = String(v).trim();
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2}))?/);
    if (m) return mk(+m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0));
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?/);
    if (m) return mk(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
    return null;
  }
  function fmtISO(ts) {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  }
  const fmtISODay = ts => fmtISO(ts).slice(0, 10);
  function parseISODay(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }

  // "1d 2h 3m 4s" -> minutos (null se vazio ou "-")
  function parseDuration(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (s === '' || s === '-') return null;
    let tot = 0, hit = false, m;
    const re = /(\d+(?:[.,]\d+)?)\s*([dhms])/gi;
    while ((m = re.exec(s))) {
      const n = parseFloat(m[1].replace(',', '.'));
      const u = m[2].toLowerCase();
      tot += u === 'd' ? n * 1440 : u === 'h' ? n * 60 : u === 'm' ? n : n / 60;
      hit = true;
    }
    return hit ? tot : 0;
  }

  // "4.5" | 4.5 | "5" -> número; vazio / "-" -> null
  function parseNota(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v > 0 ? v : null;
    const s = String(v).trim().replace(',', '.');
    if (!s || s === '-') return null;
    const n = parseFloat(s);
    return isFinite(n) && n > 0 ? n : null;
  }

  const motivoKey = raw => String(raw).replace(/\./g, '').trim().toUpperCase();
  function properCase(s) {
    return String(s).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }
  // até 4 motivos separados por vírgula; o 4º recebe o restante
  function splitMotivos(k) {
    if (k == null) return [];
    const s = String(k).trim();
    if (!s || s === '-') return [];
    const parts = [];
    let rest = s;
    for (let i = 0; i < 3; i++) {
      const p = rest.indexOf(',');
      if (p < 0) break;
      parts.push(rest.slice(0, p));
      rest = rest.slice(p + 1);
    }
    parts.push(rest);
    return parts.map(p => p.replace(/"/g, '').trim()).filter(Boolean);
  }
  const cleanName = v => {
    const s = v == null ? '' : String(v).trim();
    return s === '' || s === '-' ? null : s;
  };

  /* ---------- tabela bruta -> linhas canônicas ---------- */
  const DATE_FIELDS = ['abertoEm', 'assumidoEm', 'encerradoEm'];
  function canonicalize(table) {
    let hi = -1, map = null;
    for (let i = 0; i < Math.min(table.length, 10); i++) {
      const m = {}; let hits = 0;
      (table[i] || []).forEach((h, ci) => {
        const k = normKey(h == null ? '' : h);
        let hit = false;
        for (const f in ALIASES) if (m[f] === undefined && ALIASES[f].includes(k)) { m[f] = ci; hits++; hit = true; break; }
        if (!hit) {
          const w = ' ' + k + ' ';
          for (const [f, word] of GEO_HINTS) if (m[f] === undefined && w.includes(' ' + word + ' ')) { m[f] = ci; hits++; break; }
        }
      });
      if (hits >= 3 && m.canal !== undefined) { hi = i; map = m; break; }
    }
    if (hi < 0) return { rows: [], error: 'Não encontrei o cabeçalho do relatório. O arquivo precisa ter colunas como Canal, Último atendente, Motivos do atendimento, Assumido em e Avaliação.' };
    if (map.assumidoEm === undefined && map.abertoEm === undefined) return { rows: [], error: 'O arquivo não tem as colunas "Assumido em" nem "Aberto em". Sem a data não dá para montar o período.' };
    const warnings = [];
    if (map.assumidoEm === undefined) warnings.push('Coluna "Assumido em" ausente: usei "Aberto em" como data.');
    if (map.avaliacao === undefined) warnings.push('Coluna "Avaliação" ausente: os indicadores de satisfação ficarão vazios.');
    if (map.tempoAtendimento === undefined) warnings.push('Coluna "Tempo em atendimento" ausente: o TMA ficará vazio.');
    if (map.atendente === undefined) warnings.push('Coluna "Último atendente" ausente: o ranking por atendente ficará vazio.');
    if (map.motivos === undefined) warnings.push('Coluna "Motivos do atendimento" ausente: a aba Motivos ficará vazia.');
    // colunas não reconhecidas: ficam em "extras", exceto as que parecem dados do cliente
    const used = new Set(Object.values(map));
    const extraCols = [], descartadas = [];
    (table[hi] || []).forEach((h, ci) => {
      const name = h == null ? '' : String(h).trim();
      if (!name || used.has(ci)) return;
      if (isSensitiveHeader(name)) descartadas.push(name); else extraCols.push({ name, ci });
    });
    const rows = [];
    for (let i = hi + 1; i < table.length; i++) {
      const line = table[i];
      if (!line || !line.length) continue;
      const o = {};
      let any = false;
      for (const f of FIELDS) {
        let v = map[f] === undefined ? '' : line[map[f]];
        if (v == null) v = '';
        const isDate = DATE_FIELDS.includes(f);
        if (isDate && (v instanceof Date || typeof v === 'number')) {
          const t = parseDate(v); v = t == null ? '' : fmtISO(t);
        } else {
          v = String(v).trim();
          if (v === '-') v = '';
          if (isDate && v) { const t = parseDate(v); if (t != null) v = fmtISO(t); }
        }
        o[f] = v;
        if (v) any = true;
      }
      const ex = {};
      for (const c of extraCols) {
        let v = line[c.ci];
        v = v == null ? '' : (v instanceof Date ? fmtISO(parseDate(v)) : String(v).trim());
        if (v && v !== '-') ex[c.name] = v;
      }
      if (Object.keys(ex).length) o.extras = ex;
      if (any) rows.push(o);
    }
    const hdr = table[hi] || [];
    const localizacao = ['idCliente', ...GEO_FIELDS].filter(f => map[f] !== undefined).map(f => String(hdr[map[f]]).trim());
    return { rows, warnings, descartadas, extrasCols: extraCols.map(c => c.name), localizacao };
  }

  /* ---------- cadastro de clientes (Id -> bairro / condomínio ...) ---------- */
  const CLI_FIELDS = ['idCliente', ...GEO_FIELDS];
  // Só lê o Id e a localização. Qualquer outra coluna (nome, telefone, endereço...) é descartada.
  function canonicalizeClientes(table) {
    for (let i = 0; i < Math.min(table.length, 10); i++) {
      const m = {};
      (table[i] || []).forEach((h, ci) => {
        const k = normKey(h == null ? '' : h), w = ' ' + k + ' ';
        for (const f of CLI_FIELDS) if (m[f] === undefined && ALIASES[f].includes(k)) { m[f] = ci; return; }
        for (const [f, word] of GEO_HINTS) if (m[f] === undefined && w.includes(' ' + word + ' ')) { m[f] = ci; return; }
      });
      if (m.idCliente === undefined || !GEO_FIELDS.some(f => m[f] !== undefined)) continue;
      const used = new Set(Object.values(m));
      const descartadas = (table[i] || []).map(h => (h == null ? '' : String(h).trim())).filter((h, ci) => h && !used.has(ci));
      const rows = [];
      for (let r = i + 1; r < table.length; r++) {
        const line = table[r]; if (!line || !line.length) continue;
        const o = {};
        for (const f of CLI_FIELDS) { const v = m[f] === undefined ? '' : line[m[f]]; o[f] = v == null ? '' : String(v).trim(); if (o[f] === '-') o[f] = ''; }
        if (o.idCliente && GEO_FIELDS.some(f => o[f])) rows.push(o);
      }
      return { rows, descartadas, colunas: CLI_FIELDS.filter(f => m[f] !== undefined).map(f => EXPORT_HEADERS[f]) };
    }
    return { rows: [], error: 'Não encontrei as colunas do cadastro. O arquivo precisa ter "Id do Cliente" e pelo menos uma entre Bairro, Condomínio, Cidade ou Região.' };
  }

  /* ---------- registros preparados ---------- */
  function prepare(rows) {
    return rows.map(r => {
      let ts = parseDate(r.assumidoEm);
      if (ts == null) ts = parseDate(r.abertoEm);
      const o = {
        ts,
        canal: (r.canal || '').trim() || 'Não informado',
        atendente: cleanName(r.atendente),
        tma: parseDuration(r.tempoAtendimento),
        nota: parseNota(r.avaliacao),
        motivosRaw: splitMotivos(r.motivos),
        protocolo: r.protocolo || '', id: r.id || '', motivos: []
      };
      if (ts != null) {
        const d = new Date(ts);
        o.y = d.getUTCFullYear(); o.m = d.getUTCMonth(); o.dia = d.getUTCDate(); o.h = d.getUTCHours();
        o.turno = o.h < 6 ? 'Madrugada' : o.h < 12 ? 'Manhã' : o.h < 18 ? 'Tarde' : 'Noite';
        o.semana = Math.ceil(o.dia / 7);
        o.quinzena = o.dia <= 15 ? 1 : 2;
      }
      return o;
    });
  }

  function buildDepara(list) {
    const m = new Map();
    for (const it of list || []) {
      const k = motivoKey(it.key != null ? it.key : (it[0] || ''));
      const v = String(it.padrao != null ? it.padrao : (it[1] || '')).trim();
      if (k && v) m.set(k, v);
    }
    return m;
  }
  function applyDepara(recs, depara) {
    const unmapped = new Map();
    for (const r of recs) {
      r.motivos = r.motivosRaw.map(raw => {
        const k = motivoKey(raw);
        const hit = depara.get(k);
        if (hit) return hit;
        const u = unmapped.get(k);
        if (u) u.qtd++; else unmapped.set(k, { key: k, exemplo: raw, qtd: 1 });
        return properCase(raw);
      });
    }
    return [...unmapped.values()].sort((a, b) => b.qtd - a.qtd);
  }

  /* ---------- período ---------- */
  const eom = ts => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0); };
  const som = ts => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

  function monthsInBase(recs) {
    const set = new Map();
    for (const r of recs) if (r.ts != null) {
      const k = r.y * 12 + r.m;
      set.set(k, (set.get(k) || 0) + 1);
    }
    return [...set.entries()].sort((a, b) => b[0] - a[0]).map(([k, n]) => ({
      start: Date.UTC(Math.floor(k / 12), k % 12, 1), n,
      label: MESES[k % 12] + '/' + Math.floor(k / 12)
    }));
  }

  function resolvePeriod(recs, manual) {
    manual = manual || {};
    let min = Infinity, max = -Infinity, valid = 0;
    for (const r of recs) if (r.ts != null) { valid++; if (r.ts < min) min = r.ts; if (r.ts > max) max = r.ts; }
    const out = { totalLinhas: recs.length, linhasValidas: valid, status: [] };
    if (!recs.length) { out.empty = true; out.label = '(sem dados)'; out.status.push('Nenhum dado carregado. Envie o relatório na aba Atualizar dados.'); return out; }
    if (!valid) { out.empty = true; out.label = '(sem dados)'; out.status.push('Nenhuma data válida encontrada nos dados.'); return out; }
    const first = Math.floor(min / DAY) * DAY, last = Math.floor(max / DAY) * DAY;
    const ms = parseISODay(manual.start), me = parseISODay(manual.end);
    const refStart = som(last);
    const start = ms != null ? ms : (me != null ? som(me) : refStart);
    const end = me != null ? me : (ms != null ? last : eom(refStart));
    out.first = first; out.last = last; out.start = start; out.end = end; out.manual = ms != null || me != null;
    out.dias = Math.round((end - start) / DAY) + 1;
    const sd = new Date(start), ed = new Date(end);
    const sameMonth = sd.getUTCFullYear() === ed.getUTCFullYear() && sd.getUTCMonth() === ed.getUTCMonth();
    out.singleMonth = sameMonth;
    out.maxDia = sameMonth ? new Date(eom(start)).getUTCDate() : 31;
    out.label = sameMonth && sd.getUTCDate() === 1 && end === eom(start)
      ? MESES[sd.getUTCMonth()] + '/' + sd.getUTCFullYear()
      : fmtDate(start) + ' a ' + fmtDate(end);
    let dentro = 0;
    for (const r of recs) if (r.ts != null && r.ts >= start && r.ts < end + DAY) dentro++;
    out.dentro = dentro; out.fora = valid - dentro; out.semData = recs.length - valid;
    if (!sameMonth) out.status.push('O período cobre mais de um mês: os gráficos por dia somam dias iguais de meses diferentes.');
    if (out.fora + out.semData > 0) out.status.push(`${out.fora + out.semData} linha(s) ignorada(s): ${out.fora} fora do período e ${out.semData} sem data válida.`);
    return out;
  }
  const filterPeriod = (recs, p) => p.empty ? [] : recs.filter(r => r.ts != null && r.ts >= p.start && r.ts < p.end + DAY);

  /* ---------- cálculos ---------- */
  const avg = a => { if (!a.length) return null; let s = 0; for (const x of a) s += x; return s / a.length; };
  const r1 = x => Math.round(x * 10) / 10;
  const r2 = x => Math.round(x * 100) / 100;
  const firstMax = (arr, f) => { let bi = -1, bv = -Infinity; arr.forEach((x, i) => { const v = f(x); if (v > bv) { bv = v; bi = i; } }); return bi; };

  function computeMotivos(recs, canais) {
    const map = new Map();
    let total = 0;
    for (const r of recs) for (const m of r.motivos) {
      let o = map.get(m);
      if (!o) { o = { motivo: m, total: 0, porCanal: {} }; canais.forEach(c => o.porCanal[c] = 0); map.set(m, o); }
      o.total++; o.porCanal[r.canal] = (o.porCanal[r.canal] || 0) + 1; total++;
    }
    const lista = [...map.values()].sort((a, b) => b.total - a.total || a.motivo.localeCompare(b.motivo, 'pt-BR'));
    lista.forEach(o => o.pct = total ? o.total / total : 0);
    return { lista, total };
  }

  function compute(recs, opts) {
    opts = opts || {};
    const minAval = opts.minAvaliacoes != null ? opts.minAvaliacoes : 10;
    const maxDia = opts.maxDia || 31;
    const baseCanais = opts.canais || ['WhatsApp', 'Instagram', 'Telefonia'];
    // Teto de duração (min) para o TMA: atendimentos acima dele ficam fora da média (0 = sem teto)
    const tmaMax = opts.tmaMaxMin > 0 ? opts.tmaMaxMin : 0;
    const okTma = r => r.tma != null && (!tmaMax || r.tma <= tmaMax);

    const cnt = {};
    recs.forEach(r => cnt[r.canal] = (cnt[r.canal] || 0) + 1);
    const canais = baseCanais.slice();
    Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).forEach(c => { if (!canais.includes(c)) canais.push(c); });
    const zeroCanais = () => { const o = {}; canais.forEach(c => o[c] = 0); return o; };

    const M = { total: recs.length, canais };
    M.canal = canais.map(c => ({ canal: c, total: cnt[c] || 0, pct: recs.length ? (cnt[c] || 0) / recs.length : 0 }));

    const tmas = recs.filter(okTma).map(r => r.tma);
    const median = a => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
    // TMA ponderado: TMA de cada canal x atendimentos do canal / total de atendimentos com tempo válido
    M.tmaCanal = canais.map(c => { const a = recs.filter(r => r.canal === c && okTma(r)).map(r => r.tma); return { canal: c, n: a.length, tma: a.length ? avg(a) : 0, mediana: median(a) }; });
    const nTma = M.tmaCanal.reduce((a, x) => a + x.n, 0);
    const tmaPond = nTma ? M.tmaCanal.reduce((a, x) => a + x.tma * x.n, 0) / nTma : 0;
    const tmaExcl = recs.filter(r => r.tma != null && !okTma(r)).length;
    const notas = recs.filter(r => r.nota != null).map(r => r.nota);

    function groupVol(keys, keyFn, fin) {
      const g = new Map(keys.map(k => [k, { k, total: 0, porCanal: zeroCanais(), tmas: [], notas: [] }]));
      for (const r of recs) {
        const o = g.get(keyFn(r)); if (!o) continue;
        o.total++; o.porCanal[r.canal]++;
        if (okTma(r)) o.tmas.push(r.tma);
        if (r.nota != null) o.notas.push(r.nota);
      }
      return keys.map(k => fin(g.get(k)));
    }

    const dias = Array.from({ length: maxDia }, (_, i) => i + 1);
    M.dia = groupVol(dias, r => r.dia, o => ({ dia: o.k, total: o.total, porCanal: o.porCanal, tma: o.tmas.length ? r2(avg(o.tmas)) : 0, n: o.total, nTma: o.tmas.length, nAval: o.notas.length, nota: o.notas.length ? r2(avg(o.notas)) : 0 }));
    M.turno = groupVol(TURNOS, r => r.turno, o => ({ turno: o.k, total: o.total, porCanal: o.porCanal, tma: o.tmas.length ? r2(avg(o.tmas)) : 0, nAval: o.notas.length, nota: o.notas.length ? avg(o.notas) : 0 }));

    let hmin = 6, hmax = 23;
    recs.forEach(r => { if (r.h < hmin) hmin = r.h; if (r.h > hmax) hmax = r.h; });
    const horas = []; for (let h = hmin; h <= hmax; h++) horas.push(h);
    M.hora = groupVol(horas, r => r.h, o => ({ hora: o.k, label: `${pad(o.k)}:00-${pad((o.k + 1) % 24)}:00`, short: pad(o.k) + 'h', total: o.total, porCanal: o.porCanal, tma: o.tmas.length ? r2(avg(o.tmas)) : 0 }));

    const sems = Array.from({ length: Math.ceil(maxDia / 7) }, (_, i) => i + 1);
    M.semana = groupVol(sems, r => r.semana, o => ({ semana: o.k, label: 'Semana ' + o.k, total: o.total, porCanal: o.porCanal, nAval: o.notas.length, nota: o.notas.length ? avg(o.notas) : 0 }));

    // atendentes (registros sem nome ficam num grupo à parte)
    const at = new Map();
    const sem = { nome: 'Sem atendente', total: 0, porCanal: zeroCanais(), tmas: [], notas: [] };
    for (const r of recs) {
      let o;
      if (r.atendente == null) o = sem;
      else {
        const k = r.atendente.toLowerCase();
        o = at.get(k);
        if (!o) { o = { nome: r.atendente, total: 0, porCanal: zeroCanais(), tmas: [], notas: [] }; at.set(k, o); }
      }
      o.total++; o.porCanal[r.canal]++;
      if (okTma(r)) o.tmas.push(r.tma);
      if (r.nota != null) o.notas.push(r.nota);
    }
    const fin = o => {
      const n = o.notas.length, soma = o.notas.reduce((a, b) => a + b, 0);
      const q4 = o.notas.filter(x => x >= 4).length, q2 = o.notas.filter(x => x <= 2).length;
      return {
        nome: o.nome, total: o.total, porCanal: o.porCanal,
        tma: o.tmas.length ? r2(avg(o.tmas)) : 0, nAval: n, soma, media: n ? soma / n : 0,
        qtd4: q4, qtd2: q2, csat: n ? q4 / n : 0, insat: n ? q2 / n : 0, taxaResp: o.total ? n / o.total : 0
      };
    };
    M.atendentes = [...at.values()].map(fin).sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, 'pt-BR'));
    M.semAtendente = fin(sem);

    const notaGeral = notas.length ? avg(notas) : 0;
    M.ranking = M.atendentes.map(a => ({
      ...a, key: (a.nAval >= minAval ? 1000 : 0) + a.media + a.nAval / 1e5,
      situacao: a.nAval < minAval ? 'Amostra baixa' : (a.media >= notaGeral ? 'Acima da média' : 'Abaixo da média')
    })).sort((a, b) => b.key - a.key);

    M.motivos = computeMotivos(recs, canais);

    // avaliações
    const dist = NOTAS.map(n => ({ nota: n, label: n.toFixed(1).replace('.', ','), qtd: notas.filter(x => x === n).length }));
    dist.forEach(d => d.pct = notas.length ? d.qtd / notas.length : 0);
    const satisf = notas.filter(x => x >= 4).length, insat = notas.filter(x => x <= 2).length;
    const neutros = notas.filter(x => x >= 2.5 && x <= 3.5).length;
    M.notas = {
      n: notas.length, media: notaGeral, dist,
      grupos: [
        { grupo: 'Satisfeitos', criterio: 'Nota ≥ 4', qtd: satisf },
        { grupo: 'Neutros', criterio: 'Nota 2,5 a 3,5', qtd: neutros },
        { grupo: 'Insatisfeitos', criterio: 'Nota ≤ 2', qtd: insat }
      ],
      porDia: M.dia.map(d => ({ dia: d.dia, media: d.nota, n: d.nAval })),
      porTurno: M.turno.map(t => ({ turno: t.turno, n: t.nAval, media: t.nota })),
      porSemana: M.semana.map(s => ({ semana: s.label, n: s.nAval, media: s.nota })),
      porCanal: canais.map(c => { const a = recs.filter(r => r.canal === c && r.nota != null).map(r => r.nota); return { canal: c, n: a.length, media: a.length ? avg(a) : 0 }; }),
      minAval
    };

    // KPIs (mesmas regras da planilha)
    const mov = M.dia.filter(d => d.total > 0);
    const iMax = firstMax(M.dia, d => d.total);
    let diaMenos = null;
    if (mov.length) { const mn = Math.min(...mov.map(d => d.total)); diaMenos = mov.find(d => d.total === mn); }
    const iCanal = firstMax(M.canal, c => c.total);
    const iTurno = firstMax(M.turno, t => t.tma);
    const qual = M.ranking.filter(a => a.nAval >= minAval);
    const iTurnoNota = firstMax(M.turno, t => t.nota);
    const iFreq = firstMax(dist, d => d.qtd);
    M.kpi = {
      total: recs.length,
      tma: r1(tmaPond), tmaMediana: median(tmas), tmaN: nTma, tmaExcluidos: tmaExcl, tmaMaxMin: tmaMax,
      nota: notaGeral, nAval: notas.length,
      taxaResp: recs.length ? notas.length / recs.length : 0,
      csat: notas.length ? satisf / notas.length : 0,
      insat: notas.length ? insat / notas.length : 0,
      canalLider: recs.length && iCanal >= 0 ? { canal: M.canal[iCanal].canal, pct: M.canal[iCanal].pct } : null,
      mediaDia: mov.length ? Math.round(recs.length / mov.length) : 0,
      diasMov: mov.length,
      diaMais: recs.length && iMax >= 0 ? { dia: M.dia[iMax].dia, total: M.dia[iMax].total } : null,
      diaMenos: diaMenos ? { dia: diaMenos.dia, total: diaMenos.total } : null,
      motivo1: M.motivos.lista[0] ? { motivo: M.motivos.lista[0].motivo, total: M.motivos.lista[0].total } : null,
      turnoMaiorTma: recs.length && iTurno >= 0 && M.turno[iTurno].tma > 0 ? { turno: M.turno[iTurno].turno, tma: M.turno[iTurno].tma } : null,
      melhorAtendente: qual.length ? { nome: qual[0].nome, nota: qual[0].media } : null,
      menorNota: qual.length ? { nome: qual[qual.length - 1].nome, nota: qual[qual.length - 1].media } : null,
      turnoMelhorNota: notas.length && iTurnoNota >= 0 && M.turno[iTurnoNota].nota > 0 ? { turno: M.turno[iTurnoNota].turno, nota: M.turno[iTurnoNota].nota } : null,
      notaFrequente: notas.length ? { label: dist[iFreq].label, qtd: dist[iFreq].qtd } : null
    };
    return M;
  }

  return {
    TURNOS, MESES, NOTAS, FIELDS, EXPORT_HEADERS, ALIASES, GEO_FIELDS, CLI_FIELDS, addSensitive, isSensitiveHeader, canonicalizeClientes,
    normKey, parseDate, parseDuration, parseNota, splitMotivos, properCase, motivoKey,
    fmtISO, fmtDate, fmtISODay, parseISODay,
    canonicalize, prepare, buildDepara, applyDepara,
    monthsInBase, resolvePeriod, filterPeriod, computeMotivos, compute
  };
});
