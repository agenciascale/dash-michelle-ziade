/**
 * Webhook Hotmart -> Google Sheets — OBRA NA PRATICA (low ticket R$97, perpetuo)
 * Michelle Ziade. Grava CADA compra aprovada na planilha de extracao.
 *
 * Planilha destino: 1ad4BD2MWBodq4AVTBDYIc-l2aM8g7CeOGURFgqPFeHA (aba Página1 / gid 0)
 * Colunas (A->N):
 *   A data_venda | B nome | C email | D telefone | E utm_source | F utm_campaign |
 *   G utm_medium | H utm_content | I utm_term | J faturamento | K produto |
 *   L pais | M estado | N cidade
 *
 * Origem/UTMs: vem do passthrough da LP (src=utm_source, sck=campanha|conjunto|anuncio)
 * que a Hotmart repassa em purchase.origin / purchase.tracking. Le o utm_* cru
 * primeiro (se a Hotmart mandar) e cai pro src/sck como fallback.
 *
 * DEPLOY: Implementar > Nova implementacao > Tipo: App da Web >
 *   Executar como: Eu | Quem pode acessar: Qualquer pessoa > Implementar.
 *   Copie a URL /exec e cole no Webhook da Hotmart (produto Obra na Pratica).
 */

var SHEET_ID = '1ad4BD2MWBodq4AVTBDYIc-l2aM8g7CeOGURFgqPFeHA';
var TAB = 'Página1';                 // aba onde caem as vendas (gid 0)
var TZ  = 'America/Sao_Paulo';

// So grava estes eventos (compra confirmada). Deixe vazio [] pra gravar tudo.
var ONLY_EVENTS = ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE'];

// --- TRAVA (garante que so a venda certa entre) ---
// Os 3 "OBRA NA PRATICA" so se distinguem pela OFERTA. Este e o criterio certo.
// Aceita lista. Pra TESTAR com o simulador da Hotmart, adicione 'test' aqui
// temporariamente (o simulador manda offer.code="test") e depois remova.
var ONLY_OFFER_CODE = ['17gdpna9','test'];   // oferta R$97 + 'test' (simulador). REMOVER 'test' apos validar!
// Filtros extras opcionais (deixe '' / 0 pra ignorar):
var ONLY_PRODUCT_ID = '';    // ID numerico do produto (se um dia precisar)
var ONLY_PRICE      = 0;     // OU valor exato. Ex: 97
var ONLY_NAME_HAS   = '';    // OU trecho do nome (minusculo)

// Loga tracking/origin de CADA venda gravada na aba _debug (pra confirmar de onde
// vem o UTM na 1a venda real). Deixe true ate a 1a venda real; depois pode por false.
var DEBUG_TRACKING = true;

