/* Dashboard de Atendimentos — aplicação (sem frameworks, sem build). */
(function () {
  'use strict';
  const E = window.OPAEngine, P = window.OPAParser, C = window.Charts;
  const CFG = Object.assign({
    titulo: 'Dashboard de Atendimentos', subtitulo: '', dataUrl: 'data/atendimentos.csv', deParaUrl: 'data/depara_motivos.csv',
    autoRefreshMinutes: 0, minAvaliacoesRanking: 10, canais: ['WhatsApp', 'Instagram', 'Telefonia'], permitirAtualizacaoPeloNavegador: true
  }, window.OPA_CONFIG || {});

  const $ = s => document.querySelector(s);
  const esc = C.esc, nf = C.nf;
  const n0 = v => nf(v), n1 = v => nf(v, 1), n2 = v => nf(v, 2);
  const pct = v => nf(v * 100, 1) + '%';
  const fmtWhen = ts => { const d = new Date(ts); return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };

  const COLORS = { 'WhatsApp': '#1FA463', 'Instagram': '#C2417B', 'Telefonia': '#2F6FDE' };
  const EXTRA = ['#8A63D2', '#18A0B0', '#7A8795', '#B5651D'];
  const TMA_COLOR = '#E08A00', GOOD = '#2BA66F', WARN = '#E3A12F', BAD = '#D2504F', ACCENT = '#2F6FDE';
  const extraMap = new Map();
  const chColor = c => COLORS[c] || (extraMap.has(c) ? extraMap.get(c) : (extraMap.set(c, EXTRA[extraMap.size % EXTRA.length]), extraMap.get(c)));

  /* ---------- armazenamento local ---------- */
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  const idb = {
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open('opa-dashboard', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    },
    async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
    async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
    async del(k) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  };

  /* ---------- estado ---------- */
  const S = {
    rows: [], recs: [], filtered: [], M: null, per: null,
    depara: new Map(), deparaList: [], deparaCustom: false, unmapped: [],
    source: { kind: 'none' }, loadError: '',
    period: { mode: 'auto', start: '', end: '' },
    settings: Object.assign({ minAval: CFG.minAvaliacoesRanking }, ls.get('opa.settings', {})),
    pending: null, view: 'dashboard', motSeg: 'mes', motQ: '', depQ: ''
  };

  /* ---------- utilitários ---------- */
  let toastT;
  function toast(msg, ms = 4200) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/csv;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function fetchBuffer(url) {
    const u = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
    const r = await fetch(u, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ao buscar ' + url);
    return { buf: await r.arrayBuffer(), modified: r.headers.get('Last-Modified') };
  }
  const bufFile = (name, buf) => ({ name, arrayBuffer: async () => buf });
  const slug = s => String(s).replace(/[^\w.-]+/g, '_');

  /* ---------- carga de dados ---------- */
  async function loadDepara() {
    const custom = ls.get('opa.depara', null);
    if (Array.isArray(custom) && custom.length) { S.deparaList = custom; S.deparaCustom = true; return; }
    S.deparaCustom = false;
    try {
      const { buf } = await fetchBuffer(CFG.deParaUrl);
      const t = P.parseCSV(P.decodeBuffer(buf));
      S.deparaList = t.slice(1).filter(r => r[0] && r[1]).map(r => ({ key: E.motivoKey(r[0]), padrao: String(r[1]).trim() }));
    } catch (e) { S.deparaList = []; }
  }

  async function loadServerRows() {
    const { buf, modified } = await fetchBuffer(CFG.dataUrl);
    const { table, kind } = await P.tableFromFile(bufFile(CFG.dataUrl, buf));
    const res = E.canonicalize(table);
    if (res.error) throw new Error(res.error);
    return { rows: res.rows, modified, kind };
  }

  async function loadInitial() {
    await loadDepara();
    let local = null;
    try { local = await idb.get('dataset'); } catch (e) { /* sem IndexedDB */ }
    if (local && local.rows && local.rows.length) {
      S.source = { kind: 'local', name: local.name, when: local.savedAt };
      setRows(local.rows);
      return;
    }
    await reloadFromServer(true);
  }

  async function reloadFromServer(silent) {
    try {
      const r = await loadServerRows();
      S.source = { kind: 'server', name: CFG.dataUrl, modified: r.modified, when: Date.now() };
      S.loadError = '';
      setRows(r.rows);
      if (!silent) toast('Dados recarregados do servidor.');
    } catch (e) {
      S.loadError = 'Não consegui carregar ' + CFG.dataUrl + ' (' + e.message + '). ' +
        (location.protocol === 'file:' ? 'Abrindo o arquivo direto do disco o navegador bloqueia a leitura; publique o site ou use a aba Atualizar dados para enviar o relatório.' : 'Use a aba Atualizar dados para enviar o relatório.');
      S.source = { kind: 'none' };
      setRows([]);
    }
  }

  function setRows(rows) {
    S.rows = rows;
    S.recs = E.prepare(rows);
    rebuild();
  }

  /* ---------- cálculo ---------- */
  function currentManual() {
    const p = S.period;
    if (p.mode === 'month') {
      const s = Number(p.start); return { start: E.fmtISODay(s), end: E.fmtISODay(Date.UTC(new Date(s).getUTCFullYear(), new Date(s).getUTCMonth() + 1, 0)) };
    }
    if (p.mode === 'custom') return { start: p.start, end: p.end };
    return {};
  }
  function rebuild() {
    S.unmapped = E.applyDepara(S.recs, E.buildDepara(S.deparaList));
    recompute();
  }
  function recompute() {
    S.per = E.resolvePeriod(S.recs, currentManual());
    S.filtered = E.filterPeriod(S.recs, S.per);
    S.M = E.compute(S.filtered, { maxDia: S.per.maxDia || 31, minAvaliacoes: Number(S.settings.minAval) || 10, canais: CFG.canais });
    renderChrome();
    renderView();
  }

  /* ---------- cabeçalho / barra de período ---------- */
  function renderChrome() {
    $('#title').textContent = CFG.titulo; $('#subtitle').textContent = CFG.subtitulo;
    document.title = CFG.titulo + (S.per && !S.per.empty ? ' · ' + S.per.label : '');
    $('#chipPeriod').textContent = S.per.empty ? 'Sem dados' : S.per.label + ' · ' + n0(S.M.total) + ' atendimentos';
    const s = S.source, cs = $('#chipSource');
    cs.classList.toggle('warn', s.kind === 'local');
    cs.textContent = s.kind === 'server' ? 'Dados do servidor' + (s.modified ? ' · ' + fmtWhen(new Date(s.modified).getTime()) : '')
      : s.kind === 'local' ? 'Dados deste navegador · ' + fmtWhen(s.when) : 'Sem dados carregados';

    // seletor de período
    const sel = $('#selPeriodo'), months = E.monthsInBase(S.recs);
    const autoLabel = (() => { const p = E.resolvePeriod(S.recs, {}); return p.empty ? 'Automático' : 'Automático — último mês (' + p.label + ')'; })();
    let html = `<option value="auto">${esc(autoLabel)}</option>`;
    months.forEach(m => { html += `<option value="m:${m.start}">${esc(m.label)} (${n0(m.n)})</option>`; });
    html += '<option value="custom">Personalizado…</option>';
    sel.innerHTML = html;
    sel.value = S.period.mode === 'auto' ? 'auto' : S.period.mode === 'month' ? 'm:' + S.period.start : 'custom';
    if (sel.value !== (S.period.mode === 'auto' ? 'auto' : S.period.mode === 'month' ? 'm:' + S.period.start : 'custom')) { S.period.mode = 'auto'; sel.value = 'auto'; }
    $('#customDates').hidden = S.period.mode !== 'custom';
    if (!S.per.empty) {
      $('#dtIni').min = $('#dtFim').min = E.fmtISODay(S.per.first); $('#dtIni').max = $('#dtFim').max = E.fmtISODay(S.per.last);
      if (S.period.mode === 'custom') { $('#dtIni').value = S.period.start || ''; $('#dtFim').value = S.period.end || ''; }
    }
    // avisos
    const notes = [];
    if (S.loadError) notes.push(['bad', S.loadError]);
    if (S.per.status) S.per.status.forEach(m => { if (!S.loadError) notes.push(['', m]); });
    $('#notes').innerHTML = notes.map(n => `<div class="note ${n[0]}">${esc(n[1])}</div>`).join('');
  }

  /* ---------- roteamento ---------- */
  const VIEWS = ['dashboard', 'avaliacoes', 'motivos', 'dados', 'config'];
  function route() {
    const h = (location.hash || '#dashboard').slice(1);
    S.view = VIEWS.includes(h) ? h : 'dashboard';
    document.querySelectorAll('.tabs a').forEach(a => { if (a.getAttribute('href') === '#' + S.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    VIEWS.forEach(v => { $('#view-' + v).hidden = v !== S.view; });
    $('#toolbar').hidden = !['dashboard', 'avaliacoes', 'motivos'].includes(S.view);
    if (S.M) renderView();
    window.scrollTo(0, 0);
  }
  function renderView() {
    ({ dashboard: renderDashboard, avaliacoes: renderAval, motivos: renderMotivos, dados: renderDados, config: renderConfig })[S.view]();
  }

  /* ---------- blocos de UI ---------- */
  const kpi = (lab, val, ft, cls) => `<div class="card kpi ${cls || ''}"><div class="lab">${lab}</div><div class="val">${val}</div><div class="ft">${ft || '&nbsp;'}</div></div>`;
  const card = (title, sub, id, cls) => `<div class="card ${cls || ''}"><h2>${title}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}<div class="chart" id="${id}"></div></div>`;
  const seriesByCanal = (M, getter) => M.canais.map(c => ({ name: c, color: chColor(c), values: getter(c) }));
  const noData = () => `<div class="card empty span2"><b>Sem dados para exibir.</b><br>Envie o relatório exportado do OPA na aba <a href="#dados">Atualizar dados</a>.</div>`;
  const el = id => document.getElementById(id);

  /* ---------- PAINEL ---------- */
  function renderDashboard() {
    const M = S.M, K = M.kpi, root = $('#view-dashboard');
    if (!M.total) { root.innerHTML = noData(); return; }
    root.innerHTML = `
      <div class="grid g-kpi">
        ${kpi('Total de atendimentos', n0(K.total), `Média de ${n0(K.mediaDia)} por dia com movimento (${K.diasMov} dias)`, 'hero')}
        ${kpi('TMA médio', n1(K.tma) + '<small>min</small>', K.turnoMaiorTma ? `Maior no turno ${esc(K.turnoMaiorTma.turno)} (${n1(K.turnoMaiorTma.tma)} min)` : '', 'hero')}
        ${kpi('Nota média', K.nAval ? n2(K.nota) + '<small>/ 5</small>' : '—', `${n0(K.nAval)} avaliações · resposta de ${pct(K.taxaResp)}`, 'hero')}
        ${kpi('Satisfação (nota ≥ 4)', K.nAval ? pct(K.csat) : '—', K.nAval ? `Insatisfeitos (≤ 2): ${pct(K.insat)}` : '', 'hero')}
        ${kpi('Canal líder', K.canalLider ? esc(K.canalLider.canal) : '—', K.canalLider ? pct(K.canalLider.pct) + ' dos atendimentos' : '', 'hero')}
      </div>
      <div class="grid g-kpi">
        ${kpi('Dia mais movimentado', K.diaMais ? 'Dia ' + K.diaMais.dia : '—', K.diaMais ? n0(K.diaMais.total) + ' atendimentos' : '', 'small')}
        ${kpi('Dia menos movimentado', K.diaMenos ? 'Dia ' + K.diaMenos.dia : '—', K.diaMenos ? n0(K.diaMenos.total) + ' atendimentos (parcial)' : '', 'small')}
        ${kpi('Motivo nº 1', K.motivo1 ? esc(K.motivo1.motivo) : '—', K.motivo1 ? n0(K.motivo1.total) + ' ocorrências' : '', 'small')}
        ${kpi('Melhor nota entre atendentes', K.melhorAtendente ? esc(K.melhorAtendente.nome) : '—', K.melhorAtendente ? n2(K.melhorAtendente.nota) + ` (mín. ${S.settings.minAval} avaliações)` : `Nenhum com ${S.settings.minAval}+ avaliações`, 'small')}
      </div>
      <div class="grid g-2">
        ${card('Volume e TMA por dia', 'Barras: atendimentos por canal · linha: TMA em minutos (eixo à direita)', 'ch-dia', 'span2')}
        ${card('Atendimentos por canal', 'Participação no período', 'ch-canal')}
        ${card('Canal por semana', 'Semana 1 = dias 1–7, e assim por diante', 'ch-sem')}
        ${card('Volume e TMA por turno', 'Madrugada 0–6h · Manhã 6–12h · Tarde 12–18h · Noite 18–24h', 'ch-turno')}
        ${card('Volume e TMA por hora', 'Hora em que o atendimento foi assumido', 'ch-hora')}
        ${card('Top 15 motivos', 'Ocorrências por canal (um atendimento pode ter até 4 motivos)', 'ch-mot')}
        ${card('Atendimentos por atendente', 'Último atendente do ticket', 'ch-at')}
      </div>
      <div class="card"><h2>Desempenho por atendente</h2><p class="sub">Volume, tempo médio e nota no período</p>
        <div class="tbl-wrap" style="max-height:440px;overflow:auto">${atendTable(M)}</div></div>`;

    C.bar(el('ch-dia'), { title: 'Volume e TMA por dia', labels: M.dia.map(d => d.dia), stacked: true, height: 280,
      series: seriesByCanal(M, c => M.dia.map(d => d.porCanal[c])), line: { name: 'TMA (min)', color: TMA_COLOR, values: M.dia.map(d => d.nTma ? d.tma : null) } });
    C.donut(el('ch-canal'), { title: 'Atendimentos por canal', big: n0(M.total), small: 'atendimentos', items: M.canal.map(c => ({ label: c.canal, value: c.total, color: chColor(c.canal) })) });
    C.bar(el('ch-sem'), { title: 'Canal por semana', labels: M.semana.map(s => 'Semana ' + s.semana), stacked: true, valueLabels: true, height: 230,
      series: seriesByCanal(M, c => M.semana.map(s => s.porCanal[c])) });
    C.bar(el('ch-turno'), { title: 'Volume e TMA por turno', labels: M.turno.map(t => t.turno), stacked: true, valueLabels: true, height: 250,
      series: seriesByCanal(M, c => M.turno.map(t => t.porCanal[c])), line: { name: 'TMA (min)', color: TMA_COLOR, values: M.turno.map(t => t.total ? t.tma : null) } });
    C.bar(el('ch-hora'), { title: 'Volume e TMA por hora', labels: M.hora.map(h => h.short), stacked: true, height: 250,
      series: seriesByCanal(M, c => M.hora.map(h => h.porCanal[c])), line: { name: 'TMA (min)', color: TMA_COLOR, values: M.hora.map(h => h.total ? h.tma : null) } });
    const top = M.motivos.lista.slice(0, 15);
    C.bar(el('ch-mot'), { title: 'Top 15 motivos', horizontal: true, stacked: true, labels: top.map(m => m.motivo), maxLabel: 30,
      series: seriesByCanal(M, c => top.map(m => m.porCanal[c] || 0)) });
    const lst = M.atendentes.slice(0, 20).map(a => ({ label: a.nome, porCanal: a.porCanal }));
    const rest = M.atendentes.slice(20);
    if (rest.length) { const pc = {}; M.canais.forEach(c => pc[c] = rest.reduce((s, a) => s + a.porCanal[c], 0)); lst.push({ label: `Demais (${rest.length})`, porCanal: pc }); }
    if (M.semAtendente.total) lst.push({ label: 'Sem atendente', porCanal: M.semAtendente.porCanal });
    C.bar(el('ch-at'), { title: 'Atendimentos por atendente', horizontal: true, stacked: true, labels: lst.map(a => a.label), maxLabel: 28,
      series: seriesByCanal(M, c => lst.map(a => a.porCanal[c])) });
  }

  function atendTable(M) {
    const row = (a, mute) => `<tr${mute ? ' style="color:var(--muted)"' : ''}><td class="name">${esc(a.nome)}</td><td>${n0(a.total)}</td><td>${pct(M.total ? a.total / M.total : 0)}</td><td>${a.tma ? n1(a.tma) : '—'}</td><td>${n0(a.nAval)}</td><td>${a.nAval ? n2(a.media) : '—'}</td></tr>`;
    return `<table><thead><tr><th>Atendente</th><th>Atendimentos</th><th>% do total</th><th>TMA (min)</th><th>Avaliações</th><th>Nota média</th></tr></thead><tbody>
      ${M.atendentes.map(a => row(a)).join('')}${M.semAtendente.total ? row(M.semAtendente, true) : ''}</tbody></table>`;
  }

  /* ---------- AVALIAÇÕES ---------- */
  function renderAval() {
    const M = S.M, K = M.kpi, N = M.notas, root = $('#view-avaliacoes');
    if (!M.total) { root.innerHTML = noData(); return; }
    if (!N.n) { root.innerHTML = `<div class="card empty span2"><b>Nenhuma avaliação no período.</b></div>`; return; }
    const g = N.grupos;
    const minA = S.settings.minAval;
    const notaTbl = (rows, key) => `<table><thead><tr><th>${key}</th><th>Avaliações</th><th>Nota média</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.turno || r.semana || r.canal)}</td><td>${n0(r.n)}</td><td>${r.n ? n2(r.media) : '—'}</td></tr>`).join('')}</tbody></table>`;
    root.innerHTML = `
      <div class="grid g-kpi">
        ${kpi('Nota média', n2(K.nota) + '<small>/ 5</small>', `${n0(N.n)} avaliações`, 'hero')}
        ${kpi('Taxa de resposta', pct(K.taxaResp), `${n0(N.n)} de ${n0(K.total)} atendimentos`, 'hero')}
        ${kpi('Satisfeitos (≥ 4)', pct(K.csat), n0(g[0].qtd) + ' avaliações', 'hero')}
        ${kpi('Neutros (2,5 a 3,5)', pct(g[1].qtd / N.n), n0(g[1].qtd) + ' avaliações', 'hero')}
        ${kpi('Insatisfeitos (≤ 2)', pct(K.insat), n0(g[2].qtd) + ' avaliações', 'hero')}
      </div>
      <div class="grid g-kpi">
        ${kpi('Melhor atendente', K.melhorAtendente ? esc(K.melhorAtendente.nome) : '—', K.melhorAtendente ? 'Nota ' + n2(K.melhorAtendente.nota) : `Ninguém com ${minA}+ avaliações`, 'small')}
        ${kpi('Menor nota', K.menorNota ? esc(K.menorNota.nome) : '—', K.menorNota ? 'Nota ' + n2(K.menorNota.nota) : '', 'small')}
        ${kpi('Turno melhor avaliado', K.turnoMelhorNota ? esc(K.turnoMelhorNota.turno) : '—', K.turnoMelhorNota ? 'Nota ' + n2(K.turnoMelhorNota.nota) : '', 'small')}
        ${kpi('Nota mais frequente', K.notaFrequente ? K.notaFrequente.label : '—', K.notaFrequente ? n0(K.notaFrequente.qtd) + ' avaliações' : '', 'small')}
      </div>
      <div class="grid g-2">
        ${card('Distribuição das notas', 'Quantidade de avaliações por nota', 'ch-dist')}
        ${card('Satisfação', 'Satisfeitos, neutros e insatisfeitos', 'ch-grp')}
        ${card('Nota média por dia', 'Dias sem avaliação ficam em branco', 'ch-nd', 'span2')}
      </div>
      <div class="card"><h2>Ranking de atendentes por nota</h2>
        <p class="sub">Só entram na classificação "acima/abaixo da média" quem tem ${minA}+ avaliações (ajuste em Configurações). Média geral: ${n2(K.nota)}.</p>
        <div class="tbl-wrap" style="max-height:480px;overflow:auto"><table><thead><tr><th>#</th><th class="l">Atendente</th><th>Atendimentos</th><th>Avaliações</th><th>Nota média</th><th>Satisfeitos</th><th>Insatisfeitos</th><th>Taxa de resposta</th><th>Situação</th></tr></thead><tbody>
        ${M.ranking.map((a, i) => `<tr><td>${i + 1}</td><td class="name">${esc(a.nome)}</td><td>${n0(a.total)}</td><td>${n0(a.nAval)}</td><td>${a.nAval ? n2(a.media) : '—'}</td><td>${a.nAval ? pct(a.csat) : '—'}</td><td>${a.nAval ? pct(a.insat) : '—'}</td><td>${pct(a.taxaResp)}</td>
          <td><span class="pill ${a.situacao === 'Acima da média' ? 'good' : a.situacao === 'Abaixo da média' ? 'bad' : 'mute'}">${a.situacao}</span></td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="grid g-3" style="margin-top:14px">
        <div class="card"><h2>Por turno</h2><div class="tbl-wrap">${notaTbl(N.porTurno, 'Turno')}</div></div>
        <div class="card"><h2>Por semana</h2><div class="tbl-wrap">${notaTbl(N.porSemana, 'Semana')}</div></div>
        <div class="card"><h2>Por canal</h2><div class="tbl-wrap">${notaTbl(N.porCanal, 'Canal')}</div></div>
      </div>`;
    const gs = [['Insatisfeitos (≤ 2)', BAD], ['Neutros (2,5 a 3,5)', WARN], ['Satisfeitos (≥ 4)', GOOD]];
    const gi = n => (n <= 2 ? 0 : n >= 4 ? 2 : 1);
    C.bar(el('ch-dist'), { title: 'Distribuição das notas', labels: N.dist.map(d => d.label), stacked: true, valueLabels: true, height: 250, legend: true,
      series: gs.map(([name, color], k) => ({ name, color, values: N.dist.map(d => gi(d.nota) === k ? d.qtd : 0) })) });
    C.donut(el('ch-grp'), { title: 'Satisfação', big: pct(K.csat), small: 'satisfeitos',
      items: [{ label: 'Satisfeitos (≥ 4)', value: g[0].qtd, color: GOOD }, { label: 'Neutros (2,5 a 3,5)', value: g[1].qtd, color: WARN }, { label: 'Insatisfeitos (≤ 2)', value: g[2].qtd, color: BAD }] });
    C.bar(el('ch-nd'), { title: 'Nota média por dia', labels: N.porDia.map(d => d.dia), height: 230, fmt: v => n2(v),
      series: [{ name: 'Nota média', color: ACCENT, values: N.porDia.map(d => d.media) }] });
  }

  /* ---------- MOTIVOS ---------- */
  function renderMotivos() {
    const M = S.M, root = $('#view-motivos');
    if (!M.total) { root.innerHTML = noData(); return; }
    const segs = [['mes', 'Mês todo'], ['q1', '1ª quinzena (dias 1–15)'], ['q2', '2ª quinzena (dia 16 em diante)']];
    M.semana.forEach(s => segs.push(['s' + s.semana, 'Semana ' + s.semana + ' (dias ' + ((s.semana - 1) * 7 + 1) + '–' + Math.min(s.semana * 7, S.per.maxDia || 31) + ')']));
    const recs = S.filtered.filter(r => S.motSeg === 'mes' ? true : S.motSeg === 'q1' ? r.quinzena === 1 : S.motSeg === 'q2' ? r.quinzena === 2 : r.semana === Number(S.motSeg.slice(1)));
    const MO = E.computeMotivos(recs, M.canais);
    const q = E.normKey(S.motQ);
    const list = MO.lista.filter(m => !q || E.normKey(m.motivo).includes(q));
    const max = list.length ? list[0].total : 1;
    root.innerHTML = `
      ${S.unmapped.length ? `<div class="note">${S.unmapped.length} motivo(s) ainda não estão no De-Para e aparecem com o texto original. <a href="#config">Mapear em Configurações</a>.</div>` : ''}
      <div class="card" style="margin-top:10px">
        <div class="row" style="margin-bottom:10px">
          <h2 style="margin-right:auto">Motivos de atendimento</h2>
          <label>Recorte <select id="motSeg">${segs.map(s => `<option value="${s[0]}"${s[0] === S.motSeg ? ' selected' : ''}>${esc(s[1])}</option>`).join('')}</select></label>
          <input type="search" id="motQ" placeholder="Buscar motivo…" value="${esc(S.motQ)}">
          <button class="btn no-print" id="motCsv" type="button">Baixar CSV</button>
        </div>
        <p class="sub">${n0(recs.length)} atendimentos · ${n0(MO.total)} ocorrências de motivo · ${n0(MO.lista.length)} motivos distintos</p>
        <div class="tbl-wrap" style="max-height:640px;overflow:auto"><table><thead><tr><th>#</th><th class="l">Motivo</th>${M.canais.map(c => `<th>${esc(c)}</th>`).join('')}<th>Total</th><th>% do total</th></tr></thead><tbody>
        ${list.map((m, i) => `<tr><td>${MO.lista.indexOf(m) + 1}</td><td class="name">${esc(m.motivo)}</td>${M.canais.map(c => `<td>${n0(m.porCanal[c] || 0)}</td>`).join('')}<td><b>${n0(m.total)}</b></td><td>${pct(m.pct)}<span class="inbar" style="width:${Math.round(m.total / max * 70)}px"></span></td></tr>`).join('') || `<tr><td colspan="${M.canais.length + 4}" class="empty">Nenhum motivo encontrado.</td></tr>`}
        </tbody></table></div></div>`;
    $('#motSeg').onchange = e => { S.motSeg = e.target.value; renderMotivos(); };
    $('#motQ').oninput = e => { S.motQ = e.target.value; const pos = e.target.selectionStart; renderMotivos(); const i = $('#motQ'); i.focus(); i.setSelectionRange(pos, pos); };
    $('#motCsv').onclick = () => {
      const csv = [['Motivo', ...M.canais, 'Total', '% do total'], ...MO.lista.map(m => [m.motivo, ...M.canais.map(c => m.porCanal[c] || 0), m.total, (m.pct * 100).toFixed(2).replace('.', ',')])]
        .map(r => r.map(v => /[";\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(';')).join('\r\n');
      download('motivos_' + slug(S.per.label) + '.csv', '\ufeff' + csv);
    };
  }

  /* ---------- ATUALIZAR DADOS ---------- */
  function renderDados() {
    const root = $('#view-dados'), s = S.source, per = S.per || {};
    const first = per.first != null ? E.fmtDate(per.first) : '—', last = per.last != null ? E.fmtDate(per.last) : '—';
    const origem = s.kind === 'server' ? `Arquivo do servidor (<code>${esc(s.name)}</code>)${s.modified ? ', modificado em ' + fmtWhen(new Date(s.modified).getTime()) : ''}`
      : s.kind === 'local' ? `Arquivo enviado neste navegador${s.name ? ' (<code>' + esc(s.name) + '</code>)' : ''}, em ${fmtWhen(s.when)}` : 'Nenhum dado carregado';
    const canUp = CFG.permitirAtualizacaoPeloNavegador;
    root.innerHTML = `
      <div class="grid g-2">
        <div class="card"><h2>Situação atual</h2>
          <dl class="kv"><dt>Origem</dt><dd>${origem}</dd><dt>Linhas</dt><dd>${n0(S.rows.length)}</dd><dt>Datas na base</dt><dd>${first} a ${last}</dd>
          <dt>Período exibido</dt><dd>${esc(per.label || '—')}</dd></dl>
          <div class="row">
            <button class="btn" id="btnDl" type="button" ${S.rows.length ? '' : 'disabled'}>Baixar CSV tratado</button>
            <button class="btn" id="btnReload" type="button">Recarregar do servidor</button>
            ${s.kind === 'local' ? '<button class="btn danger" id="btnLocalOff" type="button">Descartar dados deste navegador</button>' : ''}
          </div>
          <p class="sub" style="margin-top:10px">O CSV tratado não contém nome, telefone nem outros dados pessoais do cliente: só o que o painel usa. É o arquivo certo para publicar no servidor.</p>
        </div>
        <div class="card"><h2>Atualizar para todos (no servidor)</h2>
          <p class="sub">Todo mundo que abrir o painel passa a ver o arquivo novo.</p>
          <ol class="steps">
            <li>Exporte o relatório de atendimentos no OPA (CSV ou Excel).</li>
            <li>Envie o arquivo aqui abaixo, confira a prévia e use <b>Baixar CSV tratado</b>.</li>
            <li>Substitua <code>${esc(CFG.dataUrl)}</code> no servidor/repositório por esse CSV.</li>
          </ol>
          <p class="sub" style="margin-top:8px">Se preferir automatizar, o script <code>tools/preparar_dados.py</code> faz os passos 2–3 pela linha de comando, e <code>dataUrl</code> em <code>js/config.js</code> também aceita um link externo.</p>
        </div>
      </div>
      ${canUp ? `<div class="grid g-2">
        <div class="card"><h2>Enviar arquivo</h2><p class="sub">CSV ou Excel (.xlsx) exportado do OPA. Fica salvo só neste navegador.</p>
          <div class="drop" id="drop" tabindex="0" role="button"><b>Clique para escolher</b> ou arraste o arquivo para cá</div>
          <input type="file" id="file" accept=".csv,.tsv,.txt,.xlsx" hidden>
        </div>
        <div class="card"><h2>Colar dados</h2><p class="sub">Copie as linhas no Excel (com o cabeçalho) e cole abaixo.</p>
          <textarea id="paste" placeholder="Canal&#9;Último atendente&#9;Motivos do atendimento&#9;Assumido em&#9;…"></textarea>
          <div class="row" style="margin-top:8px"><button class="btn" id="btnPaste" type="button">Ler texto colado</button></div>
        </div>
        <div class="card span2"><h2>Buscar de um link</h2><p class="sub">Link direto para um CSV/XLSX (por exemplo, Google Planilhas &gt; Arquivo &gt; Compartilhar &gt; Publicar na Web &gt; CSV). O site de origem precisa permitir acesso de outros sites (CORS).</p>
          <div class="row"><input type="url" id="url" placeholder="https://…" style="flex:1;min-width:240px"><button class="btn" id="btnUrl" type="button">Buscar</button></div>
        </div>
      </div>` : ''}
      <div id="pendingBox"></div>`;
    $('#btnDl').onclick = () => download('atendimentos.csv', P.rowsToCSV(S.rows, E.FIELDS, E.EXPORT_HEADERS));
    $('#btnReload').onclick = async () => {
      if (S.source.kind === 'local' && !confirm('Isso descarta os dados enviados neste navegador e volta a usar o arquivo do servidor. Continuar?')) return;
      try { await idb.del('dataset'); } catch (e) { /* ignore */ }
      await reloadFromServer(); renderChrome(); renderView();
    };
    const off = $('#btnLocalOff');
    if (off) off.onclick = () => $('#btnReload').click();
    if (canUp) {
      const drop = $('#drop'), file = $('#file');
      drop.onclick = () => file.click();
      drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') file.click(); };
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
      file.onchange = () => { if (file.files[0]) handleFile(file.files[0]); file.value = ''; };
      $('#btnPaste').onclick = () => { const t = $('#paste').value.trim(); if (!t) return toast('Cole os dados primeiro.'); stage(P.tableFromText(t), 'texto colado'); };
      $('#btnUrl').onclick = async () => {
        const u = $('#url').value.trim(); if (!u) return toast('Informe o link.');
        try { const { buf } = await fetchBuffer(u); stage(await P.tableFromFile(bufFile(u, buf)), u); }
        catch (e) { showPending({ error: 'Não consegui buscar o link: ' + e.message + '. Se o site não libera acesso externo (CORS), baixe o arquivo e envie-o por aqui.' }); }
      };
    }
    renderPending();
  }

  async function handleFile(f) {
    try { stage(await P.tableFromFile(f), f.name); }
    catch (e) { showPending({ error: e.message }); }
  }
  function stage(t, name) {
    const res = E.canonicalize(t.table);
    if (res.error) return showPending({ error: res.error });
    showPending({ rows: res.rows, warnings: res.warnings || [], name, kind: t.kind });
  }
  function showPending(p) { S.pending = p; renderPending(); const b = $('#pendingBox'); if (b) b.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

  const rowKey = r => r.protocolo || r.id || '';
  function renderPending() {
    const box = $('#pendingBox'); if (!box) return;
    const p = S.pending;
    if (!p) { box.innerHTML = ''; return; }
    if (p.error) { box.innerHTML = `<div class="note bad">${esc(p.error)}</div>`; return; }
    const recs = E.prepare(p.rows);
    const ts = recs.filter(r => r.ts != null).map(r => r.ts);
    const min = ts.length ? Math.min(...ts) : null, max = ts.length ? Math.max(...ts) : null;
    const canais = [...new Set(recs.map(r => r.canal))], ats = new Set(recs.map(r => r.atendente).filter(Boolean));
    const comAval = recs.filter(r => r.nota != null).length;
    const existing = new Map(S.rows.filter(r => rowKey(r)).map(r => [rowKey(r), 1]));
    const novas = p.rows.filter(r => rowKey(r) && !existing.has(rowKey(r))).length;
    const atual = p.rows.filter(r => rowKey(r) && existing.has(rowKey(r))).length;
    const semData = recs.length - ts.length;
    const hasKeys = p.rows.some(r => rowKey(r));
    box.innerHTML = `<div class="card" style="border-color:var(--accent)"><h2>Prévia do arquivo: ${esc(p.name)} <span class="pill mute">${esc(p.kind)}</span></h2>
      <dl class="kv"><dt>Linhas lidas</dt><dd>${n0(p.rows.length)}${semData ? ` (${n0(semData)} sem data válida)` : ''}</dd>
        <dt>Datas</dt><dd>${min != null ? E.fmtDate(min) + ' a ' + E.fmtDate(max) : '—'}</dd>
        <dt>Canais</dt><dd>${esc(canais.join(', ') || '—')}</dd><dt>Atendentes</dt><dd>${ats.size}</dd><dt>Com avaliação</dt><dd>${n0(comAval)}</dd>
        ${hasKeys ? `<dt>Em relação à base atual</dt><dd>${n0(novas)} novas · ${n0(atual)} já existentes (serão atualizadas)</dd>` : ''}</dl>
      ${p.warnings.map(w => `<div class="note">${esc(w)}</div>`).join('')}
      <div class="radio">
        <label><input type="radio" name="mode" value="replace" checked><span><b>Substituir tudo</b><br><span class="sub">A base passa a ser só este arquivo.</span></span></label>
        <label><input type="radio" name="mode" value="merge" ${hasKeys && S.rows.length ? '' : 'disabled'}><span><b>Acrescentar à base atual</b><br><span class="sub">Junta pelo Protocolo, sem duplicar (a linha nova prevalece).</span></span></label>
      </div>
      <div class="row"><button class="btn primary" id="btnApply" type="button" ${p.rows.length ? '' : 'disabled'}>Aplicar</button><button class="btn" id="btnCancel" type="button">Cancelar</button></div></div>`;
    $('#btnCancel').onclick = () => { S.pending = null; renderPending(); };
    $('#btnApply').onclick = () => applyPending(box.querySelector('input[name=mode]:checked').value);
  }

  async function applyPending(mode) {
    const p = S.pending; if (!p || !p.rows) return;
    let rows = p.rows;
    if (mode === 'merge') {
      const m = new Map(), extra = [];
      S.rows.forEach(r => { const k = rowKey(r); if (k) m.set(k, r); else extra.push(r); });
      p.rows.forEach(r => { const k = rowKey(r); if (k) m.set(k, r); else extra.push(r); });
      rows = [...m.values(), ...extra];
    }
    let saved = true;
    try { await idb.set('dataset', { rows, savedAt: Date.now(), name: p.name, kind: p.kind }); } catch (e) { saved = false; }
    S.source = { kind: 'local', name: p.name, when: Date.now() };
    S.loadError = ''; S.pending = null; S.period = { mode: 'auto', start: '', end: '' };
    setRows(rows);
    toast(saved ? `${n0(rows.length)} linhas carregadas e salvas neste navegador.` : 'Dados carregados, mas o navegador não deixou salvar: valem só até fechar a página.');
    location.hash = '#dashboard';
  }

  /* ---------- CONFIGURAÇÕES ---------- */
  function saveDepara() { ls.set('opa.depara', S.deparaList); S.deparaCustom = true; }
  function renderConfig() {
    const root = $('#view-config');
    const q = E.normKey(S.depQ);
    const list = S.deparaList.map((d, i) => ({ ...d, i })).filter(d => !q || E.normKey(d.key + ' ' + d.padrao).includes(q));
    root.innerHTML = `
      <div class="grid g-2">
        <div class="card"><h2>Ranking de atendentes</h2><p class="sub">Mínimo de avaliações para um atendente ser classificado como acima ou abaixo da média.</p>
          <div class="row"><input type="number" id="minAval" min="1" max="500" value="${esc(S.settings.minAval)}" style="width:90px"><button class="btn" id="btnMin" type="button">Salvar</button></div></div>
        <div class="card"><h2>Sobre esta instalação</h2>
          <dl class="kv"><dt>Arquivo de dados</dt><dd><code>${esc(CFG.dataUrl)}</code></dd><dt>De-Para</dt><dd><code>${esc(CFG.deParaUrl)}</code>${S.deparaCustom ? ' <span class="pill warn">editado neste navegador</span>' : ''}</dd>
          <dt>Atualização automática</dt><dd>${CFG.autoRefreshMinutes ? 'a cada ' + CFG.autoRefreshMinutes + ' min' : 'desligada'}</dd></dl>
          <p class="sub">Estes valores ficam em <code>js/config.js</code>.</p></div>
      </div>
      ${S.unmapped.length ? `<div class="card" style="margin-bottom:14px"><h2>Motivos sem padronização (${S.unmapped.length})</h2>
        <p class="sub">Aparecem nos relatórios com o texto original. Defina o nome padrão para agrupá-los.</p>
        <div class="tbl-wrap" style="max-height:300px;overflow:auto"><table><thead><tr><th>Texto original</th><th>Ocorrências</th><th>Nome padrão</th><th></th></tr></thead><tbody>
        ${S.unmapped.map((u, i) => `<tr><td class="name">${esc(u.exemplo)}</td><td>${n0(u.qtd)}</td><td class="l"><input type="text" data-un="${i}" value="${esc(E.properCase(u.exemplo))}" style="width:100%;min-width:200px"></td><td><button class="btn" data-add="${i}" type="button">Adicionar</button></td></tr>`).join('')}
        </tbody></table></div></div>` : ''}
      <div class="card"><div class="row" style="margin-bottom:8px"><h2 style="margin-right:auto">De-Para de motivos (${n0(S.deparaList.length)})</h2>
          <input type="search" id="depQ" placeholder="Buscar…" value="${esc(S.depQ)}">
          <button class="btn" id="depExp" type="button">Exportar CSV</button><button class="btn" id="depImp" type="button">Importar CSV</button>
          <button class="btn danger" id="depReset" type="button">Restaurar do servidor</button><input type="file" id="depFile" accept=".csv" hidden></div>
        <p class="sub">Une variações de escrita sob um nome padrão. As alterações valem neste navegador; para valer para todos, use <b>Exportar CSV</b> e substitua <code>${esc(CFG.deParaUrl)}</code> no servidor.</p>
        <div class="tbl-wrap" style="max-height:520px;overflow:auto"><table><thead><tr><th>Texto original (maiúsculas, sem pontos)</th><th>Nome padrão</th><th></th></tr></thead><tbody>
        ${list.map(d => `<tr><td class="name">${esc(d.key)}</td><td class="l"><input type="text" data-ed="${d.i}" value="${esc(d.padrao)}" style="width:100%;min-width:220px"></td><td><button class="btn danger" data-del="${d.i}" type="button">Remover</button></td></tr>`).join('')}
        <tr><td class="l"><input type="text" id="newKey" placeholder="Novo texto original" style="width:100%"></td><td class="l"><input type="text" id="newVal" placeholder="Nome padrão" style="width:100%"></td><td><button class="btn primary" id="newAdd" type="button">Adicionar</button></td></tr>
        </tbody></table></div></div>`;
    $('#btnMin').onclick = () => { const v = Math.max(1, parseInt($('#minAval').value, 10) || 10); S.settings.minAval = v; ls.set('opa.settings', S.settings); recompute(); toast('Mínimo de avaliações salvo.'); };
    root.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
      const u = S.unmapped[+b.dataset.add], v = root.querySelector(`[data-un="${b.dataset.add}"]`).value.trim();
      if (!v) return; S.deparaList.push({ key: u.key, padrao: v }); saveDepara(); rebuild(); toast('Mapeamento adicionado.');
    });
    root.querySelectorAll('[data-ed]').forEach(i => i.onchange = () => { S.deparaList[+i.dataset.ed].padrao = i.value.trim(); saveDepara(); const y = window.scrollY; rebuild(); window.scrollTo(0, y); });
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { S.deparaList.splice(+b.dataset.del, 1); saveDepara(); rebuild(); });
    $('#newAdd').onclick = () => {
      const k = E.motivoKey($('#newKey').value), v = $('#newVal').value.trim();
      if (!k || !v) return toast('Preencha o texto original e o nome padrão.');
      const ex = S.deparaList.find(d => d.key === k); if (ex) ex.padrao = v; else S.deparaList.push({ key: k, padrao: v });
      saveDepara(); rebuild(); toast('Mapeamento salvo.');
    };
    $('#depQ').oninput = e => { S.depQ = e.target.value; const pos = e.target.selectionStart; renderConfig(); const i = $('#depQ'); i.focus(); i.setSelectionRange(pos, pos); };
    $('#depExp').onclick = () => download('depara_motivos.csv', P.rowsToCSV(S.deparaList.map(d => ({ k: d.key, p: d.padrao })), ['k', 'p'], { k: 'Chave', p: 'Motivo_Padrao' }));
    $('#depImp').onclick = () => $('#depFile').click();
    $('#depFile').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const t = P.parseCSV(P.decodeBuffer(await f.arrayBuffer()));
      const list = t.slice(1).filter(r => r[0] && r[1]).map(r => ({ key: E.motivoKey(r[0]), padrao: String(r[1]).trim() }));
      if (!list.length) return toast('Não encontrei linhas válidas (duas colunas: texto original e nome padrão).');
      S.deparaList = list; saveDepara(); rebuild(); toast(`${list.length} mapeamentos importados.`);
    };
    $('#depReset').onclick = async () => {
      if (!confirm('Descartar as edições feitas neste navegador e voltar ao De-Para do servidor?')) return;
      ls.del('opa.depara'); await loadDepara(); rebuild(); toast('De-Para restaurado.');
    };
  }

  /* ---------- inicialização ---------- */
  function init() {
    C.initTip();
    $('#selPeriodo').onchange = e => {
      const v = e.target.value;
      if (v === 'auto') S.period = { mode: 'auto', start: '', end: '' };
      else if (v === 'custom') S.period = { mode: 'custom', start: S.per && !S.per.empty ? E.fmtISODay(S.per.start) : '', end: S.per && !S.per.empty ? E.fmtISODay(S.per.end) : '' };
      else S.period = { mode: 'month', start: v.slice(2), end: '' };
      recompute();
    };
    const dates = () => { S.period.start = $('#dtIni').value; S.period.end = $('#dtFim').value; recompute(); };
    $('#dtIni').onchange = dates; $('#dtFim').onchange = dates;
    $('#btnPrint').onclick = () => window.print();
    window.addEventListener('hashchange', route);
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.M && ['dashboard', 'avaliacoes'].includes(S.view)) renderView(); }, 150); });
    document.querySelectorAll('.tabs a').forEach(a => a.setAttribute('role', 'link'));
    $('#title').textContent = CFG.titulo; $('#subtitle').textContent = CFG.subtitulo;
    S.M = null;
    loadInitial().then(() => route());
    if (CFG.autoRefreshMinutes > 0) {
      setInterval(async () => { if (S.source.kind === 'server' && !S.pending) { await reloadFromServer(true); } }, CFG.autoRefreshMinutes * 60000);
    }
  }
  document.addEventListener('DOMContentLoaded', init);
})();
