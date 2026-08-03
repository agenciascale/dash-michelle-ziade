#requires -Version 5
<#
  build.ps1 — Dashboard de trafego (VENDA DIRETA) Michelle Ziade
  Le 2 planilhas Google via gviz CSV (compartilhadas por link) e gera data.js.

  Fontes:
    - Queries (Adveronix): Day, Campaign Name, Ad Set Name, Ad Name, Amount Spent,
      Impressions, Reach, Link Clicks, Landing Page Views, Purchases, Purchases Conversion Value
    - Vendas (Hotmart): Data/Hora, Evento, ..., Valor (R$), ...

  Modelo: daily[] (funil por dia, cruza Adveronix x Hotmart) + grain[] (por dia x anuncio).
  Atribuicao de compra = PIXEL (coluna Purchases do Adveronix). Hotmart = faturamento real.
  Imposto x1.1385 sobre TODO gasto (Meta Ads).
  Publica so agregados (sem PII da Hotmart).
#>
param([string]$Mode = "all")

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------- CONFIG ----------------
$SHEET_QUERIES = "1DE7dykx2Wb13hsXU5X0eohNF_GYAZVa4uFzRE_FHRlw"  # Adveronix (Planilha Michelle Ziade)
$GID_QUERIES   = "0"
$SHEET_VENDAS  = "1eOfyHZhI7Bd6gWrkRIrcvbBHH6HFhCW5bvlntiJdJEA"  # Hotmart vendas
$GID_VENDAS    = "0"
$TAX           = 1.1385   # imposto Meta Ads

# Filtro do LANCAMENTO (operacao atual): nome da campanha contem qualquer um destes (case/acento-insensitive)
# Mantem IHF-AGO26... e "TF | Topo..." (e as novas que seguirem esse padrao). Exclui as [VENDAS][IMERSAOHF11.07]* pre-operacao.
$LAUNCH_KEYS   = @("IHF", "TF | TOPO", "TF|TOPO")

$OutFile = Join-Path $PSScriptRoot "data.js"

# ---------------- HELPERS ----------------
function Get-Csv($sheetId, $gid) {
  $url = "https://docs.google.com/spreadsheets/d/$sheetId/gviz/tq?tqx=out:csv&gid=$gid"
  $tmp = [IO.Path]::GetTempFileName()
  try {
    $wc = New-Object System.Net.WebClient
    $wc.Encoding = [Text.Encoding]::UTF8
    $wc.DownloadFile($url, $tmp)   # WebClient segue redirect do gviz sozinho
    $lines = [IO.File]::ReadAllLines($tmp, [Text.Encoding]::UTF8)
  } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
  # gviz aspa TODO campo e separa por '","' ; sem newline embutido nos nossos dados
  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($ln in $lines) {
    if ([string]::IsNullOrEmpty($ln)) { continue }
    $t = $ln
    if ($t.StartsWith('"')) { $t = $t.Substring(1) }
    if ($t.EndsWith('"'))   { $t = $t.Substring(0, $t.Length - 1) }
    $rows.Add(($t -split '","'))
  }
  return $rows
}

function ToNum($s) {
  if ($null -eq $s) { return 0.0 }
  $x = ("$s").Trim()
  if ($x -eq "") { return 0.0 }
  $x = $x -replace '[^0-9,.\-]', ''       # tira R$, espacos, etc
  if ($x -eq "" -or $x -eq "-") { return 0.0 }
  # pt-BR: ponto = milhar, virgula = decimal
  if ($x.Contains(",")) { $x = ($x -replace '\.', '') -replace ',', '.' }
  $out = 0.0
  if ([double]::TryParse($x, [Globalization.NumberStyles]::Any, [Globalization.CultureInfo]::InvariantCulture, [ref]$out)) { return $out }
  return 0.0
}

function Norm($s) {
  # uppercase + remove acentos, pra casar filtro
  $u = ("$s").ToUpperInvariant()
  $n = $u.Normalize([Text.NormalizationForm]::FormD)
  $sb = New-Object Text.StringBuilder
  foreach ($c in $n.ToCharArray()) {
    if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($c) -ne [Globalization.UnicodeCategory]::NonSpacingMark) { [void]$sb.Append($c) }
  }
  return $sb.ToString()
}

