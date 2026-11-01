# @jiwnchoi/pi-instant-steer

OpenAI Codex의 `instant_interrupt` 동작을 Pi에 옮긴 확장입니다.

## 문제

Pi는 작업 중에 입력한 메시지를 steering 큐에 넣고, **현재 도구 배치가 끝난 뒤**에야 모델에 전달합니다. Codex는 다릅니다. interrupt 키를 누르면 턴을 즉시 중단하고 대기 중인 steering 입력을 바로 보냅니다(Codex 0.163.0, `Enable instant interrupts by default`).

Pi의 기본 Esc 처리는 이와 반대입니다. 큐를 비워 **에디터에 되돌려 놓고** 중단하기 때문에, 수정 사항을 다시 제출해야 합니다.

## 동작

런이 **중단(aborted)으로 종료**되고 아직 전달되지 않은 steering 입력이 남아 있으면, 에디터로 복원된 초안에서 그 steering 텍스트만 도로 꺼내 **새 턴으로 즉시 제출**합니다.

- follow-up 큐와 사용자가 쓰던 초안은 에디터에 그대로 남습니다. Codex도 follow-up은 턴 종료 후로 미룹니다.
- 대기 중인 입력이 없거나 idle에서 중단하면 기존 동작 그대로입니다.
- 에디터를 교체하지 않습니다. `pi-zentui`처럼 에디터를 감싸는 확장과 충돌하지 않도록 `input` / `message_start` / `agent_settled` 이벤트만 사용합니다.
- steering 큐 추적은 Pi 자신의 규칙을 그대로 따릅니다. 제출 시 등록하고, 해당 user 메시지가 시작될 때 제거하므로 이미 전달된 메시지를 다시 보내지 않습니다.
- TUI 모드에서만 동작합니다. RPC/JSON/print 모드는 건드리지 않습니다.

작업 중에는 footer에 `esc → send steer now` 상태가 표시됩니다.

## 사용

```
/instant_steer on|off|status
```

작업 중 Esc → 대기 중인 steering이 즉시 전송됩니다.

## 설치 상태

`~/.pi/agent/settings.json`의 `packages`에 `packages/@jiwnchoi/instant_steer`로 등록되어 있습니다.
