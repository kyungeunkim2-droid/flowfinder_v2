import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

// FlowFinder Nano Banana preview server
// 1) npm install
// 2) copy .env.example to .env and set GEMINI_API_KEY
// 3) npm run dev

dotenv.config();
if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_GENERATIVE_AI_API_KEY) process.env.GEMINI_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL =
  process.env.GEMINI_IMAGE_MODEL ||
  'gemini-2.5-flash-image';

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(__dirname, {
  etag: false,
  maxAge: 0,
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasGeminiKey: Boolean(process.env.GEMINI_API_KEY), model: MODEL });
});

function assertSafeUrl(raw, baseUrl) {
  if (!raw || typeof raw !== 'string') return null;
  const url = raw.trim();
  if (url.startsWith('data:')) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return new URL(url, baseUrl).toString();
}

function dataUrlToImagePart(src) {
  if (!src || typeof src !== 'string') return null;
  const match = src.trim().match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  return {
    inlineData: {
      mimeType: match[1] || 'image/png',
      data: match[2].replace(/\s/g, ''),
    },
  };
}

async function loadImagePart(src, label, baseUrl) {
  const dataPart = dataUrlToImagePart(src);
  if (dataPart) { console.log('[IMAGE PART LOADED]', label || 'data-url', 'data-url'); return dataPart; }

  const safeUrl = assertSafeUrl(src, baseUrl);
  if (!safeUrl) return null;
  const response = await fetch(safeUrl);
  if (!response.ok) throw new Error(`이미지 로드 실패: ${label || src}`);
  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/png';
  const bytes = Buffer.from(await response.arrayBuffer());
  console.log('[IMAGE PART LOADED]', label || src, safeUrl, mimeType, bytes.length);
  return {
    inlineData: {
      mimeType,
      data: bytes.toString('base64'),
    },
  };
}

function extractInlineImage(response) {
  const candidates = response?.candidates || [];
  for (const candidate of candidates) {
    const partsOut = candidate?.content?.parts || [];
    for (const part of partsOut) {
      const inline = part?.inlineData || part?.inline_data || part?.inline_data_content || null;
      if (inline?.data) {
        return {
          data: inline.data,
          mimeType: inline.mimeType || inline.mime_type || 'image/png',
        };
      }
    }
  }
  return null;
}

function extractText(response) {
  const candidates = response?.candidates || [];
  return candidates
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text)
    .filter(Boolean)
    .join('\n');
}