// procura recursivamente a 1a chave 'sck'/'source_sck' com string nao-vazia
function deepFindSck(obj, depth) {
  if (obj == null || depth > 6 || typeof obj !== 'object') return '';
  for (var k in obj) {
    var v = obj[k], kl = String(k).toLowerCase();
    if ((kl === 'sck' || kl === 'source_sck') && typeof v === 'string' && v.trim() !== '') return v;
    if (v && typeof v === 'object') { var r = deepFindSck(v, (depth || 0) + 1); if (r) return r; }
  }
  return '';
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);              // evita 2 webhooks gravarem na mesma linha
  try {
    var body = JSON.parse(e.postData.contents);
    var ev = String(body.event || '').toUpperCase();

    // Filtro de eventos (ignora carrinho abandonado, reembolso, etc.)
    if (ONLY_EVENTS.length && ONLY_EVENTS.indexOf(ev) === -1) {
      return ContentService.createTextOutput(JSON.stringify({ ok: true, skipped: ev }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var d        = body.data || {};
    var buyer    = d.buyer || {};
    var addr     = buyer.address || {};
    var purchase = d.purchase || {};
    var product  = d.product || {};
    var price    = purchase.price || {};
    var offer    = purchase.offer || {};
    var tracking = purchase.tracking || {};
    var origin   = purchase.origin || {};

    // --- TRAVA: so grava se bater o criterio configurado ---
    // (os 3 "OBRA NA PRATICA" so se distinguem pela OFERTA; nome nao serve)
    var okOffers = [].concat(ONLY_OFFER_CODE).filter(String);   // aceita string ou lista
    if (okOffers.length && okOffers.indexOf(String(offer.code || '')) === -1) {
      // Loga o que chegou pra diagnostico (confirmar offer.code / product.id reais).
      // Pode apagar a aba _debug depois que a 1a venda certa cair.
      try {
        var ssd = SpreadsheetApp.openById(SHEET_ID);
        var dbg = ssd.getSheetByName('_debug') || ssd.insertSheet('_debug');
        dbg.appendRow([new Date(), 'SKIP offer', 'event=' + ev,
          'offer.code=' + (offer.code || ''), 'product.id=' + (product.id || ''),
          'product.name=' + (product.name || ''), 'price=' + (price.value || '')]);
      } catch (e4) {}
      return ContentService.createTextOutput(JSON.stringify({ ok: true, skipped: 'offer', got: offer.code || '' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (ONLY_PRODUCT_ID && String(product.id || '') !== String(ONLY_PRODUCT_ID)) {
      return ContentService.createTextOutput(JSON.stringify({ ok: true, skipped: 'product' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (ONLY_PRICE && Number(price.value) !== Number(ONLY_PRICE)) {
      return ContentService.createTextOutput(JSON.stringify({ ok: true, skipped: 'price' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (ONLY_NAME_HAS && String(product.name || '').toLowerCase().indexOf(ONLY_NAME_HAS.toLowerCase()) === -1) {
      return ContentService.createTextOutput(JSON.stringify({ ok: true, skipped: 'name' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Data da venda (creation_date epoch ms). Fallback: agora.
    var cd = body.creation_date ? new Date(Number(body.creation_date)) : new Date();
    var dataVenda = Utilities.formatDate(cd, TZ, 'dd/MM/yyyy HH:mm:ss');

    // --- UTMs ---
    // A LP empacota a atribuicao no "src": source|medium|campaign|content
    // (ex.: meta|publico_frio|f.f_pf_vendas|ad9_video09-06_11). "sck"/"direto" = fallback.
    // Usa a string que tem "|" (a empacotada); senao cai pro valor cru (ex.: "direto").
    var srcRaw = origin.src || tracking.source || '';
    var sckRaw = origin.sck || tracking.source_sck || deepFindSck(body, 0) || '';
    var packed = (String(srcRaw).indexOf('|') > -1) ? srcRaw
               : (String(sckRaw).indexOf('|') > -1) ? sckRaw
               : (srcRaw || sckRaw);
    var p = String(packed).split('|');
    var utm_source   = tracking.utm_source   || origin.utm_source   || p[0] || '';
    var utm_medium   = tracking.utm_medium   || origin.utm_medium   || p[1] || '';
    var utm_campaign = tracking.utm_campaign || origin.utm_campaign || p[2] || '';
    var utm_content  = tracking.utm_content  || origin.utm_content  || p[3] || '';
    var utm_term     = tracking.utm_term     || origin.utm_term     || '';

    var row = [
      dataVenda,                                    // A data_venda
      buyer.name || '',                             // B nome
      buyer.email || '',                            // C email
      buyer.checkout_phone || '',                   // D telefone
      String(utm_source).trim(),                    // E utm_source
      String(utm_campaign).trim(),                  // F utm_campaign
      String(utm_medium).trim(),                    // G utm_medium
      String(utm_content).trim(),                   // H utm_content
      String(utm_term).trim(),                      // I utm_term
      (price.value != null ? price.value : ''),     // J faturamento
      product.name || '',                           // K produto
      addr.country || addr.country_iso || '',       // L pais
      addr.state || '',                             // M estado
      addr.city || ''                               // N cidade
    ];

    var ss0 = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss0.getSheetByName(TAB) || ss0.getSheets()[0];   // fallback: 1a aba (gid 0)
    sheet.appendRow(row);

    // Diagnostico da 1a venda real: mostra de onde saiu o UTM (tracking/origin/sck).
    if (DEBUG_TRACKING) {
      try {
        var dbg2 = ss0.getSheetByName('_debug') || ss0.insertSheet('_debug');
        dbg2.appendRow([new Date(), 'OK gravou', purchase.transaction || '',
          'offer=' + (offer.code || ''), 'packed=' + packed,
          'tracking=' + JSON.stringify(tracking), 'origin=' + JSON.stringify(origin),
          'sckPaymentLink=' + (purchase.sckPaymentLink || '')]);
      } catch (e5) {}
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    // Loga o payload cru numa aba de erro pra depurar sem perder a venda.
    try {
      var ss = SpreadsheetApp.openById(SHEET_ID);
      var log = ss.getSheetByName('_erros') || ss.insertSheet('_erros');
      log.appendRow([new Date(), String(err), e && e.postData ? e.postData.contents : '']);
    } catch (e2) {}
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// Abrir a URL /exec no navegador retorna isto (teste de vida).
function doGet() {
  return ContentService.createTextOutput('Webhook Obra na Pratica ativo.');
}
