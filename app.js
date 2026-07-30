(function () {
  "use strict";
  var D = window.DASH || {};
  var arr = function (x) { return Array.isArray(x) ? x : (x ? [x] : []); };
  var daily = arr(D.daily).slice().sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
  var grain = arr(D.grain);

  // ---------- helpers ----------
  var nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  var nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function money(v) { return 'R$ ' + nf2.format(v || 0); }
  function money0(v) { return 'R$ ' + nf0.format(Math.round(v || 0)); }
  function int(v) { return nf0.format(Math.round(v || 0)); }
  function pct(v) { return (new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format((v || 0) * 100)) + '%'; }
  function num2(v) { return nf2.format(v || 0); }
  function div(a, b) { return b ? a / b : 0; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function el(id) { return document.getElementById(id); }

  function dayAdd(ds, n) {
    var p = ds.split('-'); var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  }
  function brDate(ds) { var p = ds.split('-'); return p[2] + '/' + p[1]; }

  // ---------- period ----------
  var minDate = daily.length ? daily[0].d : '2026-01-01';
  var maxDate = daily.length ? daily[daily.length - 1].d : '2026-01-01';

  function firstOfMonth(ds) { return ds.slice(0, 7) + '-01'; }
  function lastOfMonth(ds) {
    var p = ds.split('-'); var dt = new Date(Date.UTC(+p[0], +p[1], 0));
    return dt.toISOString().slice(0, 10);
  }
  function addMonths(ds, n) {
    var p = ds.split('-'); var dt = new Date(Date.UTC(+p[0], (+p[1] - 1) + n, 1));
    return dt.toISOString().slice(0, 10);
  }
  function clampDate(ds) { return ds < minDate ? minDate : (ds > maxDate ? maxDate : ds); }

  var PERIODS = [
    { k: 'today', label: 'Hoje' },
    { k: 'yesterday', label: 'Ontem' },
    { k: '7d', label: 'Últimos 7 dias' },
    { k: '14d', label: 'Últimos 14 dias' },
    { k: '30d', label: 'Últimos 30 dias' },
    { k: 'month', label: 'Este mês' },
    { k: 'lastmonth', label: 'Mês passado' },
    { k: 'all', label: 'Tudo' }
  ];
  var state = { period: 'all', tab: 'ad', customStart: null, customEnd: null };

  function resolveRange() {
    var y, fp;
    switch (state.period) {
      case 'custom': return { start: state.customStart, end: state.customEnd };
      case 'today': return { start: maxDate, end: maxDate };
      case 'yesterday': y = dayAdd(maxDate, -1); return { start: y, end: y };
      case '7d': return { start: dayAdd(maxDate, -6), end: maxDate };
      case '14d': return { start: dayAdd(maxDate, -13), end: maxDate };
      case '30d': return { start: dayAdd(maxDate, -29), end: maxDate };
      case 'month': return { start: firstOfMonth(maxDate), end: maxDate };
      case 'lastmonth': fp = addMonths(firstOfMonth(maxDate), -1); return { start: fp, end: lastOfMonth(fp) };
      default: return { start: minDate, end: maxDate };
    }
  }
  function daysInRange(r) {
    var a = new Date(r.start + 'T00:00:00Z'), b = new Date(r.end + 'T00:00:00Z');
    return Math.round((b - a) / 86400000) + 1;
  }
  function prevOf(r) {
    if (state.period === 'all') return null;
    var len = daysInRange(r);
    var end = dayAdd(r.start, -1);
    return { start: dayAdd(end, -(len - 1)), end: end };
  }
  function within(d, r) { return d >= r.start && d <= r.end; }

  function aggDaily(r) {
    var o = { spend: 0, impr: 0, clk: 0, lpv: 0, purPixel: 0, valPixel: 0, vendas: 0, fat: 0, checkouts: 0 };
    for (var i = 0; i < daily.length; i++) {
      var x = daily[i]; if (!within(x.d, r)) continue;
      o.spend += x.spend; o.impr += x.impr; o.clk += x.clk; o.lpv += x.lpv;
      o.purPixel += x.purPixel; o.valPixel += x.valPixel;
      o.vendas += x.vendas; o.fat += x.fat; o.checkouts += x.checkouts;
    }
    return o;
  }

  // ---------- render ----------
  function render() {
    var r = resolveRange();
    var pr = prevOf(r);
    var cur = aggDaily(r);
    var prev = pr ? aggDaily(pr) : null;
    cur.spendVenda = spendByFunnel(r).Venda;
    if (prev) prev.spendVenda = spendByFunnel(pr).Venda;

    renderPeriods();
    syncDateInputs(r);
    var nd = daysInRange(r);
    el('range').textContent = brDateFull(r.start) + ' → ' + brDateFull(r.end) + ' (' + nd + (nd === 1 ? ' dia' : ' dias') + ')' + (pr ? '  ·  vs ' + brDateFull(pr.start) + ' → ' + brDateFull(pr.end) : '');
    renderRevBlock(cur);
    renderFunilInv(r);
    renderKpis(cur, prev);
    renderFunnel(cur);
    renderChart(r);
    renderTable(r);
    renderHint();
  }

  function brDateFull(ds) { var p = ds.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

  function renderPeriods() {
    el('periods').innerHTML = PERIODS.map(function (p) {
      return '<button data-k="' + p.k + '" class="' + (p.k === state.period ? 'on' : '') + '">' + p.label + '</button>';
    }).join('');
    Array.prototype.forEach.call(el('periods').children, function (b) {
      b.onclick = function () { state.period = b.getAttribute('data-k'); render(); };
    });
  }

  function syncDateInputs(r) {
    var s = el('dtStart'), e = el('dtEnd');
    if (!s || !e) return;
    s.value = r.start; e.value = r.end;
  }
  function initDateInputs() {
    var s = el('dtStart'), e = el('dtEnd'), b = el('applyRange');
    if (!s || !e || !b) return;
    s.min = e.min = minDate; s.max = e.max = maxDate;
    b.onclick = function () {
      var a = s.value, c = e.value;
      if (!a || !c) return;
      if (a > c) { var t = a; a = c; c = t; }
      state.period = 'custom';
      state.customStart = clampDate(a);
      state.customEnd = clampDate(c);
      render();
    };
  }

  function deltaHtml(curV, prevV, goodUp) {
    if (prevV == null) return '';
    if (!prevV && !curV) return '<span class="delta flat">—</span>';
    if (!prevV) return '<span class="delta ' + (goodUp ? 'up' : 'down') + '">novo</span>';
    var ch = (curV - prevV) / prevV;
    var cls = ch === 0 ? 'flat' : ((ch > 0) === goodUp ? 'up' : 'down');
    var ar = ch > 0 ? '▲' : (ch < 0 ? '▼' : '•');
    return '<span class="delta ' + cls + '">' + ar + ' ' + pct(Math.abs(ch)) + '</span>';
  }

  function kpiCard(lbl, val, sm, delta, foot, cls) {
    return '<div class="card kpi ' + (cls || '') + '">' +
      '<div class="lbl">' + lbl + '</div>' +
      '<div class="val ' + (sm ? 'sm' : '') + '">' + val + '</div>' +
      (delta || '') + (foot ? '<div class="foot">' + foot + '</div>' : '') + '</div>';
  }

  function renderKpis(c, p) {
    var sv = c.spendVenda || 0;
    var svP = p ? (p.spendVenda || 0) : null;
    var roas = div(c.fat, sv);
    var roasP = p ? div(p.fat, svP) : null;
    var ticket = div(c.fat, c.vendas);
    var cac = div(sv, c.vendas);
    var ic = c.vendas + c.checkouts;
    var icP = p ? (p.vendas + p.checkouts) : null;
    var cards = [
      kpiCard('Investimento total', money0(c.spend), false, deltaHtml(c.spend, p && p.spend, false), 'Topo + Venda · imposto ×1,1385', 'accent-l'),
      kpiCard('Faturamento (Hotmart)', money0(c.fat), false, deltaHtml(c.fat, p && p.fat, true), int(c.vendas) + ' venda(s) aprovada(s)'),
      kpiCard('ROAS real', num2(roas) + 'x', false, deltaHtml(roas, roasP, true), 'faturamento ÷ invest. em venda'),
      kpiCard('Ticket médio', c.vendas ? money(ticket) : '—', true, '', 'por venda Hotmart'),
      kpiCard('CAC (custo/venda)', c.vendas ? money(cac) : '—', true, deltaHtml(c.vendas ? cac : 0, p && p.vendas ? div(svP, p.vendas) : null, false), 'invest. venda ÷ vendas'),
      kpiCard('Iniciar checkout (IC)', int(ic), false, deltaHtml(ic, icP, true), 'Hotmart: chegaram ao checkout'),
      kpiCard('Taxa de checkout', c.lpv ? pct(div(ic, c.lpv)) : '—', true, '', 'IC ÷ landing page views'),
      kpiCard('Conversão de checkout', ic ? pct(div(c.vendas, ic)) : '—', true, '', 'vendas ÷ IC')
    ];
    el('kpis').innerHTML = cards.join('');
  }

  function taxMult() { return (D.tax || 1.1385).toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 }); }

  function funnelOf(camp) {
    var c = String(camp || '').toUpperCase();
    if (c.indexOf('TOPO') >= 0) return 'Topo';
    if (/\bVND\b|E4-VEN|IHF|VENDA/.test(c)) return 'Venda';
    return 'Outros';
  }
  function spendByFunnel(r) {
    var o = { Topo: 0, Venda: 0, Outros: 0, total: 0 };
    for (var i = 0; i < grain.length; i++) {
      var x = grain[i]; if (!within(x.d, r)) continue;
      o[funnelOf(x.camp)] += x.spend; o.total += x.spend;
    }
    return o;
  }
  var FUNIL_META = {
    'Topo': { color: 'var(--cyan)', desc: 'topo de funil (alcance / visita ao perfil)' },
    'Venda': { color: 'var(--brand)', desc: 'conversão / venda direta' },
    'Outros': { color: 'var(--tx3)', desc: 'demais campanhas' }
  };

  function renderRevBlock(c) {
    var sv = c.spendVenda || 0;
    var roas = div(c.fat, sv);
    var preTax = sv / (D.tax || 1.1385);
    el('revblock').innerHTML =
      '<div class="rev-card rev-inv"><div class="rev-top">💸 Investimento <span class="sub">em venda</span></div>' +
        '<div class="rev-val" style="color:var(--brand)">' + money0(sv) + '</div>' +
        '<div class="rev-sub">só campanha de venda · sem imposto ' + money0(preTax) + '</div></div>' +
      '<div class="rev-conn">→</div>' +
      '<div class="rev-card rev-rec"><div class="rev-top">💰 Faturamento <span class="sub">Hotmart</span></div>' +
        '<div class="rev-val" style="color:var(--green)">' + money0(c.fat) + '</div>' +
        '<div class="rev-sub">' + int(c.vendas) + ' venda(s) aprovada(s)</div></div>' +
      '<div class="rev-conn">=</div>' +
      '<div class="rev-card rev-roas"><div class="rev-top">📈 ROAS <span class="sub">real</span></div>' +
        '<div class="rev-val" style="color:var(--violet)">' + num2(roas) + 'x</div>' +
        '<div class="rev-sub">faturamento ÷ investimento</div></div>';
  }

  function renderFunilInv(r) {
    var g = {}, total = 0;
    for (var i = 0; i < grain.length; i++) {
      var x = grain[i]; if (!within(x.d, r)) continue;
      var f = funnelOf(x.camp);
      if (!g[f]) g[f] = { spend: 0, clk: 0, lpv: 0, pur: 0, impr: 0 };
      g[f].spend += x.spend; g[f].clk += x.clk; g[f].lpv += x.lpv; g[f].pur += x.pur; g[f].impr += x.impr;
      total += x.spend;
    }
    var cards = ['Topo', 'Venda', 'Outros'].filter(function (k) { return g[k]; }).map(function (k) {
      var o = g[k], m = FUNIL_META[k];
      var share = total ? o.spend / total : 0;
      var detail = (k === 'Venda')
        ? (int(o.pur) + ' compra(s) · ' + int(o.lpv) + ' LPV')
        : (int(o.impr) + ' impressões · ' + int(o.clk) + ' cliques');
      return '<div class="card funil"><div class="fshare">' + pct(share) + '</div>' +
        '<div class="ftop"><span class="fico" style="background:' + m.color + '"></span>' + k + '</div>' +
        '<div class="fmain" style="color:' + m.color + '">' + money0(o.spend) + '</div>' +
        '<div class="fmeta">' + m.desc + '<br>' + detail + '</div></div>';
    });
    cards.push('<div class="card funil total"><div class="ftop">Σ Total</div>' +
      '<div class="fmain">' + money0(total) + '</div>' +
      '<div class="fmeta">soma dos funis · com imposto ×' + taxMult() + '</div></div>');
    el('funilInv').innerHTML = cards.join('');
  }

  function renderFunnel(c) {
    var ic = c.vendas + c.checkouts; // Iniciar Checkout (Hotmart: aprovadas + abandonos)
    var stages = [
      { n: 'Impressões', v: c.impr, fmt: int, col: 'var(--brand)' },
      { n: 'Cliques no link', v: c.clk, fmt: int, col: 'var(--brand2)', conv: 'CTR ' + pct(div(c.clk, c.impr)) },
      { n: 'Landing Page Views', v: c.lpv, fmt: int, col: 'var(--cyan)', conv: pct(div(c.lpv, c.clk)) + ' dos cliques' },
      { n: 'Iniciar checkout (IC)', v: ic, fmt: int, col: 'var(--amber)', conv: 'Taxa de checkout: ' + pct(div(ic, c.lpv)) + ' das LPV' },
      { n: 'Vendas (Hotmart)', v: c.vendas, fmt: int, col: 'var(--green)', conv: 'Conversão de checkout: ' + pct(div(c.vendas, ic)) + ' dos IC' }
    ];
    var max = Math.max(1, c.impr);
    var html = '<div class="fstage" style="margin-bottom:16px"><div class="fhead"><span class="fn">Investimento</span>' +
      '<span class="fv" style="color:var(--tx)">' + money(c.spend) + '</span></div></div>';
    html += stages.map(function (s) {
      var w = Math.max(0.6, (s.v / max) * 100);
      return '<div class="fstage"><div class="fhead"><span class="fn">' + s.n + '</span><span class="fv" style="color:' + s.col + '">' + s.fmt(s.v) + '</span></div>' +
        '<div class="fbar-bg"><div class="fbar" style="width:' + w + '%;background:' + s.col + '"></div></div>' +
        (s.conv ? '<div class="fconv">' + s.conv + '</div>' : '') + '</div>';
    }).join('');
    el('funnel').innerHTML = html;
  }

  // ---------- chart ----------
  function renderChart(r) {
    var days = [];
    for (var i = 0; i < daily.length; i++) { if (within(daily[i].d, r)) days.push(daily[i]); }
    var svg = el('chart');
    el('legend').innerHTML = '<span><i style="background:var(--brand)"></i>Investimento/dia</span>' +
      '<span><i style="background:var(--green)"></i>Venda (Hotmart)</span>' +
      '<span><i style="background:var(--amber)"></i>Checkout iniciado</span>';
    if (!days.length) { svg.innerHTML = ''; return; }
    var W = 1000, H = 230, padL = 44, padR = 12, padB = 26, padT = 12;
    var iw = W - padL - padR, ih = H - padT - padB;
    var maxSpend = Math.max.apply(null, days.map(function (d) { return d.spend; }).concat([1]));
    var bw = iw / days.length;
    var s = '';
    // y grid (4 lines)
    for (var g = 0; g <= 4; g++) {
      var yv = maxSpend * g / 4; var y = padT + ih - (yv / maxSpend) * ih;
      s += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="var(--line2)" stroke-width="1"/>';
      s += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="var(--tx3)">' + money0(yv) + '</text>';
    }
    // bars + markers
    for (var j = 0; j < days.length; j++) {
      var d = days[j];
      var bh = (d.spend / maxSpend) * ih;
      var x = padL + j * bw;
      var bx = x + bw * 0.18, bwid = bw * 0.64;
      s += '<rect x="' + bx.toFixed(1) + '" y="' + (padT + ih - bh).toFixed(1) + '" width="' + bwid.toFixed(1) + '" height="' + Math.max(0, bh).toFixed(1) + '" rx="2" fill="var(--brand)" opacity="0.85"><title>' + brDateFull(d.d) + '\n' + money(d.spend) + '</title></rect>';
      var cx = x + bw / 2;
      if (d.vendas > 0) { s += '<circle cx="' + cx.toFixed(1) + '" cy="' + (padT + 8) + '" r="5" fill="var(--green)"><title>' + brDateFull(d.d) + '\n' + int(d.vendas) + ' venda(s) · ' + money(d.fat) + '</title></circle>'; }
      if (d.checkouts > 0) { s += '<circle cx="' + cx.toFixed(1) + '" cy="' + (padT + 20) + '" r="4" fill="var(--amber)"><title>' + int(d.checkouts) + ' checkout(s) iniciado(s)</title></circle>'; }
      if (days.length <= 40 || j % Math.ceil(days.length / 20) === 0) {
        s += '<text x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="9" fill="var(--tx3)">' + brDate(d.d) + '</text>';
      }
    }
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.innerHTML = s;
  }

  // ---------- table ----------
  var TABS = [{ k: 'camp', label: 'Campanha' }, { k: 'adset', label: 'Conjunto' }, { k: 'ad', label: 'Anúncio' }];
  var sortState = { col: 'spend', dir: -1 };

  function groupKey(row, tab) {
    if (tab === 'camp') return row.camp;
    if (tab === 'adset') return row.camp + ' ‖ ' + row.adset;
    return row.camp + ' ‖ ' + row.adset + ' ‖ ' + row.ad;
  }
  function groupName(row, tab) {
    if (tab === 'camp') return row.camp;
    if (tab === 'adset') return row.adset;
    return row.ad;
  }

  function renderTabs() {
    el('tabs').innerHTML = TABS.map(function (t) {
      return '<button data-k="' + t.k + '" class="' + (t.k === state.tab ? 'on' : '') + '">' + t.label + '</button>';
    }).join('');
    Array.prototype.forEach.call(el('tabs').children, function (b) {
      b.onclick = function () { state.tab = b.getAttribute('data-k'); render(); };
    });
  }

  function renderTable(r) {
    renderTabs();
    var groups = {};
    for (var i = 0; i < grain.length; i++) {
      var g = grain[i]; if (!within(g.d, r)) continue;
      var key = groupKey(g, state.tab);
      if (!groups[key]) groups[key] = { name: groupName(g, state.tab), sub: g.camp, spend: 0, impr: 0, clk: 0, lpv: 0, pur: 0, val: 0 };
      var o = groups[key];
      o.spend += g.spend; o.impr += g.impr; o.clk += g.clk; o.lpv += g.lpv; o.pur += g.pur; o.val += g.val;
    }
    var rows = Object.keys(groups).map(function (k) {
      var o = groups[k];
      o.cpm = div(o.spend, o.impr) * 1000;
      o.ctr = div(o.clk, o.impr);
      o.cpc = div(o.spend, o.clk);
      o.custoLpv = div(o.spend, o.lpv);
      o.custoCompra = o.pur ? div(o.spend, o.pur) : Infinity;
      o.roas = div(o.val, o.spend);
      return o;
    });
    // best cost/purchase among those with purchases
    var withPur = rows.filter(function (x) { return x.pur > 0; });
    var bestCC = withPur.length ? Math.min.apply(null, withPur.map(function (x) { return x.custoCompra; })) : null;

    rows.sort(function (a, b) {
      var av = a[sortState.col], bv = b[sortState.col];
      if (sortState.col === 'name') { av = a.name; bv = b.name; return (av < bv ? -1 : av > bv ? 1 : 0) * -sortState.dir; }
      if (av === Infinity) av = -1; if (bv === Infinity) bv = -1;
      return (av - bv) * sortState.dir;
    });

    var cols = [
      { k: 'name', t: state.tab === 'camp' ? 'Campanha' : (state.tab === 'adset' ? 'Conjunto' : 'Anúncio') },
      { k: 'spend', t: 'Gasto' }, { k: 'cpm', t: 'CPM' }, { k: 'ctr', t: 'CTR' }, { k: 'cpc', t: 'CPC' },
      { k: 'lpv', t: 'LPV' }, { k: 'custoLpv', t: 'Custo/LPV' }, { k: 'pur', t: 'Compras' },
      { k: 'custoCompra', t: 'Custo/compra' }, { k: 'roas', t: 'ROAS' }
    ];
    if (!rows.length) { el('table').innerHTML = '<div class="empty">Sem dados de anúncios neste período.</div>'; return; }
    var thead = '<tr>' + cols.map(function (c) {
      return '<th data-k="' + c.k + '" class="' + (sortState.col === c.k ? 'sorted' : '') + '">' + c.t + (sortState.col === c.k ? (sortState.dir < 0 ? ' ↓' : ' ↑') : '') + '</th>';
    }).join('') + '</tr>';
    var tbody = rows.map(function (o) {
      var ccCell = o.pur ? money(o.custoCompra) : '<span class="muted">—</span>';
      if (o.pur && bestCC != null && o.custoCompra === bestCC) ccCell = '<span class="pill good">' + money(o.custoCompra) + '</span>';
      var roasCell = o.pur ? (num2(o.roas) + 'x') : '<span class="muted">—</span>';
      return '<tr>' +
        '<td title="' + esc(o.name) + '">' + esc(o.name) + '</td>' +
        '<td>' + money(o.spend) + '</td>' +
        '<td>' + money(o.cpm) + '</td>' +
        '<td>' + pct(o.ctr) + '</td>' +
        '<td>' + (o.clk ? money(o.cpc) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + int(o.lpv) + '</td>' +
        '<td>' + (o.lpv ? money(o.custoLpv) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + int(o.pur) + '</td>' +
        '<td>' + ccCell + '</td>' +
        '<td>' + roasCell + '</td>' +
        '</tr>';
    }).join('');
    el('table').innerHTML = '<table><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>';
    Array.prototype.forEach.call(el('table').querySelectorAll('th'), function (th) {
      th.onclick = function () {
        var k = th.getAttribute('data-k');
        if (sortState.col === k) sortState.dir *= -1; else { sortState.col = k; sortState.dir = k === 'name' ? 1 : -1; }
        render();
      };
    });
  }

  function renderHint() {
    var keys = arr(D.launchKeys).join(', ');
    el('hint').innerHTML = 'Faturamento e vendas: <b>Hotmart</b> (fonte da verdade). ' +
      'A tabela de otimização usa o <b>pixel</b> (Adveronix, <code>2070377586792193</code>) só para atribuir compras por anúncio — sinal de otimização, não de faturamento. ' +
      'Filtro do lançamento: campanhas contendo <b>' + esc(keys) + '</b>. Gasto com imposto ×' + num2(D.tax || 1.1385) + '. ' +
      'Somente leitura — nada é alterado nas planilhas. ' +
      '<br><b>IC (iniciar checkout)</b> = quem chegou ao checkout da Hotmart (aprovadas + abandonos) · <b>Taxa de checkout</b> = IC ÷ LPV · <b>Conversão de checkout</b> = vendas ÷ IC. ' +
      '<br>As campanhas do lançamento começaram no aquecimento (mai/jun) e as vendas em julho — use o seletor de período para focar na janela que interessa.';
  }

  // ---------- boot ----------
  el('upd').innerHTML = '<span class="dot"></span>Atualizado: ' + esc(D.generatedAt || '—') + ' ' + esc(D.tz || 'BRT');
  el('taxNote').innerHTML = '💸 Gasto inclui imposto × ' + taxMult() + ' (13,85%)';
  if (!daily.length) {
    el('kpis').innerHTML = '<div class="empty">Sem dados. Rode o build.</div>';
  } else {
    initDateInputs();
    render();
  }
})();
