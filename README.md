# Framepop — 영상 작업실

프로젝트·레퍼런스·전역 설정을 분리한 실제 실행 서버입니다. 정적 목업은 `/mock.html`에 보존했습니다. 실행 화면은 예시 모델이나 가짜 진행률을 사용하지 않습니다.

## 실행

필수: Node.js 24 이상, Python 3, FFmpeg/ffprobe, Python `opencv-python`, `numpy`.

```sh
python3 -m pip install opencv-python numpy
npm run qc:install
HOST=0.0.0.0 PORT=5173 npm start
```

추가 Node 패키지는 없습니다. 프로젝트·설정·작업·이벤트는 `data/framepop.sqlite`, 영상·이미지는 `data/media`에 저장합니다. `data/`는 Git에서 제외됩니다. 외부 접속 시 서버가 만든 `data/access-code`를 입력합니다. 같은 컴퓨터의 loopback 접속은 코드를 요구하지 않습니다. 인터넷 공개 배포 시에는 HTTPS 프록시가 필요합니다. 이 서버를 정적 Sites 배포로 대체할 수 없습니다.

## 연결 순서

1. **설정 → 계정·서버**에서 Ollama, LM Studio, ComfyUI 또는 구독 계정을 등록합니다. 등록된 실제 주소만 사용합니다. Ollama/LM Studio는 기본 서버 주소를 입력합니다(`/v1` 접미사 제외).
2. OpenAI는 설치된 **Codex app-server의 ChatGPT 구독 로그인**을 사용합니다. xAI는 **Framepop 자체 device OAuth**로 연결합니다. Framepop이 xAI의 인증 서버에서 기기 코드를 발급받고 승인 확인·토큰 저장·갱신을 직접 처리합니다. OpenClaw 설치·실행·계정 파일은 사용하지 않습니다. 공개된 xAI 공유 OAuth 클라이언트와 프로토콜을 참고했으며 동의 화면에는 Grok Build가 표시될 수 있습니다. 승인 후 구독 전용 `/models`와 `/responses`를 사용하며 API 키로 자동 대체하지 않습니다.
구독 종류를 선택하면 서버 주소·토큰 입력 대신 **구독으로 연결** 버튼이 표시됩니다. 로그인 페이지에서 기기 코드를 승인하면 해당 요청의 완료를 확인하고 모델 목록을 자동으로 가져옵니다. 실패·시간 초과 시 같은 화면에서 다시 로그인할 수 있습니다.

3. 로컬 서버는 **모델 조회** 후 **역할 배정**에서 Primary 자동 배정 또는 작업별 수동 모델을 저장합니다. 자동일 때 수동 선택은 비활성화되며 기존 수동값을 보존합니다. 이미지·비디오 강화 담당은 Ollama/LM Studio만 허용됩니다. 로컬 전용 프로젝트는 Primary를 포함해 외부 모델을 호출하지 않습니다. 혼합 프로젝트의 자동 배정은 역할명·후보 목록만 Primary에 보낸 뒤 담당 모델에 해당 작업을 보냅니다.
4. **ComfyUI 자산**에서 설치 목록을 조회해 사용할 이미지/영상 모델과 복수 LoRA를 선택합니다. 강도 입력창은 없습니다. 이미지용·영상용 LoRA 선택은 별도로 저장합니다.
5. **프롬프트 강화**에서 공통 지시를 관리합니다. 레퍼런스는 프로파일 없이 프롬프트만으로 만들 수 있습니다. 프로파일만 있다면 먼저 강화를 실행합니다.

## 자동 생성과 검수

시놉시스 분석 → 플롯·스토리 → 타임라인 → 정합성 검토를 각각 담당 모델에 요청합니다. 구간 추가·삭제·이동·수정 시 LLM이 이야기를 다시 구성합니다. 수정한 ID·순서·내용·길이와 전체 재생 시간은 서버가 별도로 검증합니다. 검증 실패 시 기존 결과를 보존하고, 수정 결과가 확정되기 전 영상 생성을 막습니다.

영상은 **강화 → 자동 워크플로우 구성 → ComfyUI 생성 → Face QC·연결부 검사 → 통과 후 다음 구간** 순서입니다. 영상 모델은 **MiniMax H3 FL2VA**입니다. ComfyUI 공식 H3 구성의 기본 20-step `res_multistep` 경로를 사용하며, 사용자가 선택한 복수 LoRA를 검증된 강도로 연결합니다. Turbo LoRA는 자동으로 추가하지 않습니다. 워크플로우 JSON을 제공할 필요는 없습니다.

원격 서버에는 `MiniMaxH3ImageToVideo`, `SamplerCustomAdvanced`, `BasicGuider`, `VAEDecodeAudio` 등 공식 H3 노드와 FL2VA diffusion model, H3용 Qwen3-VL 인코더, 영상·오디오 VAE가 필요합니다. 설치 목록에서 실제 파일을 확인해 구성하며 모호한 인코더·VAE는 전역 ComfyUI 자산 설정에서 고를 수 있습니다. H3는 1344×768, 24fps, `17k+5` 프레임 간격으로 생성합니다. 15초 구간은 362프레임을 생성한 뒤 1280×720/24fps의 정확한 구간 길이로 편집합니다. 5초 미만 구간은 학습 범위에 맞춰 최소 124프레임을 생성한 뒤 자릅니다. 최종 합본의 음성·음악 편집은 기존 범위 밖이며 현재 구간 출력은 무음입니다.

