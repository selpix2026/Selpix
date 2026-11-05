$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
py -3.12 -m venv .venv
if ($LASTEXITCODE -ne 0) { throw 'Python 3.12가 필요합니다.' }
$Python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
& $Python -m pip install -r requirements-lock.txt
if ($LASTEXITCODE -ne 0) { throw '의존성 설치 실패' }
$env:QT_QPA_PLATFORM = 'offscreen'
& $Python -m pytest -q
if ($LASTEXITCODE -ne 0) { throw '자동 테스트 실패' }
Remove-Item Env:QT_QPA_PLATFORM
& $Python -m PyInstaller --noconfirm --clean --windowed --onedir --name CADLightCleaner --collect-all ezdxf --collect-all numpy launcher.py
if ($LASTEXITCODE -ne 0) { throw 'Windows 빌드 실패' }
# Smoke-test the packaged spawned worker; do not infer success from a PID.
$SmokeRoot = Join-Path ([IO.Path]::GetTempPath()) ('cadcleaner-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $SmokeRoot | Out-Null
& $Python -c "import ezdxf; from pathlib import Path; d=ezdxf.new(); m=d.modelspace(); m.add_line((0,0),(1,0)); m.add_line((1,0),(0,0)); d.saveas(Path(r'$SmokeRoot')/'input.dxf')"
if ($LASTEXITCODE -ne 0) { throw '스모크 입력 생성 실패' }
$Exe = Join-Path $PSScriptRoot 'dist\CADLightCleaner\CADLightCleaner.exe'
$Process = Start-Process -FilePath $Exe -ArgumentList @('--batch', "`"$SmokeRoot\input.dxf`"", '--output', "`"$SmokeRoot\result`"", '--jobs-root', "`"$SmokeRoot\jobs`"") -Wait -PassThru
if ($Process.ExitCode -ne 0) { throw '패키지 실행 실패' }
& $Python -c "import ezdxf; from pathlib import Path; p=Path(r'$SmokeRoot')/'result'/'cleaned.dxf'; d=ezdxf.readfile(p); assert len(d.modelspace())==1; assert not d.audit().has_errors"
if ($LASTEXITCODE -ne 0) { throw '패키지 처리 결과 검증 실패' }
Copy-Item README.md dist\CADLightCleaner\README.md
Compress-Archive -Path dist\CADLightCleaner -DestinationPath dist\CADLightCleaner-Windows.zip -Force
Write-Host '완료: dist\CADLightCleaner-Windows.zip — 폴더 전체를 압축 해제 후 exe 실행'
