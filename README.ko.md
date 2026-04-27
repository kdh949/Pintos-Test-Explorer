# Pintos Test Explorer

언어: [English](README.md) | 한국어

VS Code에서 Pintos 테스트를 실행, 디버그, 초기화, 확인할 수 있고, 터미널에서는 같은 흐름을 `pt`로 사용할 수 있습니다.

## 설치

### VS Code 확장

1. VS Code에서 `Extensions`를 엽니다.
2. `Pintos Test Explorer`를 검색합니다.
3. `Install`을 누릅니다.
4. Dev Container를 사용 중이면 컨테이너 안에도 설치합니다.
5. 설치 후 한 번 `Developer: Reload Window`를 실행합니다.

### CLI

평소처럼 자연스럽게 쓰고 싶다면:

```bash
source scripts/install-pintos-cli.sh
pt --help
```

이 방법을 권장합니다. 한 번만 설정하면 이후에는 `pt`와 `pintos-tests`를 일반 명령처럼 사용할 수 있습니다.

현재 셸에서만 잠깐 쓰고 싶다면:

```bash
source scripts/pintos-shell.sh
pt --help
```

## 빠른 시작

### VS Code에서

1. Pintos 워크스페이스를 Dev Container나 Linux 환경에서 엽니다.
2. Activity Bar에서 `P os` 아이콘을 누릅니다.
3. `Threads`, `User Programs`, `Virtual Memory`, `File System` 중 하나를 펼칩니다.
4. 테스트 옆 초록색 `Run` 액션으로 바로 실행합니다.
5. 주황색 `Debug` 액션으로 단일 테스트 디버깅을 시작합니다.
6. 여러 테스트를 체크한 뒤 툴바의 `Run Checked Tests`를 사용합니다.
7. 정렬 버튼으로 `Number order`와 `Latest first`를 전환합니다.
8. 맨 왼쪽 빨간 `Reset All Tests`로 전체를 초기화하거나, `Reset Checked Tests`로 선택한 테스트만 초기화합니다.

테스트에 아티팩트가 있으면 트리에서 `output`, `result`, `errors` 링크가 함께 보입니다.

### 터미널에서

Pintos 워크스페이스 안에서는:

```bash
pt projects
pt list threads
pt reset threads alarm-zero
pt reset-all
pt run threads alarm-zero
pt run threads 11-20
pt debug vm 4 --server-only
```

워크스페이스 밖에서는 `PINTOS_ROOT`를 직접 지정하면 됩니다.

```bash
PINTOS_ROOT=/path/to/pintos pt list threads
PINTOS_ROOT=/path/to/pintos pt run filesys all
```

`pt`는 짧은 일상용 이름이고, `pintos-tests`는 같은 기능을 하는 정식 명령입니다.

## 지원 기능

- VS Code 사이드바에서 `threads`, `userprog`, `vm`, `filesys` 테스트 탐색
- UI나 터미널에서 단일 테스트 실행
- GDB 기반 단일 테스트 디버깅
- 체크박스나 CLI selector로 여러 테스트 한 번에 실행
- `output`, `result`, `errors` 아티팩트 열기
- `Number order`와 `Latest first` 정렬 전환
- 툴바에서 선택 초기화와 전체 초기화 분리
- 빌드 에러로 실행이 실패해도 트리에서 `Not run`이 아니라 `FAIL`로 표시
- CLI에서 선택 초기화와 워크스페이스 전체 초기화 지원
- `--recent-first`로 최근 사용 테스트 우선 정렬

## CLI 예시

자주 쓰는 명령:

```bash
pt list threads --recent-first
pt reset threads 4 7-9 alarm-zero
pt reset threads all
pt reset-all
pt run threads 1 3-5 alarm-zero alarm-*
pt run filesys all
pt debug threads 12
pt artifacts threads alarm-zero
```

selector 규칙:

- `11-20`은 양끝 포함 숫자 범위입니다.
- `alarm-zero`는 정확한 짧은 이름으로 선택합니다.
- `tests/threads/alarm-zero` 형태도 사용할 수 있습니다.
- `alarm-*`는 와일드카드 패턴입니다.
- `all`은 `run`과 프로젝트 단위 `reset`에서 전체 테스트를 뜻합니다.
- `debug`는 정확히 하나의 테스트로만 해석되어야 합니다.

## 요구 사항

- VS Code `1.85.0` 이상
- 아래 둘 중 하나 형태의 Pintos 워크스페이스
  - `<workspace>/threads`, `<workspace>/userprog`, `<workspace>/vm`, `<workspace>/tests`
  - `<workspace>/pintos/threads`, `<workspace>/pintos/userprog`, `<workspace>/pintos/vm`, `<workspace>/pintos/tests`
- `make`가 가능한 Linux 또는 Dev Container 환경
- 디버깅용 `gdb`
- `ms-vscode.cpptools`

## 문제 해결

- `pt list ...`에서 Pintos 루트를 찾지 못한다면 실제 Pintos 워크스페이스를 열거나 `PINTOS_ROOT=/path/to/pintos`를 지정하세요.
- VS Code 디버깅이 실패하면 먼저 `Pintos Tests` 출력 채널의 마지막 로그를 확인하세요.
- 실행이 컴파일/빌드 에러로 중단되면, 확장은 해당 테스트를 `FAIL`로 표시하고 캡처한 에러를 아티팩트에 남깁니다.
- 디버깅이 시작되지 않으면 활성 환경에서 `gdb`가 설치되어 있는지 확인하세요.

## 추가 문서

- [extension/README.md](extension/README.md)
- [extension/README.ko.md](extension/README.ko.md)
- [extension/SUPPORT.md](extension/SUPPORT.md)
- [extension/CHANGELOG.md](extension/CHANGELOG.md)
