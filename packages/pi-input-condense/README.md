# @jiwnchoi/pi-input-condense

긴 유저 메시지(복붙한 문서 등)를 화면에서 접고 `Ctrl+O` 또는 전체화면 모드의
왼쪽 클릭으로 펼칩니다. 펼친 메시지를 다시 클릭하면 접힙니다. 실행 내용,
도구 인자, 모델이 보는 트랜스크립트는 바뀌지 않습니다.

## 왜 필요한가

Pi의 `UserMessageComponent` 에는 `setExpanded` 가 없어서 Ctrl+O 대상이 아닙니다.
에디터는 큰 붙여넣기를 `[paste #1 +N lines]` 로 접지만, 트랜스크립트는 다시 전체
본문을 그립니다. 프로토타입에 `render` 클램프와 `setExpanded` 를 추가해 Pi의 전역
확장 동작이 이 행에도 닿게 합니다.

## 범위

도구 호출 접기는 이 패키지에 없습니다. 접힌 도구 행은
`@pi-kaush/pi-tool-call-markers` 가 소유합니다. 이 패키지는 유저 메시지만 다룹니다.

## 설치 상태

`~/.pi/agent/settings.json` 의 `packages` 항목으로 등록되어 있습니다.

```json
"packages": ["./packages/@jiwnchoi/input-condense", ...]
```

## 설정

`~/.pi/agent/input-condense.json` (없으면 아래 기본값):

```json
{
  "enabled": true,
  "inputCollapsedRows": 4,
  "inputShowOmittedCount": true,
  "inputExpandHint": false,
  "inputMinRows": 12
}
```

| 키                      | 기본값  | 설명                                          |
| ----------------------- | ------- | --------------------------------------------- |
| `enabled`               | `true`  | false면 아무것도 하지 않고 원래 렌더러에 위임 |
| `inputCollapsedRows`    | `4`     | 유저 메시지 접힘 행 수                        |
| `inputShowOmittedCount` | `true`  | 유저 메시지 `+N lines` 표시                   |
| `inputExpandHint`       | `false` | 유저 메시지에 `Ctrl+O to expand` 표시         |
| `inputMinRows`          | `12`    | 이 행 수 이하인 메시지는 건드리지 않음        |

파일 mtime을 보고 갱신하므로 세션 재시작 없이 반영됩니다. 단, extension 코드
자체를 고치면 `pi` 재실행이 필요합니다.

## 알려진 한계

- 유저 메시지 접기는 Pi 내부 `UserMessageComponent.prototype` 패치입니다. Pi 업데이트로
  내부 구조가 바뀌면 조용히 비활성화됩니다(원래 렌더러로 폴백).
- 클릭 접기·펼치기는 Pi가 마우스 이벤트를 전달하는 전체화면 모드에서만 동작합니다.
  일반 모드는 터미널이 마우스를 처리하므로 `Ctrl+O` 를 사용하세요.
- 짧은 메시지, 우클릭, 보조키를 누른 클릭, 드래그는 접기·펼치기로 처리하지 않습니다.

## 테스트

워크스페이스에 설치된 Pi 패키지를 사용해 실제 사용자 메시지 렌더러와 마우스 디스패치를 검증합니다. 저장소 루트에서 실행하세요.

```bash
pnpm test
```
