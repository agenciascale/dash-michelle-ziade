/**
 * Webhook Hotmart -> Google Sheets (Michelle Ziade)
 * Substitui o Make. 100% gratuito, sem limite de operacoes.
 *
 * Planilha: Vendas Hotmart - Michelle (1eOfyHZhI7Bd6gWrkRIrcvbBHH6HFhCW5bvlntiJdJEA)
 * Aba: Vendas
 * Colunas (A->N): Data/Hora, Evento, Transacao, Produto, Comprador, E-mail,
 *                 Telefone, Valor (R$), Pagamento, Parcelas, Oferta, Afiliado,
 *                 Origem (SCK), Recebido em
 *
 * v2 (05/08/2026): a Origem(SCK) vinha VAZIA. Causa: o Hotmart 2.0.0 passou a
 * mandar o SCK no objeto NOVO `purchase.origin` (campos sck/src/xcode), e o
 * webhook lia so o antigo `purchase.tracking.source_sck`. Agora le do origin
 * primeiro, com fallbacks + varredura profunda, e loga origin/tracking numa
 * aba `_debug` pra confirmar a estrutura real de cada venda.
 *
 * DEPLOY: Implementar > Gerenciar implementacoes > (a existente) > editar (lapis)
 *   > Versao: Nova versao > Implementar.  (mantem a MESMA URL /exec, nao troca
 *   nada na Hotmart). Executar como: Eu | Quem acessa: Qualquer pessoa.
 */

var SHEET_ID = '1eOfyHZhI7Bd6gWrkRIrcvbBHH6HFhCW5bvlntiJdJEA';
var TAB = 'Vendas';
var TZ = 'America/Sao_Paulo';

// procura recursivamente a 1a chave chamada 'sck' (ou 'source_sck') com valor string nao-vazio
function deepFindSck(obj, depth) {
  if (obj == null || depth > 6) return '';
  if (typeof obj !== 'object') return '';
  for (var k in obj) {
    var v = obj[k];
    var kl = String(k).toLowerCase();
    if ((kl === 'sck' || kl === 'source_sck') && typeof v === 'string' && v.trim() !== '') return v;
    if (v && typeof v === 'object') {
      var r = deepFindSck(v, (depth || 0) + 1);
      if (r) return r;
    }
  }
  return '';
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // evita 2 webhooks gravarem na mesma linha
  try {
    var body = JSON.parse(e.postData.contents);

    var d        = body.data || {};
    var buyer    = d.buyer || {};
    var purchase = d.purchase || {};
    var product  = d.product || {};
    var price    = purchase.price || {};
    var payment  = purchase.payment || {};
    var offer    = purchase.offer || {};
    var tracking = purchase.tracking || {};
    var origin   = purchase.origin || {};   // <-- objeto NOVO do Hotmart 2.0.0 (sck/src/xcode)
    var affils   = d.affiliations || [];

    // Data/Hora a partir do creation_date (epoch ms). Fallback: agora.
    var cd = body.creation_date ? new Date(Number(body.creation_date)) : new Date();
    var dataHora = Utilities.formatDate(cd, TZ, 'dd/MM/yyyy HH:mm:ss');
    var recebido = Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy');

    // Origem (SCK): objeto NOVO origin.sck -> antigo tracking.source_sck -> src -> varredura profunda.
    var sck = origin.sck || tracking.source_sck || '';
    var src = origin.src || tracking.source || '';
    var origem = String(sck || src || deepFindSck(body, 0) || '').trim();

    var afiliado = (affils.length && affils[0] && affils[0].name) ? affils[0].name : '';

    var row = [
      dataHora,                                   // A Data/Hora
      String(body.event || '').toUpperCase(),     // B Evento
      purchase.transaction || '',                 // C Transacao
      product.name || '',                         // D Produto
      buyer.name || '',                           // E Comprador
      buyer.email || '',                          // F E-mail
      buyer.checkout_phone || '',                 // G Telefone
      (price.value != null ? price.value : ''),   // H Valor (R$)
      payment.type || '',                         // I Pagamento
      payment.installments_number || '',          // J Parcelas
      offer.code || '',                           // K Oferta
      afiliado,                                   // L Afiliado
      origem,                                     // M Origem (SCK)
      recebido                                    // N Recebido em
    ];

    SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB).appendRow(row);

    // _debug: guarda origin/tracking de cada venda pra confirmar de onde vem o SCK.
    // (Pode apagar a aba _debug depois que confirmar que a coluna M enche.)
    try {
      var ss = SpreadsheetApp.openById(SHEET_ID);
      var dbg = ss.getSheetByName('_debug') || ss.insertSheet('_debug');
      dbg.appendRow([new Date(), purchase.transaction || '', String(body.event || ''),
        'origem=' + origem, 'origin=' + JSON.stringify(origin), 'tracking=' + JSON.stringify(tracking)]);
    } catch (e3) {}

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    // Loga o payload cru numa aba de erro pra depurar sem perder a venda.
    try {
      var ss2 = SpreadsheetApp.openById(SHEET_ID);
      var log = ss2.getSheetByName('_erros') || ss2.insertSheet('_erros');
      log.appendRow([new Date(), String(err), e && e.postData ? e.postData.contents : '']);
    } catch (e2) {}
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// Opcional: abrir a URL /exec no navegador retorna isto (teste de vida).
function doGet() {
  return ContentService.createTextOutput('Webhook Hotmart ativo.');
}
