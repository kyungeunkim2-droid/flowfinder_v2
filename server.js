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


function ffBaseFileNameFromImage(src) {
  const raw = String(src || '').split('?')[0].split('#')[0].replace(/\\/g, '/');
  const file = raw.split('/').pop() || '';
  return file || '';
}

function ffUnique(values) {
  const out = [];
  for (const v of values || []) {
    const s = String(v || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function ffFrontsideGuideCandidates(guideImage, baseImage) {
  const file = ffBaseFileNameFromImage(baseImage);
  const normalizedFile = file
    .replace(/front_side/gi, 'frontside')
    .replace(/front-side/gi, 'frontside')
    .replace(/front—side/gi, 'frontside');

  const names = ffUnique([
    normalizedFile,
    normalizedFile.replace(/_/g, '-'),
    normalizedFile.replace(/_/g, '—'),
    normalizedFile.replace(/-/g, '_'),
    normalizedFile.replace(/—/g, '_'),
    'frontside_guide.png'
  ]);

  const fromFile = names.map((name) => `./images/guides/${name}`);
  return ffUnique([
    guideImage,
    ...fromFile
  ]);
}

async function loadImagePart(src, label, baseUrl) {
  const dataPart = dataUrlToImagePart(src);
  if (dataPart) {
    console.log('[IMAGE PART LOADED]', label || 'data-url', 'data-url');
    return dataPart;
  }

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


// === FF_DESK_SCREEN_MAPPING_PROMPT_HARD_LOCK_START ===
function ffBuildStrictMappingPrompt({
  isDeskRender,
  isScreenRender,
  effectiveScreenTexture,
  effectiveFrontScreenTexture,
  effectiveSideScreenTexture,
  effectiveScreenCode,
  effectiveFrontScreenCode,
  effectiveSideScreenCode,
  effectiveGuideCandidates,
  topCode,
  legCode,
  deskLabel,
  legType,
  casterType,
  topShape,
  size
}) {
  const common = [
    'CRITICAL: This is an IMAGE EDITING / MATERIAL MAPPING task, not a new image generation task.',
    'Use the FIRST provided image named "base furniture product image" as the exact base photo.',
    'The final output must be the same product photo with materials changed only on specified existing surfaces.',
    'Do not create a new desk. Do not create a new product. Do not redesign anything.',
    'Do not change camera angle, perspective, crop, framing, scale, product geometry, product silhouette, dimensions, background, shadows, or lighting.',
    'Do not add or remove legs, casters, screens, ducts, accessories, panels, objects, labels, annotations, or decorative elements.',
    'Do not use the material texture image as a background, wallpaper, scene, or large flat plane.',
    'Preserve the original catalog photo composition exactly.',
    '',
    'EDIT TARGETS:',
    '1. Desktop/tabletop: apply the desktop material texture only to the existing tabletop surface.',
    '2. Legs/frame: apply the leg/frame material color only to the existing legs/frame.',
    '3. Cable duct/tray under the desktop: keep matte white and do not recolor it.',
  ];

  const deskOnly = isDeskRender ? [
    '',
    'DESK-ONLY MODE:',
    'There is no screen edit in this request.',
    'Ignore any screen-related changes.',
    'Only recolor/rematerial the existing tabletop and existing legs/frame.',
    'Absolutely do not generate a different desk style or alternate product render.',
  ] : [];

  const screenMode = isScreenRender ? [
    '',
    'SCREEN MODE:',
    'Use the base desk+screen image exactly as the source photo.',
    'Apply desk materials to the existing desk parts and screen materials to the existing screen panels only.',
    effectiveScreenTexture ? 'Apply the general screen texture only to existing screen panel surfaces.' : '',
    effectiveFrontScreenTexture ? 'Apply the front screen texture only to the existing FRONT screen panel.' : '',
    effectiveSideScreenTexture ? 'Apply the side screen texture only to the existing SIDE screen panel.' : '',
    effectiveScreenCode ? `General screen material code: ${effectiveScreenCode}.` : '',
    effectiveFrontScreenCode ? `Front screen material code: ${effectiveFrontScreenCode}.` : '',
    effectiveSideScreenCode ? `Side screen material code: ${effectiveSideScreenCode}.` : '',
  ] : [];

  const guide = (effectiveGuideCandidates && effectiveGuideCandidates.length && isScreenRender) ? [
    '',
    'GUIDE IMAGE RULES:',
    'Use the provided guide image only as an area map aligned to the base product photo.',
    'White area = FRONT screen panel only.',
    'Red area = SIDE screen panel only.',
    'Everything outside the guide-colored areas must remain unchanged except tabletop/legs if textures are provided.',
    'Do not render guide colors, guide labels, arrows, red marks, white marks, outlines, masks, or overlays in the final output.',
  ] : [];

  const refs = [
    '',
    'REFERENCE IMAGE ROLE ORDER:',
    'Reference 1: base furniture product image = the photo to edit and preserve.',
    'Other references are material/area references only. They must not become the scene or change the product design.',
  ];

  const meta = [
    '',
    topCode ? `Top material code: ${topCode}.` : '',
    legCode ? `Leg/frame material code: ${legCode}.` : '',
    deskLabel ? `Desk product label: ${deskLabel}.` : '',
    legType ? `Selected leg shape to preserve: ${legType}.` : '',
    casterType ? `Selected bottom support to preserve: ${casterType}.` : '',
    topShape ? `Selected tabletop shape to preserve: ${topShape}.` : '',
    size && (size.w || size.d || size.h) ? `Approximate size reference only: W ${size.w || 'default'}mm, D ${size.d || 'default'}mm, H ${size.h || 'default'}mm. Do not change the visible proportions from the base photo.` : '',
    '',
    'OUTPUT REQUIREMENT:',
    'Return only a photorealistic edited version of the original base photo, with only the requested material changes. Do not synthesize a new product image.',
  ];

  return [
    ...common,
    ...deskOnly,
    ...screenMode,
    ...guide,
    ...refs,
    ...meta
  ].filter(Boolean).join('\\n');
}
// === FF_DESK_SCREEN_MAPPING_PROMPT_HARD_LOCK_END ===

app.post('/api/generate-preview', async (req, res) => {
  console.log('[NanoBanana] /api/generate-preview called');
  console.log('[SERVER_PREVIEWS_BASE_IMAGE_ONLY] active');
  console.log('[SERVER_AUTO_GUIDE_BY_BASENAME] active');
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
      frontScreenTexture,
      sideScreenTexture,
      frontScreenCode,
      sideScreenCode,
    } = req.body || {};
console.log('[RENDER BODY]', {
  deskImage,
  screenImage,
  guideImage,

  topTexture,
  legTexture,
  screenTexture,

  frontScreenTexture,
  sideScreenTexture,

  topCode,
  legCode,
  screenCode,

  targetType,
  productType,
  mode
});
    // FF_TARGET_MODE_SAFE_PATCH
    const targetMode = String(targetType || productType || mode || '').toLowerCase();
    const isScreenRender = /screen|스크린/.test(targetMode);
    const isDeskRender = /desk|데스크/.test(targetMode) && !isScreenRender;

    const effectiveScreenTexture = isDeskRender ? '' : screenTexture;
    const effectiveScreenCode = isDeskRender ? '' : screenCode;
    const effectiveScreenImage = isDeskRender ? '' : screenImage;
    const effectiveGuideImage = isDeskRender ? '' : guideImage;
    const effectiveGuideCandidates = isDeskRender ? [] : ffFrontsideGuideCandidates(effectiveGuideImage, effectiveScreenImage || deskImage);
    console.log('[GUIDE CANDIDATES]', effectiveGuideCandidates);
    const effectiveFrontScreenTexture = isDeskRender ? '' : frontScreenTexture;
    const effectiveSideScreenTexture = isDeskRender ? '' : sideScreenTexture;
    const effectiveFrontScreenCode = isDeskRender ? '' : frontScreenCode;
    const effectiveSideScreenCode = isDeskRender ? '' : sideScreenCode;

    const parts = [];

    parts.push({
      text: ffBuildStrictMappingPrompt({
        isDeskRender,
        isScreenRender,
        effectiveScreenTexture,
        effectiveFrontScreenTexture,
        effectiveSideScreenTexture,
        effectiveScreenCode,
        effectiveFrontScreenCode,
        effectiveSideScreenCode,
        effectiveGuideCandidates,
        topCode,
        legCode,
        deskLabel,
        legType,
        casterType,
        topShape,
        size
      }),
    });

    const imageInputs = [
      ['base furniture product image', deskImage],
      ['desktop material texture reference', topTexture],
      ['legs and frame material color reference', legTexture],
      ['screen material texture reference', effectiveScreenTexture],
      ['front screen material texture reference', effectiveFrontScreenTexture],
      ['side screen material texture reference', effectiveSideScreenTexture],
      ...((effectiveGuideCandidates || []).map((src, idx) => [`front/side guide image candidate ${idx + 1}`, src])),
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

    console.log('[NanoBanana] prompt mode flags:', { isDeskRender, isScreenRender, targetMode, hasDeskImage: Boolean(deskImage), hasTopTexture: Boolean(topTexture), hasLegTexture: Boolean(legTexture), hasFrontScreenTexture: Boolean(effectiveFrontScreenTexture), hasSideScreenTexture: Boolean(effectiveSideScreenTexture) });
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
  console.log('[NanoBanana] /api/generate-screen-preview called');
  console.log('[SERVER_STRICT_SCREEN_PREVIEW_NO_ADD_SCREEN] active');
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인해주세요.',
      });
    }

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
      topTexture,
      legTexture,
      topCode,
      legCode,
    } = req.body || {};

    // IMPORTANT:
    // For screen rendering, screenImage from ./images/previews/... is already the correct desk+screen base photo.
    // Do NOT add a screen product. Do NOT use screenImage as an object reference to compose into deskAiImage.
    const baseImage = screenImage || deskAiImage;

    console.log('[SCREEN RENDER BODY]', {
      baseImage,
      screenImage,
      deskAiImage,
      screenTexture,
      guideImage,
      frontScreenTexture,
      sideScreenTexture,
      frontScreenCode,
      sideScreenCode,
      topTexture,
      legTexture,
      topCode,
      legCode,
    });

    const parts = [];

    parts.push({
      text: [
        'CRITICAL: This is an IMAGE EDITING / MATERIAL MAPPING task, not a new image generation task.',
        'Use the FIRST provided image named "base furniture product image" as the exact base photo.',
        'The base image already contains the desk and screen panel. Do NOT add a new screen.',
        'Do NOT create a new desk. Do NOT create a new screen. Do NOT create a new scene.',
        'Do NOT redesign, replace, move, resize, rotate, or reinterpret any product part.',
        'Preserve camera angle, perspective, crop, framing, product geometry, screen position, desk position, background, shadows, and lighting exactly.',
        'Only replace material/color on the specified existing surfaces.',
        'Texture references are material samples only. Never use them as the background or as a full-image overlay.',
        topTexture ? 'Apply the top material only to the existing tabletop surface.' : '',
        legTexture ? 'Apply the leg material only to the existing legs/frame.' : '',
        screenTexture ? 'Apply the screen material only to the existing screen panel surface.' : '',
        frontScreenTexture ? 'Apply the front screen material only to the existing FRONT screen panel.' : '',
        sideScreenTexture ? 'Apply the side screen material only to the existing SIDE screen panel.' : '',
        frontScreenCode ? `Front screen material code: ${frontScreenCode}.` : '',
        sideScreenCode ? `Side screen material code: ${sideScreenCode}.` : '',
        topCode ? `Top material code: ${topCode}.` : '',
        legCode ? `Leg/frame material code: ${legCode}.` : '',
        guideImage ? 'Use the guide image only as an area map aligned to the base photo. White area = FRONT screen panel only. Red area = SIDE screen panel only. Do not render guide colors, labels, arrows, or overlays.' : '',
        'Cable duct/tray under the desktop must remain matte white.',
        'Final output must look like the original base photo with only requested material changes.',
      ].filter(Boolean).join('\n')
    });

    const imageInputs = [
      ['base furniture product image', baseImage],
      ['desktop material texture reference', topTexture],
      ['legs and frame material color reference', legTexture],
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
      console.log('[NanoBanana] screen prompt mode flags:', {
        hasBaseImage: Boolean(baseImage),
        hasScreenTexture: Boolean(screenTexture),
        hasFrontScreenTexture: Boolean(frontScreenTexture),
        hasSideScreenTexture: Boolean(sideScreenTexture),
        hasGuideImage: Boolean(guideImage),
      });
      console.log('[NanoBanana] parts count:', parts.length);
      console.time('[NanoBanana] generateContent');

      const result = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      });

      console.timeEnd('[NanoBanana] generateContent');
      console.log('[NanoBanana] response received');

      const inline = extractInlineImage(result);
      console.log('[NanoBanana] inline image found:', !!inline?.data, inline?.mimeType);

      if (inline?.data) {
        return res.json({
          imageUrl: `data:${inline.mimeType || 'image/png'};base64,${inline.data}`
        });
      }

      lastText = extractText(result);
      console.warn('[NanoBanana] no inline image returned', {
        model,
        text: lastText?.slice(0, 800),
      });
    }

    return res.status(502).json({
      error: '스크린 이미지 결과를 받지 못했습니다.',
      detail: lastText || 'Gemini 응답에 inline image data가 없습니다.',
      model: lastModel,
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
