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
$GID_QUERIES   = "0"                                            # aba "Página1 IHF" (gid 0 mesmo apos rename)
$SHEET_VENDAS  = "1eOfyHZhI7Bd6gWrkRIrcvbBHH6HFhCW5bvlntiJdJEA"  # Hotmart vendas (Imersao)
$GID_VENDAS    = "0"
# --- PERPETUO "Obra na Pratica" (POP, low-ticket) ---
# Nome da aba do Adveronix URL-encoded (ASCII) p/ PS5.1 nao mangear o acento: "Página2 POP"
$POP_QUERIES_TAB_ENC = "P%C3%A1gina2%20POP"                      # aba filtrada em Contains POP
$POP_KEY         = "POP"                                         # so campanhas com POP no nome
$SHEET_VENDAS_POP = "1ad4BD2MWBodq4AVTBDYIc-l2aM8g7CeOGURFgqPFeHA" # Hotmart low-ticket (extracao nova)
$GID_VENDAS_POP   = "0"
$TAX           = 1.1385   # imposto Meta Ads

# Filtro do LANCAMENTO (operacao atual): nome da campanha contem qualquer um destes (case/acento-insensitive)
# Mantem IHF-AGO26... e "TF | Topo..." (e as novas que seguirem esse padrao). Exclui as [VENDAS][IMERSAOHF11.07]* pre-operacao.
$LAUNCH_KEYS   = @("IHF", "TF | TOPO", "TF|TOPO")

$OutFile = Join-Path $PSScriptRoot "data.js"

