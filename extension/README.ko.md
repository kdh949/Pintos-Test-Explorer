# Pintos Test Explorer

언어: [English](README.md) | 한국어

전용 VS Code 사이드바에서 Pintos 테스트를 실행, 디버그, 초기화, 확인할 수 있게 해주는 확장입니다.

`Pintos Test Explorer`는 `pintos_22.04_lab_docker` 같은 일반적인 Pintos 실습 환경을 기준으로 만든 워크스페이스 중심 확장입니다. 기본 Pintos 테스트 목록을 트리로 보여주고, 이름을 외우지 않아도 한 개 또는 여러 개 테스트를 바로 실행할 수 있으며, GDB 기반 디버깅도 UI에서 시작할 수 있습니다.

## 설치

1. VS Code에서 `Extensions`를 엽니다.
2. `Pintos Test Explorer`를 검색합니다.
3. `Install`을 누릅니다.
4. Dev Container를 사용 중이면 컨테이너 안에도 설치합니다.
5. 설치 후 한 번 `Developer: Reload Window`를 실행합니다.

설치가 끝나면 Activity Bar에서 `P os` 아이콘을 확인할 수 있습니다.

## 빠른 시작

1. Pintos 워크스페이스를 Dev Container나 Linux 환경에서 엽니다.
2. `P os` Activity Bar 아이콘을 누릅니다.
3. `Threads`, `User Programs`, `Virtual Memory`, `File System` 중 하나를 펼칩니다.
4. 테스트 옆 초록색 `Run` 버튼으로 실행합니다.
5. 주황색 `Debug` 버튼으로 단일 테스트 디버깅을 시작합니다.
6. 여러 테스트를 체크한 뒤 툴바의 `Run Checked Tests`로 한 번에 실행합니다.
7. 정렬 버튼으로 `Number order`와 `Latest first`를 전환합니다.
8. 맨 왼쪽 빨간 `Reset All Tests`로 전체를 초기화하거나, `Reset Checked Tests`로 선택한 테스트만 초기화합니다.

아티팩트가 있는 테스트는 트리에서 `output`, `result`, `errors` 빠른 링크를 함께 표시합니다.

## 요구 사항

- VS Code `1.85.0` 이상
- 아래 둘 중 하나 형태의 Pintos 워크스페이스
  - `<workspace>/threads`, `<workspace>/userprog`, `<workspace>/vm`, `<workspace>/tests`
  - `<workspace>/pintos/threads`, `<workspace>/pintos/userprog`, `<workspace>/pintos/vm`, `<workspace>/pintos/tests`
- `make`가 가능한 Linux 또는 Dev Container 환경
- 디버깅용 `gdb`
- `ms-vscode.cpptools`

이 확장은 전형적인 Pintos 실습 흐름을 대상으로 하며, 일치하는 Dev Container 또는 Linux 환경에서 가장 안정적으로 동작합니다.

## 주요 기능

- 전용 트리 뷰에서 `threads`, `userprog`, `vm`, `filesys` 테스트 탐색
- 각 테스트 행에서 바로 단일 실행
- GDB 원격 attach 기반 단일 디버깅
- 체크박스로 여러 테스트를 묶어 한 번에 실행
- `Number order`와 `Latest first` 정렬 전환
- 툴바에서 선택 초기화와 전체 초기화 분리
- 빌드 에러로 실행이 중단돼도 트리에서 `FAIL`로 바로 표시
- `output`, `result`, `errors` 파일을 트리에서 바로 열기
- `Make.tests`를 기준으로 테스트 목록 동적 생성

## 디버깅 참고

디버깅은 확장에 포함된 helper 스크립트와 VS Code C/C++ 디버거를 함께 사용합니다. 확장은 현재 Pintos 워크스페이스 루트를 helper에게 전달하므로, Marketplace로 설치한 경우에도 워크스페이스 안에 같은 `scripts/` 디렉터리가 있을 필요는 없습니다.

기본 흐름은 다음과 같습니다.

1. 선택한 테스트에 대해 Pintos GDB 서버를 시작합니다.
2. 디버그 서버가 준비될 때까지 기다립니다.
3. `cppdbg`를 통해 `gdb`를 attach합니다.
4. 이후에는 일반 VS Code 디버그 UI에서 continue, step, breakpoint, variable inspection을 사용합니다.

디버그 시작이 실패하면 먼저 `Pintos Tests` 출력 채널을 확인하세요. 최근 helper 로그가 함께 남기 때문에, `gdb` 누락인지, 빌드 실패인지, 테스트 명령 해석 문제인지 빠르게 구분할 수 있습니다.

테스트가 Pintos 자체 아티팩트를 만들기 전에 실패하더라도, 확장은 synthetic `FAIL` 결과와 `errors` 내용을 남겨서 트리 상태가 바로 실패로 보이게 합니다.

## Companion CLI

이 저장소에는 같은 흐름을 터미널에서 쓸 수 있는 companion CLI도 포함되어 있습니다. 정식 명령 이름은 `pintos-tests`이고, 일상용 짧은 별칭으로 `pt`를 제공합니다. 다만 VS Code 확장을 설치했다고 해서 자동으로 셸 명령이 추가되지는 않습니다.

권장 설정:

```bash
source scripts/install-pintos-cli.sh
pt --help
```

자주 쓰는 selector 예시:

```bash
# 하나 또는 여러 테스트 초기화
pt reset threads alarm-zero
pt reset threads all

# 11번부터 20번까지 실행
pt run threads 11-20

# 범위, 정확한 이름, 패턴을 섞어서 실행
pt run threads 1 3-5 alarm-zero alarm-*

# 워크스페이스 전체 초기화
pt reset-all

# filesys 전체 실행
pt run filesys all

# 단일 테스트 디버깅
pt debug threads 12

# 최근 사용 우선 정렬
pt list threads --recent-first
```

selector 규칙:

- `11-20`은 양끝 포함 숫자 범위입니다.
- `alarm-zero`는 정확한 짧은 이름으로 선택합니다.
- `tests/threads/alarm-zero` 형태도 사용할 수 있습니다.
- `alarm-*`는 와일드카드 패턴입니다.
- `all`은 `run`과 프로젝트 단위 `reset`에서 전체 테스트를 뜻합니다.
- `debug`는 정확히 하나의 테스트로만 해석되어야 합니다.

`--recent-first`는 로컬 run/debug 기록을 사용해 최근에 사용한 테스트를 위로 올립니다. 기록은 Pintos 워크스페이스의 `.vscode/pintos-test-history.json`에 저장됩니다.

어느 터미널에서나 `pintos-tests`와 `pt`를 쓰고 싶다면:

```bash
source scripts/install-pintos-cli.sh
```

이 스크립트는 `~/.local/bin/pintos-tests`와 `~/.local/bin/pt` 래퍼를 설치하고, 이후 셸에서도 계속 동작하도록 `~/.local/bin`을 셸 프로필에 추가합니다.

설치 후 예시:

```bash
pt --help
pt list threads
pintos-tests debug vm 4 --server-only
```

랩퍼 설치 없이 현재 셸에서만 잠깐 쓰고 싶다면:

```bash
source scripts/pintos-shell.sh
```

이 방법은 현재 셸 세션에서만 `pintos-tests`와 `pt`를 활성화합니다.

## 라이선스

MIT. 자세한 내용은 [LICENSE.txt](LICENSE.txt)를 참고하세요.
