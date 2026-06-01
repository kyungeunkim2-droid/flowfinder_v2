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
  if (dataPart) return dataPart;

  const safeUrl = assertSafeUrl(src, baseUrl);
  if (!safeUrl) return null;
  const response = await fetch(safeUrl);
  if (!response.ok) throw new Error(`이미지 로드 실패: ${label || src}`);
  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/png';
  const bytes = Buffer.from(await response.arrayBuffer());
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
        screenGuide,
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
    const isFrontSideRender = Boolean(frontScreenTexture || sideScreenTexture || /frontside|front_side/i.test(String(screenImage || deskImage || mode || '')));
    const effectiveGuideCandidates = (isDeskRender || !isFrontSideRender) ? [] : ffFrontsideGuideCandidates(effectiveGuideImage, effectiveScreenImage || deskImage);
    const hasGuide = Boolean(effectiveGuideCandidates && effectiveGuideCandidates.length);
    console.log('[GUIDE CANDIDATES]', effectiveGuideCandidates);
    console.log('[HAS GUIDE]', hasGuide);
    const effectiveFrontScreenTexture = isDeskRender ? '' : frontScreenTexture;
    const effectiveSideScreenTexture = isDeskRender ? '' : sideScreenTexture;
    const effectiveFrontScreenCode = isDeskRender ? '' : frontScreenCode;
    const effectiveSideScreenCode = isDeskRender ? '' : sideScreenCode;

    const parts = [];

    parts.push({
      text: [
        'Use the base furniture product image as the exact source image, not as inspiration.',
        'This is an image editing/material mapping task, not a new image generation task.',
        'The output must keep the same original pixels/composition wherever no material texture is applied.',
        'Keep the same camera angle, perspective, proportions, silhouette, dimensions, background, and lighting.',
        'Absolutely do not generate or reconstruct the furniture. This is not a design generation request.',
'Use the exact input image as a locked base image. Only replace material pixels on existing surfaces.',
'Do not change the desk legs, tabletop shape, screen position, camera angle, crop, or background.',
'Do not add cross bars, braces, panels, floors, shadows, or any new geometry.',
        
'If an object part is not clearly visible in the source image, leave it unchanged instead of inventing it.',
        topTexture ? 'Apply the provided top material texture naturally only to the desktop/tabletop surface.' : 'No top texture provided: keep the tabletop unchanged.',
        legTexture ? 'Apply the provided leg material naturally only to the vertical desk legs.' : 'No leg texture provided: keep the legs/frame unchanged.',
        isDeskRender ? 'This is DESK RENDERING. Do not add, recolor, or modify any screen panel. Apply only desktop and leg materials.' : '',
        isScreenRender ? 'This is SCREEN RENDERING. Use the base desk+screen product image exactly as the source, and apply desk and screen materials to the matching existing parts.' : '',
        isScreenRender ? 'Important: the base image contains a desk and screen. During screen rendering, also apply topTexture to the tabletop and legTexture to the desk legs/frame whenever those textures are provided.' : '',

isScreenRender ? 'The tabletop and desk legs are editable material areas. Do not treat them as background.' : '',

isScreenRender ? 'Preserve the original product photo exactly. Do not create a black floor, black backdrop, studio scene, new room, new desk, or new lighting.' : '',
isScreenRender ? 'The desk inside the screen preview image must also be edited. Do not ignore the desk.' : '',
isScreenRender ? 'Apply topTexture to the tabletop area in the screen preview image. The tabletop is usually the horizontal board in front of the screen.' : '',
isScreenRender ? 'Apply legTexture to every visible desk leg and desk frame in the screen preview image.' : '',
isScreenRender ? 'The screen preview image contains three editable material areas: tabletop, legs/frame, and screen panel.' : '',
isScreenRender ? 'If topTexture or legTexture is provided, it must be applied even when targetType is screen.' : '',
        
(effectiveFrontScreenTexture && effectiveSideScreenTexture)
  ? 'The source image contains TWO different screen panels. FRONT screen and SIDE screen must be treated as separate material areas.'
  : '',

(effectiveFrontScreenTexture && effectiveSideScreenTexture)
  ? 'Apply frontScreenTexture only to the FRONT screen panel. Apply sideScreenTexture only to the SIDE screen panel.'
  : '',
(effectiveFrontScreenTexture && effectiveSideScreenTexture && hasGuide)
  ? 'For FRONTSIDE rendering, the guide image is the highest priority area map. White pixels mean FRONT SCREEN ONLY. Red pixels mean SIDE SCREEN ONLY. Never apply one screen texture to both panels.'
  : '',
(effectiveFrontScreenTexture && effectiveSideScreenTexture && hasGuide)
  ? 'If the front and side screen regions are ambiguous, follow the guide colors over visual similarity. Do not merge the two screen panels into one material area.'
  : '',
        effectiveScreenTexture ? 'Apply the provided screen material texture naturally only to the existing screen panel area.' : '',
        effectiveFrontScreenTexture ? 'Apply the provided front screen material only to the FRONT screen panel identified by the guide image.' : '',
       effectiveSideScreenTexture
  ? 'Apply the provided side screen material only to the SIDE screen panel identified by the guide image.'
  : '',
hasGuide ? 'Use the guide image for region mapping. White=front screen, Red=side screen, Brown=tabletop, Dark Gray=desk legs/frame.'
  : '',

hasGuide
  ? 'Apply frontScreenTexture only to the White area that overlaps the actual front screen panel surface. Apply sideScreenTexture only to the Red area that overlaps the actual side screen panel surface.'
  : '',

hasGuide ? 'Apply sideScreenTexture only to the Red area.' 
  : '',

hasGuide ? 'Apply topTexture only to the Brown area.' 
  : '',

hasGuide ? 'Apply legTexture only to the Dark Gray area.' 
  : '',

hasGuide ? 'Do not apply materials outside the guide regions.' 
  : '',
        
hasGuide ? 'The guide colors are masks for object surfaces only. Do not extend material texture beyond the colored object surface regions.'
  : '',

hasGuide ? 'Any uncolored or transparent area in the guide image must remain completely unchanged from the source image.'
  : '',

hasGuide ? 'Do not apply screen textures to background, empty space, floor, shadow, or transparent areas.'
  : '',
(effectiveFrontScreenTexture && effectiveSideScreenTexture)
  ? 'If front and side textures are different, they must remain different. Never copy the side texture onto the front panel or the front texture onto the side panel.'
  : '',
        effectiveScreenCode ? `Screen material code: ${effectiveScreenCode}.` : '',
        effectiveFrontScreenCode ? `Front screen material code: ${effectiveFrontScreenCode}.` : '',
        effectiveSideScreenCode ? `Side screen material code: ${effectiveSideScreenCode}.` : '',
        (effectiveScreenTexture || effectiveFrontScreenTexture || effectiveSideScreenTexture) ? 'If a screen panel exists in the base image, preserve it and recolor only the screen surface.' : '',
        (effectiveScreenTexture || effectiveFrontScreenTexture || effectiveSideScreenTexture) ? 'Do not leave the screen panel black if a screen texture reference is provided.' : '',

'Keep the cable duct / cable tray area exactly as in the source image.',

'Do not recolor the duct/tray section.',
        'Do not redraw the product.',
        'Do not show masks, outlines, guide lines, pen-tool paths, red borders, wireframes, transparent overlays, or Figma artifacts.',
        topCode ? `Top material code: ${topCode}.` : '',
        legCode ? `Leg/frame material code: ${legCode}.` : '',
        deskLabel ? `Desk product: ${deskLabel}.` : '',
        legType ? `Selected leg shape: ${legType}. Preserve it if visible.` : '',
        casterType ? `Selected bottom support: ${casterType}. Preserve it if visible.` : '',
        topShape ? `Selected tabletop shape: ${topShape}. Preserve it if visible.` : '',
        size && (size.w || size.d || size.h) ? `Approximate size reference: W ${size.w || 'default'}mm, D ${size.d || 'default'}mm, H ${size.h || 'default'}mm.` : '',
        'Return a material-mapped edit of the exact same source image. Do not generate a new catalog scene.',
        (effectiveGuideCandidates && effectiveGuideCandidates.length) ? 'Use the provided guide image only as an area map for the exact same base product image. White area = FRONT screen panel only. Red area = SIDE screen panel only. Apply frontScreenTexture only to the white area and sideScreenTexture only to the red area. Do not render guide colors, labels, arrows, annotations, or overlay marks in the final output.' : '',
        (effectiveGuideCandidates && effectiveGuideCandidates.length) ? 'This is a material mapping edit. Keep the original product photo geometry, camera angle, crop, shadows, lighting, desk shape, and screen positions unchanged. Do not create a new desk, new screen, or new scene.' : '',
      ].filter(Boolean).join('\n'),
    });

 const baseProductImage = isScreenRender
  ? (screenImage || deskImage)
  : deskImage;

const imageInputs = [
  ['base furniture product image', baseProductImage],
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

app.listen(PORT, () => {
  console.log(`FlowFinder preview server running: http://localhost:${PORT}`);
});
