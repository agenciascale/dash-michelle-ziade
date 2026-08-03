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
 * DEPLOY: Implementar > Nova implementacao > App da Web
 *   - Executar como: Eu
 *   - Quem tem acesso: QUALQUER PESSOA  (nao "com conta Google")
 *   Copie a URL /exec e cole no webhook da Hotmart.
 */

var SHEET_ID = '1eOfyHZhI7Bd6gWrkRIrcvbBHH6HFhCW5bvlntiJdJEA';
var TAB = 'Vendas';
var TZ = 'America/Sao_Paulo';

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
    var affils   = d.affiliations || [];

    // Data/Hora a partir do creation_date (epoch ms). Fallback: agora.
    var cd = body.creation_date ? new Date(Number(body.creation_date)) : new Date();
    var dataHora = Utilities.formatDate(cd, TZ, 'dd/MM/yyyy HH:mm:ss');
    var recebido = Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy');

    // Origem (SCK): prioriza o sck; se vazio usa src; senao o UTM source.
    var origem = tracking.source_sck || tracking.source || '';

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

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    // Loga o payload cru numa aba de erro pra depurar sem perder a venda.
    try {
      var ss = SpreadsheetApp.openById(SHEET_ID);
      var log = ss.getSheetByName('_erros') || ss.insertSheet('_erros');
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