첫 구간은 이미지 없이 생성할 수 있고, 레퍼런스가 있으면 첫 프레임으로 사용합니다. 연속 구간은 QC를 통과한 이전 구간의 끝 프레임을 사용합니다. 그래프 생성기는 첫·마지막 프레임을 모두 지원하지만 마지막 프레임 자동 제작은 아직 연결하지 않았습니다. 이전 Wan 작업의 그래프를 H3 작업으로 재개하지 않습니다.

이미지는 현재 표준 ComfyUI checkpoint/KSampler 경로입니다. 별도 conditioning이 필요한 모델은 별도 실행 구성이 필요합니다. Grok Imagine/GPT 이미지의 구독 기반 생성 경로는 아직 연결하지 않았습니다. 이미지 서비스 계정·지원 모델이 확인되기 전 임의 모델명으로 호출하지 않습니다.

Face QC는 OpenCV YuNet/SFace로 모든 디코딩 프레임의 얼굴 검출·흐림·임베딩 유사도를 검사합니다. 레퍼런스가 있으면 해당 얼굴을 기준으로, 없으면 첫 선명한 얼굴 묶음을 기준으로 삼습니다. 연속 구간은 이전 마지막 프레임으로 생성하고 경계 얼굴도 비교합니다. 얼굴이 있어야 하는 장면에서 검출되지 않으면 통과시키지 않습니다. 얼굴 없는 장면은 타임라인에서 명시된 경우에만 `no_face` 처리합니다. 다인물, 작은 얼굴, 가림, 측면, 조명 변화에 대한 사용자 영상 기반 임계값 보정은 아직 필요하며 얼굴 외 의상·배경·동작의 완전한 연속성 검사는 구현 범위에 포함되지 않습니다.

검수 실패는 해당 구간만 다시 생성합니다. 통과한 이전 구간, 사용 모델·LoRA 강도, 생성 그래프를 보존합니다. 조회된 서버 자산 정보가 달라지면 기존 작업의 자동 재개를 막습니다. 해시 확장이 없으면 파일명이 같은 모델 교체는 감지할 수 없습니다. 서버 재시작은 작업을 `interrupted`로 표시합니다. 제출 응답이 끊겼을 때 ComfyUI 기록을 찾아 복구하고, 확인할 수 없으면 중복 제출하지 않습니다. 최신 ComfyUI의 개별 작업 취소 API를 사용하며 미지원 서버에서는 원격 중단 미확인 상태를 기록합니다.

## LoRA 권장 강도

`custom_nodes/framepop_assets` 폴더를 **원격 ComfyUI의 `custom_nodes` 아래에 복사하고 ComfyUI를 재시작**합니다. 워크플로우 JSON을 만들거나 제공할 필요는 없습니다. 이 확장은 설치 파일의 이름·SHA-256·safetensors 메타데이터를 제공하며 파일 내용이나 서버 경로를 외부로 전송하지 않습니다. 최초 해시는 큰 파일에서 시간이 걸릴 수 있습니다.

서버가 파일 해시와 일치하는 Civitai 버전 또는 Hugging Face 저장소 커밋을 찾고, 담당 LLM이 해당 원문의 권장 범위·호환성·트리거를 검토합니다. 출처·버전·해시·인용·적용값은 작업에 저장됩니다. 원문과 숫자를 대조하여 출처가 없거나 근거가 불충분하면 실행을 막습니다. 모든 LoRA를 웹 검색으로 식별할 수 있는 것은 아니며 HF의 저장소 힌트가 없으면 발견에 실패할 수 있습니다. 텍스트 인코더 강도는 추정하지 않고 0으로 둡니다. 복수 LoRA의 실제 품질은 생성 결과에서 검증해야 합니다.

## API·검증

실제 라우트 계약: [`dist/openapi.json`](dist/openapi.json). 실행 기록은 `/api/jobs/{id}/events`의 SSE에서 재연결 시 `Last-Event-ID`로 이어받습니다. node/step, 수신 응답 수, 경과 시간, QC 프레임 수를 표시하며 전체 소요시간을 추정한 퍼센트는 만들지 않습니다.

```sh
npm test
```

자동 검증은 실제 HTTP 어댑터와 격리된 테스트 서버, SQLite, FFmpeg 및 OpenCV를 사용합니다. QC 실패 후 다음 구간 차단, 해당 구간 재시도, 정확한 수정 보존, 중복 제출, 상태 복구, iPhone 영상 Range 응답을 검사합니다. xAI 인증 서버의 discovery 조회와 실제 기기 코드 발급(HTTP 200)은 OpenClaw 없이 확인했습니다. 외부 GPU/로컬 모델 서버와 승인된 xAI 구독 호출의 종단 검증은 연결값과 사용자 로그인이 필요합니다. 현재 환경에서 OpenAI 구독 GPT-5.5의 실제 JSON 응답, 자동 테스트, 기준 이미지와 동일한 얼굴의 24프레임 검수 통과를 확인했습니다. 브라우저는 430×932 및 1440×1000 크기로 확인했으며 실제 iOS Safari 기기 검사는 별도입니다.

## 구현 근거

- [ComfyUI 서버 API](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [공식 H3 FL2VA 템플릿](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_i2v.json)
- [ComfyUI H3 노드 구현](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py)
- [Codex app-server](https://developers.openai.com/codex/app-server)
- [OpenClaw xAI 구독 인증](https://docs.openclaw.ai/providers/xai)
- [Ollama Chat API](https://docs.ollama.com/api/chat)
- [OpenCV 모델](https://github.com/opencv/opencv_zoo)
