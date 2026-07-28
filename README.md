# Dashboard — Imersão Michelle Ziade (venda direta)

Dashboard de tráfego (funil de venda direta) hospedado no GitHub Pages, 100% na nuvem.

- **Fonte anúncios:** planilha do Adveronix (Pixel `2070377586792193`), lida via gviz CSV.
- **Fonte vendas:** planilha da Hotmart (faturamento real, só `PURCHASE_APPROVED`).
- **Atribuição por anúncio:** pelo pixel (o Meta atribui a compra ao criativo).
- **Filtro do lançamento:** campanhas contendo `IHF`, `IMERSÃO` ou `TF | Topo`.
- **Imposto:** ×1,1385 sobre todo o gasto (Meta Ads).

## Como funciona
`build.ps1` baixa as 2 planilhas, filtra o lançamento, cruza e gera `data.js`.
O site estático (`index.html` + `app.js` + `styles.css`) lê `data.js` direto — sem libs, gráficos SVG na mão.
O GitHub Actions (`.github/workflows/build.yml`) roda o build e publica no Pages. Disparado pelo cron-job.org a cada 3h via `workflow_dispatch`.

Somente leitura — nunca altera as planilhas. Publica só agregados (sem PII da Hotmart).