app.post('/api/generate-preview', async (req, res) => {
  console.log('[NanoBanana] /api/generate-preview called');
  console.log('[SERVER_DESK_TOP_LEG_STRICT_NO_GENERATION] active');
  console.log('[SERVER_ROLLBACK_DESK_STABLE] active');
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인해주세요.',
      });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}/`;

    const {
      deskImage,
      topTexture,
      legTexture,
      screenTexture,
      screenCode,
      screenImage,
      SCREEN_MASK,
      topCode,
      legCode,
      deskLabel,
      legType,
      casterType,
      topShape,
      size,
      guideImage,
      targetType,
      productType,
      mode,
      renderStep,
      frontScreenTexture,
      sideScreenTexture,
      frontScreenCode,
      sideScreenCode,
    } = req.body || {};

    const targetMode = String(targetType || productType || mode || renderStep || '').toLowerCase();
    const hasScreenInput = Boolean(screenImage || screenTexture || frontScreenTexture || sideScreenTexture || /screen|스크린|frontside|front_side|side|front|lshape|straight/.test(targetMode));
    const isScreenRender = hasScreenInput && !(/^desk$|desk-only|desk_only/.test(targetMode) && !screenImage && !screenTexture && !frontScreenTexture && !sideScreenTexture);
    const isFrontsideRender = isScreenRender && /frontside|front_side/.test(String(mode || renderStep || screenImage || '').toLowerCase());
    const activeGuideImage = isFrontsideRender ? guideImage : '';
    const isDeskRender = !isScreenRender;

    // 스크린 렌더링일 때는 screenImage가 이미 스크린이 포함된 previews 원본이다.
    // 절대 desk-only 이미지를 base로 쓰지 않는다.
    const baseFurnitureImage = isScreenRender && screenImage ? screenImage : deskImage;

    console.log('[RENDER BODY]', {
      deskImage,
      screenImage,
      baseFurnitureImage,
      guideImage: activeGuideImage,
      topTexture,
      legTexture,
      screenTexture,
      frontScreenTexture,
      sideScreenTexture,
      topCode,
      legCode,
      screenCode,
      frontScreenCode,
      sideScreenCode,
      targetType,
      productType,
      mode,
      renderStep,
      isScreenRender,
      isDeskRender,
    });

    const parts = [];

    parts.push({
      text: (
        isScreenRender
          ? [
              'Use the FIRST provided image named base furniture product image as the exact reference photo.',
              'The base photo already contains the desk and the screen panel. Do not add a new screen.',
              'Keep the same camera angle, perspective, proportions, silhouette, dimensions, background, crop, shadows, and lighting.',
              'This is material mapping on an existing product photo, not a new furniture generation.',
              'Do not create a new desk, new screen, new scene, or alternate product.',
              'Do not move, resize, redesign, remove, or add any product part.',
              'Apply the provided top material texture naturally only to the existing desktop/tabletop surface.',
              'Apply the provided leg material naturally only to the existing vertical desk legs/frame.',
              screenTexture ? 'Apply the provided screen material texture naturally only to the existing screen panel surface.' : '',
              frontScreenTexture ? 'Apply the provided front screen material only to the FRONT screen panel.' : '',
              sideScreenTexture ? 'Apply the provided side screen material only to the SIDE screen panel.' : '',
              screenCode ? `Screen material code: ${screenCode}.` : '',
              frontScreenCode ? `Front screen material code: ${frontScreenCode}.` : '',
              sideScreenCode ? `Side screen material code: ${sideScreenCode}.` : '',
              activeGuideImage ? 'If a guide image is provided, use it only as an area map: white area = front screen, red area = side screen. Do not show guide colors or marks in the final image.' : '',
              'Keep the cable duct / cable tray area under the desktop matte white.',
              'Do not recolor the duct/tray section.',
              'Do not show masks, outlines, guide lines, pen-tool paths, red borders, wireframes, transparent overlays, or Figma artifacts.',
              topCode ? `Top material code: ${topCode}.` : '',
              legCode ? `Leg/frame material code: ${legCode}.` : '',
              deskLabel ? `Desk product: ${deskLabel}.` : '',
              legType ? `Selected leg shape: ${legType}. Preserve it if visible.` : '',
              casterType ? `Selected bottom support: ${casterType}. Preserve it if visible.` : '',
              topShape ? `Selected tabletop shape: ${topShape}. Preserve it if visible.` : '',
              size && (size.w || size.d || size.h) ? `Approximate size reference: W ${size.w || 'default'}mm, D ${size.d || 'default'}mm, H ${size.h || 'default'}mm.` : '',
              'Return one edited catalog image that preserves the original base photo and changes only the requested materials.'
            ]
          : [
              'CRITICAL: This is a material mapping edit on the provided original product photo.',
              'Use the FIRST provided image named base furniture product image as the exact base photo.',
              'Do not create a new desk. Do not create a new product. Do not create a new scene.',
              'Do not redraw, redesign, replace, move, resize, rotate, add, or remove any desk part.',
              'Preserve the original camera angle, perspective, proportions, silhouette, dimensions, crop, background, shadows, reflections, and lighting exactly.',
              'Recognize the existing tabletop/desktop surface in the base photo. Apply the provided top material texture only to that tabletop surface.',
              'Recognize the existing legs/frame in the base photo. Apply the provided leg material/color only to those legs/frame.',
              'Do not apply the top material to the legs. Do not apply the leg material to the tabletop.',
              'Keep all non-target areas unchanged, including screen panels if present, floor/background, shadow, cable duct, tray, accessories, and edges.',
              'Keep the cable duct / cable tray area under the desktop matte white.',
              'Do not recolor the duct/tray section.',
              'Do not show masks, outlines, guide lines, pen-tool paths, red borders, wireframes, transparent overlays, or Figma artifacts.',
              topCode ? `Top material code: ${topCode}.` : '',
              legCode ? `Leg/frame material code: ${legCode}.` : '',
              deskLabel ? `Desk product: ${deskLabel}.` : '',
              legType ? `Selected leg shape to preserve exactly: ${legType}.` : '',
              casterType ? `Selected bottom support to preserve exactly: ${casterType}.` : '',
              topShape ? `Selected tabletop shape to preserve exactly: ${topShape}.` : '',
              size && (size.w || size.d || size.h) ? `Approximate size reference only: W ${size.w || 'default'}mm, D ${size.d || 'default'}mm, H ${size.h || 'default'}mm. Do not change visible proportions from the base photo.` : '',
              'Return the same original product photo with only tabletop and leg/frame materials changed.'
          ].filter(Boolean).join("\\n");

    const imageInputs = [
      ['base furniture product image', baseFurnitureImage],
      ['desktop material texture reference', topTexture],
      ['legs and frame material color reference', legTexture],
      ['screen material texture reference', screenTexture],
      ['front screen material texture reference', frontScreenTexture],
      ['side screen material texture reference', sideScreenTexture],
      ['front/side guide image', activeGuideImage],
    ];

    for (const [label, src] of imageInputs) {
      const part = await loadImagePart(src, label, baseUrl).catch((err) => {
        console.warn(err.message);
        return null;
      });
      if (part) {
        parts.push({ text: `Reference image provided: ${label}. Use this according to the instructions.` });
        parts.push(part);
      }
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const modelCandidates = Array.from(new Set([
      MODEL,
      'gemini-2.5-flash-image-preview',
      'gemini-3-pro-image-preview',
    ].filter(Boolean)));

    let lastText = '';
    let lastModel = '';

    for (const model of modelCandidates) {
      lastModel = model;
      console.log(`[NanoBanana] trying model: ${model}`);

    console.log('[DESK STRICT CHECK]', { isDeskRender, isScreenRender, isFrontsideRender, baseFurnitureImage, hasTopTexture: Boolean(topTexture), hasLegTexture: Boolean(legTexture), activeGuideImage });
      console.log('[NanoBanana] parts count:', parts.length);
console.time('[NanoBanana] generateContent');

const response = await ai.models.generateContent({
  model,
  contents: [{ role: 'user', parts }],
  config: { responseModalities: ['TEXT', 'IMAGE'] },
});

console.timeEnd('[NanoBanana] generateContent');
console.log('[NanoBanana] response received');
      const inline = extractInlineImage(response);
      console.log('[NanoBanana] inline image found:', !!inline?.data, inline?.mimeType);
console.log('[NanoBanana] response keys:', Object.keys(response || {}));
      if (inline?.data) {
        return res.json({ imageUrl: `data:${inline.mimeType};base64,${inline.data}` });
      }

      lastText = extractText(response);
      console.warn('[NanoBanana] no inline image returned', {
        model,
        text: lastText?.slice(0, 800),
      });
    }

    return res.status(500).json({
      error: '이미지 결과를 받지 못했습니다.',
      detail: lastText || 'Gemini 응답에 inline image data가 없습니다.',
      model: lastModel,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || '이미지 생성 실패', hint: 'GEMINI_API_KEY, 모델명, Render 환경변수, 이미지 경로(products/textures), 서버 로그를 확인하세요.' });
  }
});

app.post('/api/generate-screen-preview', async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}/`;

   const {
  deskAiImage,
  screenImage,
  screenTexture,
  guideImage,
  frontScreenTexture,
  sideScreenTexture,
  frontScreenCode,
  sideScreenCode,
} = req.body || {};
    const parts = [];

    parts.push({
   text: [
  'Use the provided AI-generated desk image as the exact base image.',
  'Use the provided screen/base product image as the exact source image. Do not add a new screen; only edit existing screen material.',
  'Apply the provided screen material only to the screen panel.',
  'Do not modify the desktop, desk legs, cable duct, or existing desk materials.',
  'Keep the same camera angle, perspective, lighting, proportions, and clean catalog background.',
  'Do not show masks, outlines, guide lines, pen-tool paths, or overlays.',
  'Create one photorealistic office furniture catalog render.',
  guideImage ? 'Use the guide image to identify screen panels: FRONT means front screen panel, SIDE means side screen panel. Apply front screen material only to FRONT and side screen material only to SIDE.' : ''
].filter(Boolean).join('\n')
    });

   const imageInputs = [
  ['generated desk image', deskAiImage],
  ['screen product image', screenImage],
  ['screen material texture reference', screenTexture],
  ['front screen material texture reference', frontScreenTexture],
  ['side screen material texture reference', sideScreenTexture],
  ['front/side guide image', guideImage],
];
    for (const [label, src] of imageInputs) {
      if (!src) continue;

      const part = await loadImagePart(src, label, baseUrl).catch((err) => {
        console.warn(err.message);
        return null;
      });

      if (part) parts.push(part);
    }

 const result = await ai.models.generateContent({
  model: MODEL,
  contents: [{ role: 'user', parts }],
  config: { responseModalities: ['TEXT', 'IMAGE'] },
});

    const partsOut =
      result?.candidates?.[0]?.content?.parts ||
      result?.response?.candidates?.[0]?.content?.parts ||
      [];

    const inlinePart = partsOut.find(
      p => p.inlineData?.data || p.inline_data?.data
    );

    const inline = inlinePart?.inlineData || inlinePart?.inline_data || null;

    if (!inline?.data) {
      return res.status(502).json({
        error: '스크린 이미지 결과를 받지 못했습니다.'
      });
    }

    res.json({
      imageUrl: `data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}`
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message || '스크린 생성 실패'
    });
  }
});

app.listen(PORT, () => {
  console.log(`FlowFinder preview server running: http://localhost:${PORT}`);
});
