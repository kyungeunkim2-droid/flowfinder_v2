# Nano Banana 실사 미리보기 연결 방법

## 1. 설치

```bash
cd flowfinder
npm install
```

## 2. API 키 설정

`.env.example` 파일을 복사해서 `.env`로 만들고 키를 넣습니다.

```bash
cp .env.example .env
```

`.env`:

```env
GEMINI_API_KEY=여기에_키_입력
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image-preview
PORT=3000
```

## 3. 실행

```bash
npm run dev
```

브라우저에서 아래 주소를 엽니다.

```txt
http://localhost:3000
```

## 4. 사용

오른쪽 미리보기에서 `✨ 실사 미리보기 생성`을 누르면 현재 선택된 데스크/스크린/재질 이미지가 서버로 전달되고, 서버가 Gemini 이미지 모델을 호출해 결과 이미지를 반환합니다.

## 보안

- API 키는 `.env`에만 둡니다.
- `index.html`에 API 키를 직접 넣지 않습니다.
- 배포할 때 `.env`는 GitHub에 올리지 않습니다.