# ---------------- HELPERS ----------------
function Get-CsvFromUrl($url) {
  $tmp = [IO.Path]::GetTempFileName()
  $lines = $null
  try {
    # gviz as vezes devolve 502/503 transitorio pro IP do runner -> retry com backoff
    $maxTry = 5; $lastErr = $null
    for ($try = 1; $try -le $maxTry; $try++) {
      try {
        $wc = New-Object System.Net.WebClient
        $wc.Encoding = [Text.Encoding]::UTF8
        $wc.DownloadFile($url, $tmp)   # WebClient segue redirect do gviz sozinho
        $lines = [IO.File]::ReadAllLines($tmp, [Text.Encoding]::UTF8)
        break
      } catch {
        $lastErr = $_
        if ($try -lt $maxTry) { Write-Host ("  fetch falhou (tentativa {0}/{1}): {2} -> retry" -f $try, $maxTry, $_.Exception.Message); Start-Sleep -Seconds (2 * $try) }
      }
    }
    if ($null -eq $lines) { throw $lastErr }
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
  return ,$rows   # vírgula evita unroll quando a planilha só tem cabeçalho (1 linha)
}
function Get-Csv($sheetId, $gid) {
  return Get-CsvFromUrl "https://docs.google.com/spreadsheets/d/$sheetId/gviz/tq?tqx=out:csv&gid=$gid"
}
function Get-CsvSheet($sheetId, $encSheet) {
  # $encSheet ja vem URL-encoded (ASCII) — evita problema de encoding no PS5.1
  return Get-CsvFromUrl "https://docs.google.com/spreadsheets/d/$sheetId/gviz/tq?tqx=out:csv&sheet=$encSheet"
}
# acha a coluna de "checkout iniciado" do pixel por NOME de cabecalho (robusto a posicao)
function Find-IcCol($rows) {
  if ($rows.Count -le 0) { return -1 }
  $hdr = $rows[0]
  for ($i = 0; $i -lt $hdr.Count; $i++) {
    $h = Norm $hdr[$i]
    if ((($h -match 'CHECKOUT') -and ($h -match 'INITIAT') -and ($h -notmatch 'COST|CUSTO|VALUE|VALOR|UNIQUE|MOBILE|PER ')) -or (($h -match 'FINALIZ') -and ($h -match 'COMPRA') -and ($h -notmatch 'CUSTO|VALOR|VALUE'))) { return $i }
  }
  return -1
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

# Espelha o clean() do sck_passthrough.js (LP): espaco->hifen, so [A-Za-z0-9._-],
# colapsa hifens, tira das pontas, corta em $max. Serve pra casar o SCK (campanha
# limpa+truncada em 40) de volta com o nome cru da campanha do Adveronix.
function CleanKey($s, $max) {
  if ($null -eq $s) { return "" }
  $v = ("$s")
  try { $v = [Uri]::UnescapeDataString($v) } catch {}
  $v = $v.Trim()
  $v = $v -replace '\s+', '-'
  $v = $v -replace '[^A-Za-z0-9._-]', ''
  $v = $v -replace '-+', '-'
  $v = $v -replace '^-+', ''
  $v = $v -replace '-+$', ''
  if ($max -gt 0 -and $v.Length -gt $max) { $v = $v.Substring(0, $max) }
  return $v
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

# mapa clean40 -> nome cru da campanha (pra casar o SCK das vendas de volta com a campanha).
# COLLISION-AWARE: se 2+ campanhas geram a MESMA clean40 (ex.: nomes iguais nos 40 primeiros
# chars, diferindo so na data no fim), a chave vira AMBIGUA e NAO atribui (evita venda no
# lugar errado). So atribui quando a chave aponta pra 1 campanha unica.
$campByKey = @{}
$campKeyAmbig = @{}
$seenCamp = @{}
foreach ($g in $grain) {
  if ($seenCamp.ContainsKey($g.camp)) { continue }
  $seenCamp[$g.camp] = $true
  $k = CleanKey $g.camp 40
  if (-not $k) { continue }
  if ($campByKey.ContainsKey($k)) { if ($campByKey[$k] -ne $g.camp) { $campKeyAmbig[$k] = $true } }
  else { $campByKey[$k] = $g.camp }
}
$ambigN = $campKeyAmbig.Keys.Count
if ($ambigN -gt 0) { Write-Host ("  ATENCAO: {0} chave(s) de campanha ambigua(s) no SCK (nomes iguais nos 40 primeiros chars) -> essas vendas ficam sem atribuicao" -f $ambigN) }

# ---------------- VENDAS (Hotmart) ----------------
Write-Host "Baixando Vendas (Hotmart)..."
$v = Get-Csv $SHEET_VENDAS $GID_VENDAS
# header: 0 Data/Hora,1 Evento,2 Transacao,3 Produto,4 Comprador,5 Email,6 Telefone,7 Valor,... 12 Origem(SCK)
$dv = @{}       # date -> { vendas, fat, checkouts }   (agregado da conta, como antes)
$sales = @{}    # date -> camp -> { vendas, fat, checkouts }   (atribuido por SCK; camp "" = sem atribuicao)
# acha a coluna do SCK/Origem por NOME de cabecalho (robusto a posicao)
$sckCol = -1
if ($v.Count -gt 0) { for ($i = 0; $i -lt $v[0].Count; $i++) { $h = Norm $v[0][$i]; if (($h -match 'SCK') -or ($h -match 'ORIGEM')) { $sckCol = $i; break } } }
if ($sckCol -ge 0) { Write-Host ("  coluna SCK/Origem: indice {0} ('{1}')" -f $sckCol, $v[0][$sckCol]) } else { Write-Host "  coluna SCK/Origem: NAO encontrada" }
$attrCount = 0
$skipHdr = $true
foreach ($r in $v) {
  if ($skipHdr) { $skipHdr = $false; continue }
  if ($r.Count -lt 8) { continue }
  $dt = ("$($r[0])").Trim()
  # "21/07/2026 13:44:00" -> 2026-07-21
  if ($dt -notmatch '^(\d{2})/(\d{2})/(\d{4})') { continue }
  $day = "{0}-{1}-{2}" -f $matches[3], $matches[2], $matches[1]
  $ev = ("$($r[1])").Trim().ToUpperInvariant()
  # atribuicao por SCK: parte antes do 1o '|' = campanha limpa (casa com campByKey)
  $attrCamp = ""
  if ($sckCol -ge 0 -and $r.Count -gt $sckCol) {
    $sckRaw = ("$($r[$sckCol])").Trim()
    if ($sckRaw) {
      try { $sckRaw = [Uri]::UnescapeDataString($sckRaw) } catch {}
      $part0 = ($sckRaw -split '\|')[0]
      $ck = CleanKey $part0 40
      if ($ck -and $campByKey.ContainsKey($ck) -and -not $campKeyAmbig.ContainsKey($ck)) { $attrCamp = $campByKey[$ck] }
    }
  }
  if (-not $dv.ContainsKey($day)) { $dv[$day] = @{ vendas=0; fat=0.0; checkouts=0 } }
  if (-not $sales.ContainsKey($day)) { $sales[$day] = @{} }
  if (-not $sales[$day].ContainsKey($attrCamp)) { $sales[$day][$attrCamp] = @{ vendas=0; fat=0.0; checkouts=0 } }
  if ($ev -eq "PURCHASE_APPROVED") {
    $val = (ToNum $r[7])
    $dv[$day].vendas += 1; $dv[$day].fat += $val
    $sales[$day][$attrCamp].vendas += 1; $sales[$day][$attrCamp].fat += $val
    if ($attrCamp -ne "") { $attrCount++ }
  } elseif ($ev -eq "PURCHASE_OUT_OF_SHOPPING_CART") {
    $dv[$day].checkouts += 1
    $sales[$day][$attrCamp].checkouts += 1
  }
}
$totVendas = 0; ($dv.Values | ForEach-Object { $totVendas += $_.vendas })
Write-Host ("  dias com evento: {0} | vendas aprovadas: {1} | vendas atribuidas por SCK: {2}" -f $dv.Keys.Count, $totVendas, $attrCount)

# achata $sales -> lista [{d,camp,vendas,fat,checkouts}]
$salesList = New-Object System.Collections.Generic.List[object]
foreach ($day in $sales.Keys) {
  foreach ($cmp in $sales[$day].Keys) {
    $s = $sales[$day][$cmp]
    $salesList.Add([ordered]@{ d=$day; camp=$cmp; vendas=$s.vendas; fat=[math]::Round($s.fat,2); checkouts=$s.checkouts })
  }
}

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

# ================ PERPETUO "Obra na Pratica" (POP) ================
# Midia = aba "Página2 POP" do Adveronix (Contains POP). Faturamento = planilha
# Hotmart low-ticket nova (1 linha = 1 compra aprovada). Evergreen: sem meta, sem
# split Topo/Venda; ROAS/CAC sobre TODO o gasto POP. Atribuicao por anuncio = pixel.
Write-Host "Baixando POP (Adveronix Pagina2 POP)..."
$qp = Get-CsvSheet $SHEET_QUERIES $POP_QUERIES_TAB_ENC
$popGrain = New-Object System.Collections.Generic.List[object]
$dqp = @{}
$icColP = Find-IcCol $qp
if ($icColP -ge 0) { Write-Host ("  POP checkout-pixel: indice {0}" -f $icColP) } else { Write-Host "  POP checkout-pixel: NAO encontrada (fallback vendas)" }
$skipHdr = $true
foreach ($r in $qp) {
  if ($skipHdr) { $skipHdr = $false; continue }
  if ($r.Count -lt 11) { continue }
  $day = ("$($r[0])").Trim()
  if ($day -notmatch '^\d{4}-\d{2}-\d{2}$') { continue }
  $camp = ("$($r[1])").Trim()
  if (-not (Norm $camp).Contains((Norm $POP_KEY))) { continue }   # so campanhas POP
  $spend = (ToNum $r[4]) * $TAX
  $impr  = [int](ToNum $r[5]); $reach = [int](ToNum $r[6]); $clk = [int](ToNum $r[7])
  $lpv   = [int](ToNum $r[8]); $pur = [int](ToNum $r[9]); $val = (ToNum $r[10])
  $icpx  = if ($icColP -ge 0 -and $r.Count -gt $icColP) { [int](ToNum $r[$icColP]) } else { 0 }
  $popGrain.Add([ordered]@{ d=$day; camp=$camp; adset=("$($r[2])").Trim(); ad=("$($r[3])").Trim();
    spend=[math]::Round($spend,2); impr=$impr; reach=$reach; clk=$clk; lpv=$lpv; pur=$pur; val=[math]::Round($val,2); icpx=$icpx })
  if (-not $dqp.ContainsKey($day)) { $dqp[$day] = @{ spend=0.0; impr=0; clk=0; lpv=0; pur=0; val=0.0; icpx=0 } }
  $dqp[$day].spend += $spend; $dqp[$day].impr += $impr; $dqp[$day].clk += $clk
  $dqp[$day].lpv += $lpv; $dqp[$day].pur += $pur; $dqp[$day].val += $val; $dqp[$day].icpx += $icpx
}
Write-Host ("  POP linhas: {0} | dias midia: {1}" -f $popGrain.Count, $dqp.Keys.Count)

Write-Host "Baixando Vendas POP (Hotmart low-ticket)..."
$vp = Get-Csv $SHEET_VENDAS_POP $GID_VENDAS_POP
# header: 0 data_venda,1 nome,2 email,3 telefone,4 utm_source,5 utm_campaign,6 utm_medium,7 utm_content,8 utm_term,9 faturamento,10 produto,...
$dvp = @{}
$fatColP = -1
if ($vp.Count -gt 0) { for ($i = 0; $i -lt $vp[0].Count; $i++) { $h = Norm $vp[0][$i]; if ($h -match 'FATURAMENTO|VALOR') { $fatColP = $i; break } } }
if ($fatColP -lt 0) { $fatColP = 9 }
$skipHdr = $true
foreach ($r in $vp) {
  if ($skipHdr) { $skipHdr = $false; continue }
  if ($r.Count -lt 2) { continue }
  $dt = ("$($r[0])").Trim()
  if ($dt -notmatch '^(\d{2})/(\d{2})/(\d{4})') { continue }   # dd/MM/yyyy [HH:mm:ss]
  $day = "{0}-{1}-{2}" -f $matches[3], $matches[2], $matches[1]
  $val = if ($r.Count -gt $fatColP) { ToNum $r[$fatColP] } else { 0.0 }
  if (-not $dvp.ContainsKey($day)) { $dvp[$day] = @{ vendas=0; fat=0.0 } }
  $dvp[$day].vendas += 1; $dvp[$day].fat += $val   # cada linha = 1 compra aprovada
}
$popTotVendas = 0; ($dvp.Values | ForEach-Object { $popTotVendas += $_.vendas })
Write-Host ("  POP vendas: {0}" -f $popTotVendas)

# merge POP daily (uniao dos dias de midia + vendas)
$allDaysP = New-Object System.Collections.Generic.SortedSet[string]
foreach ($k in $dqp.Keys) { [void]$allDaysP.Add($k) }
foreach ($k in $dvp.Keys) { [void]$allDaysP.Add($k) }
$popDaily = New-Object System.Collections.Generic.List[object]
foreach ($day in $allDaysP) {
  $a = $dqp[$day]; $s = $dvp[$day]
  $spend = if ($a) { $a.spend } else { 0.0 }
  $impr  = if ($a) { $a.impr }  else { 0 }
  $clk   = if ($a) { $a.clk }   else { 0 }
  $lpv   = if ($a) { $a.lpv }   else { 0 }
  $pur   = if ($a) { $a.pur }   else { 0 }
  $pval  = if ($a) { $a.val }   else { 0.0 }
  $icpx  = if ($a) { $a.icpx }  else { 0 }
  $vend  = if ($s) { $s.vendas } else { 0 }
  $fat   = if ($s) { $s.fat }    else { 0.0 }
  $popDaily.Add([ordered]@{ d=$day; spend=[math]::Round($spend,2); impr=$impr; clk=$clk; lpv=$lpv;
    purPixel=$pur; valPixel=[math]::Round($pval,2); icPixel=$icpx; vendas=$vend; fat=[math]::Round($fat,2) })
}

# ---------------- OUTPUT data.js ----------------
$now = [DateTime]::UtcNow.AddHours(-3)   # BRT
$meta = [ordered]@{ generatedAt = $now.ToString("yyyy-MM-dd HH:mm"); tz="BRT"; tax=$TAX; launchKeys=$LAUNCH_KEYS; product="Imersao Transformando seu Conhecimento em Investimento" }

$js = "window.DASH=" + ($meta | ConvertTo-Json -Compress -Depth 4) + ";" + [Environment]::NewLine
$js += "window.DASH.daily=" + (JsonStr $daily) + ";" + [Environment]::NewLine
$js += "window.DASH.grain=" + (JsonStr $grain) + ";" + [Environment]::NewLine
$js += "window.DASH.sales=" + (JsonStr $salesList) + ";" + [Environment]::NewLine

# perpetuo (POP) - dataset separado consumido pela aba "Obra na Pratica".
# Nome do produto (com acento/R$) fica no app.js pra evitar encoding no PS5.1.
$popMeta = [ordered]@{ key=$POP_KEY; offer='17gdpna9' }
$js += "window.DASH.pop=" + ($popMeta | ConvertTo-Json -Compress -Depth 4) + ";" + [Environment]::NewLine
$js += "window.DASH.pop.daily=" + (JsonStr $popDaily) + ";" + [Environment]::NewLine
$js += "window.DASH.pop.grain=" + (JsonStr $popGrain) + ";" + [Environment]::NewLine

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($OutFile, $js, $utf8NoBom)
Write-Host ("OK -> {0} ({1:n0} bytes) | Imersao dias={2} grain={3} | POP dias={4} grain={5}" -f $OutFile, (Get-Item $OutFile).Length, $daily.Count, $grain.Count, $popDaily.Count, $popGrain.Count)
