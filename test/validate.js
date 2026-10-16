// Compara o motor JS com os valores calculados pela planilha original (test/expected.json).
// Uso: node test/validate.js
const fs = require('fs'), path = require('path');
const E = require('../js/engine.js'), P = require('../js/parser.js');
const root = path.join(__dirname, '..');
const exp = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected.json'), 'utf8'));

const table = P.parseCSV(fs.readFileSync(path.join(root, 'data/atendimentos.csv'), 'utf8'));
const { rows, error } = E.canonicalize(table); if (error) throw new Error(error);
const dep = E.buildDepara(P.parseCSV(fs.readFileSync(path.join(root, 'data/depara_motivos.csv'), 'utf8')).slice(1).map(r => ({ key: r[0], padrao: r[1] })));
const recs = E.prepare(rows); const unm = E.applyDepara(recs, dep);
const per = E.resolvePeriod(recs, {});
const M = E.compute(E.filterPeriod(recs, per), { maxDia: per.maxDia, minAvaliacoes: 10, tmaMaxMin: 0 });
console.log('Período:', per.label, '| linhas:', rows.length, '| não mapeados:', unm.length);

let fails = 0, checks = 0;
const eq = (name, a, b, tol = 0.006) => {
  checks++;
  const ok = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= tol : String(a) === String(b);
  if (!ok) { fails++; console.log('  ✗', name, '| js =', a, '| planilha =', b); }
};
const arr = (name, A, B, tol) => { A.forEach((a, i) => eq(`${name}[${i}]`, a, B[i] == null ? 0 : B[i], tol)); };

eq('total', M.kpi.total, exp.dash.total);
eq('TMA geral', M.kpi.tma, exp.dash.tmaGeral, 0.001);
arr('vol dia', M.dia.map(d => d.total), exp.dia_total);
arr('tma dia', M.dia.map(d => d.tma), exp.dia_tma);
arr('vol turno', M.turno.map(d => d.total), exp.turno_total);
arr('tma turno', M.turno.map(d => d.tma), exp.turno_tma);
arr('canal', M.canal.map(d => d.total), exp.canal);
arr('hora n', M.hora.filter(h => h.hora >= 6).map(h => h.total), exp.hora_n);
arr('hora tma', M.hora.filter(h => h.hora >= 6).map(h => h.tma), exp.hora_tma);
// atendentes (a planilha só lista nomes conhecidos)
exp.atend_nomes.slice(0, 18).forEach((n, i) => {
  const a = M.atendentes.find(x => x.nome.toLowerCase() === String(n).toLowerCase());
  eq('atend ' + n, a ? a.total : 0, exp.atend_total[i]);
});
exp.top15.forEach((t, i) => { const m = M.motivos.lista[i]; eq('top' + (i + 1) + ' nome', m.motivo, t[0]); eq('top' + (i + 1) + ' qtd', m.total, t[1]); eq('top' + (i + 1) + ' % (base da planilha: só motivos do De-Para)', m.total / (M.motivos.total - unm.reduce((a, u) => a + u.qtd, 0)), t[2], 0.0001); });
arr('dist notas', M.notas.dist.map(d => d.qtd), exp.dist);
eq('satisfeitos', M.notas.grupos[0].qtd, exp.grupos[0]);
eq('insatisfeitos', M.notas.grupos[2].qtd, exp.grupos[2]);
eq('avaliações', M.notas.n, exp.ind.n);
eq('nota média', M.kpi.nota, exp.ind.media, 1e-6);
eq('taxa resposta', M.kpi.taxaResp, exp.ind.taxa, 1e-6);
eq('CSAT', M.kpi.csat, exp.ind.csat, 1e-6);
eq('insatisfação', M.kpi.insat, exp.ind.insat, 1e-6);
arr('nota por dia', M.notas.porDia.map(d => d.media), exp.nota_dia);
arr('nota por dia n', M.notas.porDia.map(d => d.n), exp.nota_dia_n);
// ranking: compara pessoas nomeadas da planilha (exceto "Outros" e inativos)
exp.ranking.filter(r => r[0] && !/Outros|INATIVO/.test(r[0]) && r[2] >= 10).forEach(r => {
  const a = M.atendentes.find(x => x.nome.toLowerCase() === r[0].toLowerCase());
  eq('rank nota ' + r[0], a ? a.media : -1, r[3], 1e-6); eq('rank aval ' + r[0], a ? a.nAval : -1, r[2]);
});
const M24 = E.compute(E.filterPeriod(recs, per), { maxDia: per.maxDia, minAvaliacoes: 10, tmaMaxMin: 1440 });
console.log('TMA ponderado sem teto:', M.kpi.tma, '| com teto de 24h:', M24.kpi.tma, '| excluídos:', M24.kpi.tmaExcluidos, '| mediana:', M24.kpi.tmaMediana.toFixed(1));
console.log(`\n${checks - fails}/${checks} conferências batem com a planilha.`);
console.log('Neutros (planilha mostrava 0 por problema de locale):', M.notas.grupos[1].qtd);
console.log('KPIs:', JSON.stringify(M.kpi, null, 0).slice(0, 700));
process.exit(fails ? 1 : 0);
