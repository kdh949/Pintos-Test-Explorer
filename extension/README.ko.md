# Pintos Test Explorer

언어: [English](README.md) | 한국어

Pintos Test Explorer는 Pintos 테스트 전용 VS Code 사이드바를 추가하고, 같은 기능을 `pt`와 `pintos-tests` CLI로도 함께 제공합니다. 사이드바와 CLI가 같은 bundled helper를 공유하므로 테스트 인식, 실행/디버그, artifact 처리, 루트 인식 규칙이 서로 어긋나지 않습니다.

## 시연 영상

[![시연 영상 보기](https://img.youtube.com/vi/FyJ1jKg3zNk/hqdefault.jpg)](https://youtu.be/FyJ1jKg3zNk)

바로 보기: [YouTube 시연 영상](https://youtu.be/FyJ1jKg3zNk)

## 핵심 요약

```text
1. build Makefile이 있으면 현재 build의 프로젝트 소유 TESTS 목록을 기준으로 맞춥니다.
2. userprog/dup2 같은 nested Make.tests 테스트는 보이게 유지하되, build TESTS에 없으면 프로젝트 단위 all 실행에는 넣지 않습니다.
3. 터미널 현재 위치가 가리키는 Pintos root를 PINTOS_ROOT 환경변수보다 먼저 사용해서 build 위치를 옮겨도 올바른 artifact를 읽습니다.
4. VS Code와 터미널에서 같은 규칙으로 run / debug / reset / artifact 확인을 합니다.
5. 직접 Pintos 루트뿐 아니라 pintos_22.04_lab_docker 같은 wrapper 구조도 처리합니다.
6. VM 파트에서 user programs 테스트를 `vm/build`로 돌리고 싶으면 Virtual Memory 안의 `User Programs for VM` 체크박스를 한 번만 켭니다.
```

`Pintos` 뷰와 `pt` / `pintos-tests` 터미널 명령은 같은 bundled helper를 사용합니다. 두 경로 모두 build Makefile이 있으면 최종 `TESTS` 목록을 우선 사용하되 현재 사이드바 프로젝트가 소유한 테스트만 남기고, 해당 프로젝트의 nested `Make.tests` 등록분으로 보강하거나 fallback하며, 프로젝트 단위 `all` 실행은 build `TESTS`에 들어간 항목만 기본 대상으로 삼고, 같은 `output`, `result`, `errors` artifact를 확인합니다.

## 지원하는 구조

확장은 실제 Pintos 루트를 찾으며 아래 구조를 지원합니다.

- Pintos 루트 자체
- 내부에 `pintos/`가 들어 있는 wrapper 저장소
- `src/` 루트
- `pintos_22.04_lab_docker` 같은 nested lab 구조

터미널 CLI는 먼저 현재 디렉터리가 가리키는 Pintos root를 사용합니다. 현재 디렉터리가 Pintos 트리 밖이라면 CLI에서 실제 루트를 직접 지정할 수도 있습니다.

```bash
PINTOS_ROOT=/path/to/pintos pt list threads
```

## 설치 후 사용

1. 창을 한 번 다시 로드합니다.
2. Activity Bar의 `Pintos` 뷰를 엽니다.
3. VM 파트 작업 중이면 Virtual Memory를 펼치고 `User Programs for VM` 체크박스를 켭니다.
4. 프로젝트를 펼쳐 테스트 행에서 실제 소스 열기, run, debug를 바로 사용합니다.
5. 폴더나 테스트를 체크한 뒤 `Run Checked Tests`를 사용합니다.
6. 필요하면 트리에서 `output`, `result`, `errors` artifact를 바로 엽니다.

활성화 후 새 통합 터미널에서는 아래 명령이 보여야 합니다.

```bash
pt --help
pintos-tests --help
```

VS Code 밖에서도 계속 쓰고 싶다면 `Pintos: Install CLI Wrappers to Shell` 명령을 실행하세요.

디버그 세션에는 추가로 `gdb`와 Microsoft C/C++(`ms-vscode.cpptools`)가 필요합니다. 테스트 실행, 목록 확인, artifact 초기화, CLI 사용에는 C/C++ 확장이 필요하지 않으며, 설치되어 있지 않으면 Debug를 시작할 때만 안내합니다.

## 터미널 사용 예시

```bash
pt projects
pt list threads
pt run threads alarm-zero
pt debug vm 4 --server-only
pt reset threads alarm-*
pt reset-all
pt artifacts threads alarm-zero
```

## Selector 규칙

- `11-20`은 양끝 포함 숫자 범위입니다.
- `alarm-zero`는 정확한 짧은 이름으로 선택합니다.
- `tests/threads/alarm-zero` 형태도 사용할 수 있습니다.
- `alarm-*`는 와일드카드 패턴입니다.
- `all`은 `run`과 프로젝트 단위 `reset`에서 지원하며, build Makefile이 있으면 해당 build의 `TESTS` subset을 따릅니다.
- `debug`와 `artifacts`는 정확히 하나의 테스트여야 합니다.
- `--recent-first`는 로컬 사용 기록을 기준으로 재정렬합니다.

## 문제 해결

### stale custom entry 때문에 빌드가 계속 깨질 때

`priority-change`처럼 다른 테스트를 돌렸는데도 `tests/threads/custom/...` 컴파일에서 계속 실패한다면, 워크스페이스에 예전 custom 등록이 남아 있을 가능성이 큽니다.

```bash
pt custom delete threads custom/new-test
```

에러가 `tests/threads/custom/new-test.d` 같은 dependency file 누락으로 나온다면, 최신 VSIX로 다시 로드한 뒤 한 번 더 실행해서 확장이 대응되는 build 하위 폴더를 다시 만들게 해주세요.

### `Alarm Clock`이 계속 `New Group`으로 보일 때

`.vscode/pintos-test-explorer/groups/threads/new-group.json` 같은 오래된 파일은 현재 릴리스에서 기본적으로 무시됩니다. 그래도 예전 라벨이 보이면 최신 VSIX로 다시 로드하세요. 그 stale JSON 파일을 직접 지워도 안전합니다.

### debug restart가 아직도 이상할 때

현재 릴리스는 VS Code `Restart`도 최초 debug 시작과 같은 준비 경로로 처리합니다. 예전 동작이 계속 보이면 창을 다시 로드하고, 실제로 최신 VSIX가 설치되어 있는지 확인하세요.
