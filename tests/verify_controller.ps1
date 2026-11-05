param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
$Tokens=$null; $ParseErrors=$null
$Ast=[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Path),[ref]$Tokens,[ref]$ParseErrors)
if($ParseErrors.Count -ne 0){throw ($ParseErrors | Out-String)}
$Functions=$Ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Set-Cmd','Finish-Control')},$true)
foreach($Definition in $Functions){. ([scriptblock]::Create($Definition.Extent.Text))}
$TickAst=$Ast.FindAll({param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Value -eq 'Add_Tick'},$true)[0]
$Tick=$TickAst.Arguments[0].ScriptBlock.GetScriptBlock()
$ClosingAst=$Ast.FindAll({param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Value -eq 'Add_FormClosing'},$true)[0]
$Closing=$ClosingAst.Arguments[0].ScriptBlock.GetScriptBlock()
$Root=Join-Path ([IO.Path]::GetTempPath()) ('cad-jsx-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $Root | Out-Null
try {
  $donePath=Join-Path $Root 'done';$statusPath=Join-Path $Root 'status';$cmdPath=Join-Path $Root 'command';$heartbeatPath=Join-Path $Root 'heartbeat'
  $pause=[pscustomobject]@{Enabled=$true};$stop=[pscustomobject]@{Enabled=$true};$lbl=[pscustomobject]@{Text=''}
  $form=[pscustomobject]@{Text='';Closed=0};$form|Add-Member ScriptMethod Close {$this.Closed++}
  $timer=[pscustomobject]@{};$timer|Add-Member ScriptMethod Stop {}
  $script:finished=$false;$script:finishTicks=0;$script:ticks=0;$script:heartbeat=0
  [IO.File]::WriteAllText($donePath,'DONE');[IO.File]::WriteAllText($statusPath,'locked')
  $Lock=[IO.File]::Open($statusPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {for($i=0;$i -lt 4;$i++){& $Tick}} finally {$Lock.Dispose()}
  if(-not $script:finished -or $form.Closed -ne 1){throw 'done.flag must close even while status is locked'}
  Remove-Item $donePath
  $script:finished=$false;$script:finishTicks=0;$form.Closed=0
  [IO.File]::WriteAllText($statusPath,'FINAL|done|1|complete')
  for($i=0;$i -lt 5;$i++){& $Tick}
  if(-not $script:finished -or $form.Closed -ne 1){throw 'terminal status fallback did not close'}
  $script:finished=$false;& $Closing
  if([IO.File]::ReadAllText($cmdPath) -ne 'STOP'){throw 'Closing must request STOP'}
  Write-Host 'Generated PowerShell parsed; locked-status completion, final-status fallback and close/STOP passed.'
} finally {Remove-Item -Recurse -Force $Root}
