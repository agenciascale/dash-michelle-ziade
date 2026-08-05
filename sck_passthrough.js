<!-- ============================================================
     Repasse de origem (Meta Ads -> Hotmart SCK) - Michelle Ziade
     Cole ISTO no codigo do site (Hostinger: Editar site ->
     Configuracoes -> Integracoes / Codigo personalizado).
     Funciona em todas as paginas de uma vez.

     O que faz: le os UTMs que vem do anuncio na URL da landing e,
     em todo botao que aponta pro checkout da Hotmart, adiciona:
        src = utm_source            (ex.: meta-ads)
        sck = campanha|conjunto|anuncio  (atribuicao por criativo)
     Preserva o ?checkoutMode=10 que ja existe.
     Guarda os UTMs na sessao, entao sobrevive a navegacao entre
     paginas do funil.

     v2 (05/08/2026): o construtor do Hostinger injeta os botoes DEPOIS
     do load, entao o rewrite antigo (so no DOMContentLoaded) rodava
     cedo demais e os botoes ficavam sem sck. Agora reescreve tambem
     via MutationObserver + re-runs, pegando botoes criados a qualquer
     momento. Por isso as vendas vinham com Origem(SCK) vazia.
     ============================================================ -->
<script>
(function () {
  var HOTMART_RX = /(^|\.)hotmart\.com$|hotm\.art$/i;
  var KEY = 'mz_utms';

  function clean(v, max) {
    if (!v) return '';
    v = decodeURIComponent(String(v)).trim();
    v = v.replace(/\s+/g, '-')          // espaco -> hifen
         .replace(/[^A-Za-z0-9._-]/g, '') // so alfanumerico . _ -
         .replace(/-+/g, '-')
         .replace(/^-|-$/g, '');
    if (max && v.length > max) v = v.slice(0, max);
    return v;
  }

  // 1) Captura os UTMs da URL atual e mescla com o que ja estava na sessao
  function collectUTMs() {
    var qs = new URLSearchParams(location.search);
    var stored = {};
    try { stored = JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch (e) {}
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','src','sck']
      .forEach(function (k) {
        var val = qs.get(k);
        if (val) stored[k] = val;         // URL nova sobrescreve
      });
    try { sessionStorage.setItem(KEY, JSON.stringify(stored)); } catch (e) {}
    return stored;
  }

  // 2) Monta src e sck a partir dos UTMs
  function buildTracking(u) {
    var src = clean(u.src || u.utm_source || '', 60);
    // sck = campanha|conjunto|anuncio (o que estiver disponivel)
    var parts = [u.utm_campaign, u.utm_medium, u.utm_content]
      .map(function (p) { return clean(p, 40); })
      .filter(Boolean);
    var sck = clean(u.sck, 100) || parts.join('|');
    if (sck.length > 100) sck = sck.slice(0, 100);
    return { src: src, sck: sck, u: u };
  }

  // 3) Reescreve um link de checkout preservando o que ja existe
  function rewrite(a, t) {
    var url;
    try { url = new URL(a.href); } catch (e) { return; }
    if (!HOTMART_RX.test(url.hostname)) return;
    if (url.searchParams.get('sck')) return; // ja tem, nao mexe (evita retrabalho)
    if (t.src && !url.searchParams.get('src')) url.searchParams.set('src', t.src);
    if (t.sck && !url.searchParams.get('sck')) url.searchParams.set('sck', t.sck);
    // repassa os UTMs crus tambem (futuro-proof p/ analytics da Hotmart)
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term']
      .forEach(function (k) {
        if (t.u[k] && !url.searchParams.get(k)) url.searchParams.set(k, t.u[k]);
      });
    a.href = url.toString();
  }

  function rewriteAll() {
    var t = buildTracking(collectUTMs());
    if (!t.src && !t.sck) return; // sem origem, nao mexe
    document.querySelectorAll('a[href]').forEach(function (a) { rewrite(a, t); });
  }

  // roda cedo, no load, e algumas vezes depois (Hostinger injeta botoes tarde)
  if (document.readyState !== 'loading') rewriteAll();
  else document.addEventListener('DOMContentLoaded', rewriteAll);
  window.addEventListener('load', rewriteAll);
  [400, 1000, 2000, 3500, 6000].forEach(function (ms) { setTimeout(rewriteAll, ms); });

  // MutationObserver: reescreve qualquer botao/link que apareca DEPOIS
  var scheduled = false;
  function schedule() {
    if (scheduled) return; scheduled = true;
    (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () {
      scheduled = false; rewriteAll();
    });
  }
  function startObserver() {
    if (!window.MutationObserver || !document.body) return;
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver);

  // ...e tambem no instante do clique (ultima linha de defesa)
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a) rewrite(a, buildTracking(collectUTMs()));
  }, true);
})();
</script>
