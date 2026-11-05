# CAD Light Cleaner 0.1

Windows 11용 DXF 경량화 데스크톱 프로그램의 첫 개발 버전입니다. Illustrator와 독립된 계산 프로세스로 실행됩니다. **전체 인수인계 요구사항이 완성된 버전은 아닙니다.**

## 다운로드

- [소스 ZIP 다운로드](https://github.com/selpix2026/Selpix/raw/refs/heads/main/downloads/CADLightCleaner-source.zip)
- [GitHub에서 ZIP 파일 보기](https://github.com/selpix2026/Selpix/blob/main/downloads/CADLightCleaner-source.zip)

비공개 저장소라면 접근 권한이 있는 GitHub 계정으로 로그인해야 합니다. ZIP에는 소스 코드·테스트·사용법·Windows 빌드 스크립트가 들어 있으며, Windows EXE는 포함되지 않습니다. 다운로드 후 압축을 풀고 아래 실행 절차를 따르세요. Windows 빌드가 성공하면 저장소 Actions의 해당 실행 페이지에서도 `CADLightCleaner-Windows` 아티팩트를 받을 수 있습니다.

## 실행

Windows에 Python 3.12 (python.org, 설치 시 Python Launcher 포함)를 설치한 뒤 PowerShell에서:

```powershell
cd Selpix
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
.\.venv\Scripts\python.exe launcher.py
```

Windows 실행 파일 만들기:

```powershell
.\build-windows.ps1
```

테스트 → PyInstaller 빌드 → **만든 exe로 DXF 실제 처리 및 결과 검증** → `dist/CADLightCleaner-Windows.zip` 생성 순서입니다. 압축을 풀고 **폴더 전체를 유지한 채** `CADLightCleaner.exe`를 실행합니다. 단일 exe만 복사하면 작동하지 않습니다. Python을 별도로 설치하지 않은 PC에도 이 폴더를 배포할 수 있습니다. 코드 서명은 하지 않습니다.

GitHub Actions의 `Windows build and functional tests` 워크플로에도 같은 절차가 있습니다. 소스의 워크플로를 제공한 것이며, 클라우드에서 Windows 빌드를 실행했다고 의미하지 않습니다.

Linux/macOS 소스 실행은 `python3 -m venv .venv`, `.venv/bin/python -m pip install -r requirements-lock.txt`, `.venv/bin/python launcher.py`입니다. 그래픽 세션이 필요합니다. 화면 없는 서버에서는 아래 배치 실행이나 `QT_QPA_PLATFORM=offscreen` 테스트를 사용하세요.

## 사용 순서

1. **DXF 열기**에서 파일을 선택합니다. `examples/demo.dxf`는 중복선·교차·평행선·곡선·숨김 레이어·블록이 포함된 생성 샘플입니다. 실제 고객 도면은 아닙니다.
2. 기본 **현재 표시 상태만** 또는 **전체 도면**을 선택합니다. 0 길이 LINE 제거는 선택 사항입니다.
3. **분석 / 결과 준비**를 누릅니다. 원본 바이트를 작업 폴더에 백업하고 SHA-256을 저장한 뒤 별도 계산 프로세스를 시작합니다. 원본은 수정하지 않습니다.
4. 일시정지는 계산 프로세스 자체를 정지하므로 DXF 읽기/내보내기 중에도 작동합니다. 재개하면 같은 위치에서 계속됩니다. 안전 중단은 완료 트랜잭션을 보존하고, 최대 2초 후에도 계산이 반환하지 않으면 계산 프로세스만 종료합니다. 진행 중인 미완료 배치는 SQLite가 롤백합니다.
5. 중단 후 **체크포인트에서 계속**을 누릅니다. 프로그램을 다시 열었다면 **이전 작업 열기**로 `job.json`이 있는 폴더를 선택합니다. 원본 파일이 이후 바뀌어도 백업을 기준으로 재개합니다. 읽기/출력 도중 중단했으면 해당 단계는 다시 실행합니다.
6. 전/후 SVG, 변경 객체의 원본 handle, 보고서의 제외 수와 한계를 확인합니다. **중복선은 원래 선과 겹쳐 있으므로 화면만으로 삭제 수를 판별할 수 없습니다.** 변경 목록과 수치를 함께 확인하세요.
7. **결과 승인 · 새 폴더에 저장**에서 상위 폴더를 선택하면 고유한 새 하위 폴더를 만듭니다. 기존 파일/폴더를 덮어쓰지 않습니다. DXF, 전후 SVG, JSON 보고서를 저장합니다.

전후 미리보기는 각 도형 범위에 맞춰 표시되는 XY 투영이며 축척/뷰포트 비교 도구가 아닙니다. 텍스트·블록·면 등 미지원 형상은 그리지 않으며, 최대 20,000개 객체/약 200,000개 점까지 표시합니다. `preview_before/after`의 `omitted`, `truncated`를 확인하세요. 곡선은 **화면 표시만** 샘플링하며 DXF 출력의 곡선을 근사하지 않습니다. Illustrator에서 SVG를 열 수 있지만, 모든 CAD 객체를 표현하는 벡터 출력은 아닙니다.

## 지원 범위와 안전 정책

| 항목 | 0.1 동작 |
|---|---|
| 직접 입력 | DXF, ezdxf 직접 읽기 |
| 중복 삭제 | 끝점 순서가 뒤집힌 경우를 포함한 **정확한 LINE 중복**. 동일 레이어 및 DXF 속성만. 좌표 반올림/허용 오차 없음 |
| 보호 | 다른 레이어·다른 스타일·Z 좌표 차이·근접 평행선·교차/분기선은 병합하지 않음. 메타데이터가 있는 LINE은 정리 대상에서 보호 |
| 0 길이 제거 | 선택 시 시작점=끝점인 일반 LINE만 |
| 표시 상태 기본 | **모델 공간** 레이어 OFF/Freeze 및 entity invisible 처리. INSERT 전체(일반/동적 블록·XREF), HATCH 등 미지원 객체와 확장 메타데이터 객체는 제외/보고 |
| 종이 공간이 활성인 도면 | 기본 모드에서 오류로 중단. 뷰포트 표시를 추측하지 않음. 전체 모드로만 처리하거나 CAD에서 모델 공간 DXF를 준비 |
| 전체 모드 | 숨김 포함. 원본 문서의 블록 정의·레이아웃·지원하지 않는 객체를 유지하며 모델 공간의 안전한 LINE만 정리 |
| 곡선/폴리라인 | 지원되는 형상을 그대로 유지. 곡선 중복 삭제/단순화 없음 |
| 출력 | 읽기 재검증 및 DXF audit 통과한 DXF, 제한된 SVG 미리보기, JSON 보고서 |
| 체크포인트 | 객체별 keep/duplicate/zero/exclude 결정과 중복 인덱스를 같은 SQLite 트랜잭션에 저장 |
| 계산 크기 | 단일 계산 프로세스. 처리시간에 따라 16~1024 객체 배치 적응. 4 GiB RSS 초과를 감지하면 중단 |

**기본 모드는 CAD에서 보이는 화면을 완벽하게 재현하지 않습니다.** 뷰포트별 freeze, 클리핑, 동적 블록 상태, XREF 표시 상태는 미검증입니다. 불확실한 객체를 임의로 포함하는 대신 제외 내역을 보고합니다. 이 때문에 보이는 일반 블록도 빠질 수 있습니다. 기본 모드의 새 문서는 선택된 모델 공간 객체와 필요한 테이블만 가져오므로 전역 도면 설정과 종이 공간은 보존되지 않습니다. 완전한 CAD 도면 보존이 필요하면 전체 모드를 검토하세요.

DXF 읽기와 쓰기는 ezdxf 전체 문서를 메모리에 올립니다. 디스크 인덱스로 중복 비교의 이차 탐색을 피하지만 무제한 크기를 지원하지는 않습니다. 메모리 한도 중단 작업은 더 큰 메모리 환경이 필요할 수 있습니다. 자동 다중 CPU 분배는 아직 구현하지 않았습니다.

보고서의 객체/앵커 수는 모델 공간 범위입니다. 앵커 수는 LINE 끝점, 폴리라인 정점, SPLINE 제어점, POINT만 계산하며 원/호/문자/블록 내부 점은 합산하지 않습니다. `processing_seconds`는 마지막 처리 실행 시간이며 중단 전 누적 시간은 아닙니다. 전체 모드는 포맷/메타데이터 때문에 원본보다 파일이 커질 수도 있습니다.

## 백업과 복구

상태 표시줄의 작업 폴더에는 다음이 남습니다. 기본 경로는 Qt의 사용자별 AppLocalDataLocation 아래 `CADLightCleaner/jobs`입니다(표시줄의 실제 경로 기준).

- `original.dxf`: 원본 그대로의 독립 백업
- `job.json`: 원본 위치·백업 해시·모드
- `checkpoint.sqlite` 및 `-wal`/`-shm`: 재개에 필요한 상태. 실행 중에는 파일을 따로 옮기지 마세요.
- `staging`: 검증 결과. 정리 도중에는 불완전할 수 있으며 UI에서 ready가 된 경우에만 승인 가능
- `worker-error.log`: 계산 프로세스 시작/실행 실패 진단

복구는 `original.dxf`를 **새 이름으로 복사해 열면** 됩니다. 원본도 자동 수정되지 않으므로 그대로 남아 있습니다. Illustrator의 실행 취소에 의존하지 않습니다. 중단 시 완료된 **분석 결정**은 보존되지만 부분 DXF 내보내기는 아직 제공하지 않습니다. 전체 분석과 검증 완료 후 결과 저장이 가능합니다. 백업을 직접 수정하면 해시 검사로 재개가 거부됩니다.

## 배치 처리

`--output` 지정은 결과 저장을 명시적으로 승인하는 비대화형 옵션입니다. 결과 폴더는 없어야 합니다.

```powershell
.\.venv\Scripts\python.exe launcher.py --batch examples/demo.dxf --output C:\CAD\cleaned-new --jobs-root C:\CAD\jobs
```

`--all`은 숨김 포함, `--keep-zero`는 0 길이 유지입니다. 배치에서는 Ctrl+C로 중단할 수 있습니다. 데스크톱 UI에서 같은 체크포인트를 열어 재개할 수 있습니다. 소스 실행의 콘솔에는 작업 경로/보고서 JSON이 나옵니다. windowed exe 배치 실행은 콘솔 출력을 제공하지 않으므로 출력 파일과 종료 코드를 확인하세요.

## 검증

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

생성 DXF 기반 테스트: 정밀도·레이어·스타일·Z·XDATA 보호, 숨김·블록 제외, 종이 공간 처리, 곡선/교차/평행선 보존, 원본 불변, 손상된 백업/출력 거부, 24,000개 선을 실제 별도 프로세스에서 일시정지/중단/재개, 미완료 트랜잭션 강제 종료 복구, Qt 화면 조작, 배치 실행.

Linux 클라우드의 소스 테스트와 Linux 패키지는 검증 대상입니다. **Windows 11, Illustrator 2026, 실제 DWG/DXF 고객 샘플 검증은 아직 수행하지 않았습니다.** Windows CI를 실행한 후 패키지 결과와 실제 PC 동작을 확인해야 합니다.

## 다음 개발 단계

1. 표시 상태 해석 확대: 정적 블록의 상속 레이어·행렬·재귀 보호, XREF/클리핑/동적 상태는 검증 가능한 범위만 허용.
2. mm 단위 0.001 정밀도 연결 옵션, 0=완전 일치, 분기·중간점·평행선 보호, PLINE 생성 및 직선 앵커 축소.
3. 곡선 근사 오차 검증과 변경 영역 비교, 부분 완료 출력 및 누적 성능 기록, 메모리/CPU 기반 병렬 조절.
4. 검증된 DWG 변환기 연동(라이선스/지원 버전/변환 손실 보고), Illustrator JSX 소량 데이터 왕복 및 외부 결과 검증.

첨부 JSX v1.0/v1.2는 구조상의 문제를 파악하는 참고 자료로만 읽었고 엔진에 복사하거나 실행하지 않았습니다.
