/* Gráficos SVG sem dependências: barras (vertical/horizontal/empilhadas), barras + linha, rosca. */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nf = (v, d = 0) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / p;
    const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return n * p;
  }
  function ticks(max, n) { const t = []; for (let i = 0; i <= n; i++) t.push(max * i / n); return t; }

  function legend(items) {
    return '<div class="legend">' + items.map(i => `<span><i style="background:${i.color}${i.line ? ';height:3px;align-self:center' : ''}"></i>${esc(i.name)}</span>`).join('') + '</div>';
  }
  function empty(el, msg) { el.innerHTML = `<div class="empty">${esc(msg || 'Sem dados no período.')}</div>`; }

  function bar(el, o) {
    const labels = o.labels, n = labels.length;
    const series = o.series || [];
    const fmt = o.fmt || (v => nf(v));
    const anyData = series.some(s => s.values.some(v => v > 0)) || (o.line && o.line.values.some(v => v > 0));
    if (!n || !anyData) return empty(el, o.empty);
    const W = Math.max(280, el.clientWidth || 600);
    const horizontal = !!o.horizontal;
    const leg = [...series.map(s => ({ name: s.name, color: s.color })), ...(o.line ? [{ name: o.line.name, color: o.line.color, line: true }] : [])];
    const showLeg = leg.length > 1 || o.legend;
    let svg = '', H;

    if (horizontal) {
      const maxLab = Math.min(o.maxLabel || 26, Math.max(...labels.map(l => String(l).length)));
      const L = Math.min(190, Math.max(70, maxLab * 6.6 + 12)), R = 52, rowH = o.rowH || 26;
      H = n * rowH + 24;
      const plotW = W - L - R;
      const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
      const max = niceMax(Math.max(...totals));
      const x = v => L + plotW * v / max;
      svg += ticks(max, 4).map(t => `<line class="gl" x1="${x(t)}" x2="${x(t)}" y1="6" y2="${H - 18}"/><text class="ax" x="${x(t)}" y="${H - 4}" text-anchor="middle">${nf(t)}</text>`).join('');
      labels.forEach((lab, i) => {
        const y = 8 + i * rowH, bh = rowH - 9;
        const txt = String(lab).length > 28 ? String(lab).slice(0, 27) + '…' : String(lab);
        svg += `<text class="lab" x="${L - 8}" y="${y + bh / 2 + 4}" text-anchor="end"><title>${esc(lab)}</title>${esc(txt)}</text>`;
        let acc = 0;
        series.forEach(s => {
          const v = s.values[i] || 0; if (!v) return;
          svg += `<rect class="b" x="${x(acc)}" y="${y}" width="${Math.max(1, x(acc + v) - x(acc))}" height="${bh}" rx="2" fill="${s.color}" data-tip="${esc(lab)}|${esc(s.name)}: ${fmt(v)}"/>`;
          acc += v;
        });
        if (acc) svg += `<text class="val" x="${x(acc) + 5}" y="${y + bh / 2 + 4}">${fmt(acc)}</text>`;
      });
    } else {
      H = o.height || 250;
      const hasLine = !!o.line;
      const L = 44, R = hasLine ? 46 : 10, T = 10, B = 28;
      const plotW = W - L - R, plotH = H - T - B;
      const totals = labels.map((_, i) => o.stacked ? series.reduce((a, s) => a + (s.values[i] || 0), 0) : Math.max(0, ...series.map(s => s.values[i] || 0)));
      const max = niceMax(Math.max(...totals, 0));
      const y = v => T + plotH - plotH * v / max;
      const band = plotW / n;
      svg += ticks(max, 4).map(t => `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${nf(t, max < 5 ? 1 : 0)}</text>`).join('');
      const step = Math.max(1, Math.ceil(15 / band));
      const barW = o.stacked || series.length === 1 ? Math.min(40, band * 0.72) : Math.min(40, band * 0.8) / series.length;
      labels.forEach((lab, i) => {
        const cx = L + band * i + band / 2;
        if (i % step === 0) svg += `<text class="ax" x="${cx}" y="${H - 9}" text-anchor="middle">${esc(lab)}</text>`;
        let acc = 0;
        series.forEach((s, si) => {
          const v = s.values[i] || 0; if (!v) return;
          const bw = o.stacked || series.length === 1 ? barW : barW;
          const bx = o.stacked || series.length === 1 ? cx - barW / 2 : cx - (barW * series.length) / 2 + si * barW;
          const y0 = o.stacked ? y(acc) : y(0), y1 = o.stacked ? y(acc + v) : y(v);
          svg += `<rect class="b" x="${bx}" y="${y1}" width="${Math.max(1, bw - (o.stacked ? 0 : 1))}" height="${Math.max(1, y0 - y1)}" rx="1.5" fill="${s.color}" data-tip="${esc(lab)}|${esc(s.name)}: ${fmt(v)}"/>`;
          acc += v;
        });
        if (o.valueLabels && band >= 26 && totals[i]) svg += `<text class="val" x="${cx}" y="${y(totals[i]) - 4}" text-anchor="middle">${fmt(totals[i])}</text>`;
      });
      if (hasLine) {
        const lv = o.line.values;
        const m2 = niceMax(Math.max(...lv.map(v => v || 0)));
        const y2 = v => T + plotH - plotH * v / m2;
        const lf = o.line.fmt || (v => nf(v, 1));
        svg += ticks(m2, 4).map(t => `<text class="ax ax2" x="${W - R + 6}" y="${y2(t) + 4}">${nf(t, m2 < 5 ? 1 : 0)}</text>`).join('');
        let d = '', pen = false;
        lv.forEach((v, i) => {
          if (v == null || v === 0) { pen = false; return; }
          const px = L + band * i + band / 2;
          d += (pen ? 'L' : 'M') + px.toFixed(1) + ' ' + y2(v).toFixed(1); pen = true;
        });
        svg += `<path d="${d}" fill="none" stroke="${o.line.color}" stroke-width="2" stroke-linejoin="round"/>`;
        lv.forEach((v, i) => {
          if (v == null || v === 0) return;
          const px = L + band * i + band / 2;
          svg += `<circle class="pt" cx="${px}" cy="${y2(v)}" r="3.5" fill="${o.line.color}" data-tip="${esc(labels[i])}|${esc(o.line.name)}: ${lf(v)}"/>`;
        });
      }
    }
    el.innerHTML = (showLeg ? legend(leg) : '') +
      `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(o.title || 'Gráfico')}">${svg}</svg>`;
  }

  function donut(el, o) {
    const items = o.items.filter(i => i.value > 0);
    const tot = items.reduce((a, i) => a + i.value, 0);
    if (!tot) return empty(el, o.empty);
    const S = 190, c = S / 2, r = 78, w = 26;
    let a0 = -Math.PI / 2, paths = '';
    items.forEach(it => {
      const frac = it.value / tot, a1 = a0 + frac * 2 * Math.PI;
      const big = frac > 0.5 ? 1 : 0;
      const p = (a, rr) => [c + rr * Math.cos(a), c + rr * Math.sin(a)];
      const [x0, y0] = p(a0, r), [x1, y1] = p(a1 - (frac === 1 ? 0.0001 : 0), r);
      paths += `<path class="b" d="M${x0} ${y0} A${r} ${r} 0 ${big} 1 ${x1} ${y1}" fill="none" stroke="${it.color}" stroke-width="${w}" data-tip="${esc(it.label)}|${nf(it.value)} (${nf(frac * 100, 1)}%)"/>`;
      a0 = a1;
    });
    el.innerHTML = `<div class="donut"><svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="${esc(o.title || 'Gráfico')}">${paths}
      <text class="big" x="${c}" y="${c + 4}" text-anchor="middle">${esc(o.big || '')}</text>
      <text class="ax" x="${c}" y="${c + 22}" text-anchor="middle">${esc(o.small || '')}</text></svg>
      <ul class="dlegend">${items.map(i => `<li><i style="background:${i.color}"></i><span>${esc(i.label)}</span><b>${nf(i.value)}</b><em>${nf(i.value / tot * 100, 1)}%</em></li>`).join('')}</ul></div>`;
  }

  /* tooltip único, por delegação */
  let tip;
  function initTip() {
    if (tip) return;
    tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; document.body.appendChild(tip);
    document.addEventListener('mouseover', e => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t) { tip.hidden = true; return; }
      const [h, b] = t.getAttribute('data-tip').split('|');
      tip.innerHTML = `<b>${h}</b><span>${b}</span>`; tip.hidden = false;
    });
    document.addEventListener('mousemove', e => {
      if (tip.hidden) return;
      const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
      tip.style.left = x + 'px'; tip.style.top = Math.max(8, e.clientY - tip.offsetHeight - 12) + 'px';
    });
    document.addEventListener('scroll', () => { tip.hidden = true; }, true);
  }

  root.Charts = { bar, donut, initTip, nf, esc };
})(window);