function IsLaunch($campaign) {
  $c = Norm $campaign
  foreach ($k in $LAUNCH_KEYS) { if ($c.Contains((Norm $k))) { return $true } }
  return $false
}

function JsonStr($items) {
  # serializa cada item com ConvertTo-Json -Compress e junta -> garante array (evita bug de 1 elemento)
  if (-not $items -or $items.Count -eq 0) { return "[]" }
  $parts = foreach ($it in $items) { $it | ConvertTo-Json -Compress -Depth 6 }
  return "[" + ($parts -join ",") + "]"
}

# ---------------- QUERIES (Adveronix) ----------------
Write-Host "Baixando Queries (Adveronix)..."
$q = Get-Csv $SHEET_QUERIES $GID_QUERIES
# header: 0 Day,1 Campaign,2 AdSet,3 Ad,4 Spend,5 Impr,6 Reach,7 Clicks,8 LPV,9 Purch,10 Value
# (+ opcional) coluna de CHECKOUT INICIADO do PIXEL ("Website Checkouts Initiated" /
#   "Initiate Checkout" / "Finalizacao de compra"), localizada por NOME de cabecalho —
#   robusto a posicao. Se a coluna nao existir, icpx=0 e o front usa fallback Hotmart.
$grain = New-Object System.Collections.Generic.List[object]
$dq = @{}   # date -> agregados adveronix do lancamento
$icCol = -1
if ($q.Count -gt 0) {
  $hdr = $q[0]
  for ($i = 0; $i -lt $hdr.Count; $i++) {
    $h = Norm $hdr[$i]
    # quer a CONTAGEM de "Website Checkouts Initiated" — ignora custo/valor/unique/mobile e o evento "Website Checkouts" (sem Initiated).
    if ((($h -match 'CHECKOUT') -and ($h -match 'INITIAT') -and ($h -notmatch 'COST|CUSTO|VALUE|VALOR|UNIQUE|MOBILE|PER ')) -or (($h -match 'FINALIZ') -and ($h -match 'COMPRA') -and ($h -notmatch 'CUSTO|VALOR|VALUE'))) { $icCol = $i; break }
  }
}
if ($icCol -ge 0) { Write-Host ("  coluna checkout-pixel: indice {0} ('{1}')" -f $icCol, $q[0][$icCol]) }
else { Write-Host "  coluna checkout-pixel: NAO encontrada (front usa fallback Hotmart)" }
$skipHdr = $true
foreach ($r in $q) {
  if ($skipHdr) { $skipHdr = $false; continue }
  if ($r.Count -lt 11) { continue }
  $day = ("$($r[0])").Trim()
  if ($day -notmatch '^\d{4}-\d{2}-\d{2}$') { continue }
  $camp = ("$($r[1])").Trim()
  if (-not (IsLaunch $camp)) { continue }
  $spend = (ToNum $r[4]) * $TAX
  $impr  = [int](ToNum $r[5]); $reach = [int](ToNum $r[6]); $clk = [int](ToNum $r[7])
  $lpv   = [int](ToNum $r[8]); $pur = [int](ToNum $r[9]); $val = (ToNum $r[10])
  $icpx  = if ($icCol -ge 0 -and $r.Count -gt $icCol) { [int](ToNum $r[$icCol]) } else { 0 }
  $grain.Add([ordered]@{ d=$day; camp=$camp; adset=("$($r[2])").Trim(); ad=("$($r[3])").Trim();
    spend=[math]::Round($spend,2); impr=$impr; reach=$reach; clk=$clk; lpv=$lpv; pur=$pur; val=[math]::Round($val,2); icpx=$icpx })
  if (-not $dq.ContainsKey($day)) { $dq[$day] = @{ spend=0.0; impr=0; clk=0; lpv=0; pur=0; val=0.0; icpx=0 } }
  $dq[$day].spend += $spend; $dq[$day].impr += $impr; $dq[$day].clk += $clk
  $dq[$day].lpv += $lpv; $dq[$day].pur += $pur; $dq[$day].val += $val; $dq[$day].icpx += $icpx
}
Write-Host ("  linhas do lancamento: {0} | dias: {1}" -f $grain.Count, $dq.Keys.Count)

# ---------------- VENDAS (Hotmart) ----------------
Write-Host "Baixando Vendas (Hotmart)..."
$v = Get-Csv $SHEET_VENDAS $GID_VENDAS
# header: 0 Data/Hora,1 Evento,2 Transacao,3 Produto,4 Comprador,5 Email,6 Telefone,7 Valor,...
$dv = @{}   # date -> { vendas, fat, checkouts }
$skipHdr = $true
foreach ($r in $v) {
  if ($skipHdr) { $skipHdr = $false; continue }
  if ($r.Count -lt 8) { continue }
  $dt = ("$($r[0])").Trim()
  # "21/07/2026 13:44:00" -> 2026-07-21
  if ($dt -notmatch '^(\d{2})/(\d{2})/(\d{4})') { continue }
  $day = "{0}-{1}-{2}" -f $matches[3], $matches[2], $matches[1]
  $ev = ("$($r[1])").Trim().ToUpperInvariant()
  if (-not $dv.ContainsKey($day)) { $dv[$day] = @{ vendas=0; fat=0.0; checkouts=0 } }
  if ($ev -eq "PURCHASE_APPROVED") {
    $dv[$day].vendas += 1
    $dv[$day].fat += (ToNum $r[7])
  } elseif ($ev -eq "PURCHASE_OUT_OF_SHOPPING_CART") {
    $dv[$day].checkouts += 1
  }
}
$totVendas = 0; ($dv.Values | ForEach-Object { $totVendas += $_.vendas })
Write-Host ("  dias com evento: {0} | vendas aprovadas: {1}" -f $dv.Keys.Count, $totVendas)

# ---------------- MERGE daily ----------------
$allDays = New-Object System.Collections.Generic.SortedSet[string]
foreach ($k in $dq.Keys) { [void]$allDays.Add($k) }
foreach ($k in $dv.Keys) { [void]$allDays.Add($k) }
$daily = New-Object System.Collections.Generic.List[object]
foreach ($day in $allDays) {
  $a = $dq[$day]; $s = $dv[$day]
  $spend = if ($a) { $a.spend } else { 0.0 }
  $impr  = if ($a) { $a.impr }  else { 0 }
  $clk   = if ($a) { $a.clk }   else { 0 }
  $lpv   = if ($a) { $a.lpv }   else { 0 }
  $pur   = if ($a) { $a.pur }   else { 0 }
  $pval  = if ($a) { $a.val }   else { 0.0 }
  $vend  = if ($s) { $s.vendas }    else { 0 }
  $fat   = if ($s) { $s.fat }       else { 0.0 }
  $chk   = if ($s) { $s.checkouts } else { 0 }
  $icpx  = if ($a) { $a.icpx }      else { 0 }
  $daily.Add([ordered]@{ d=$day; spend=[math]::Round($spend,2); impr=$impr; clk=$clk; lpv=$lpv;
    purPixel=$pur; valPixel=[math]::Round($pval,2); vendas=$vend; fat=[math]::Round($fat,2); checkouts=$chk; icPixel=$icpx })
}

# ---------------- OUTPUT data.js ----------------
$now = [DateTime]::UtcNow.AddHours(-3)   # BRT
$meta = [ordered]@{ generatedAt = $now.ToString("yyyy-MM-dd HH:mm"); tz="BRT"; tax=$TAX; launchKeys=$LAUNCH_KEYS; product="Imersao Transformando seu Conhecimento em Investimento" }

$js = "window.DASH=" + ($meta | ConvertTo-Json -Compress -Depth 4) + ";" + [Environment]::NewLine
$js += "window.DASH.daily=" + (JsonStr $daily) + ";" + [Environment]::NewLine
$js += "window.DASH.grain=" + (JsonStr $grain) + ";" + [Environment]::NewLine

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($OutFile, $js, $utf8NoBom)
Write-Host ("OK -> {0} ({1:n0} bytes) | dias={2} grain={3}" -f $OutFile, (Get-Item $OutFile).Length, $daily.Count, $grain.Count)
