from pathlib import Path
import re, subprocess, json

src = Path('/mnt/data/server (1).js')
text = src.read_text(encoding='utf-8', errors='ignore')

# 1) Fix destructuring in /api/generate-preview
old = """const {
      deskImage,
      topTexture,
      legTexture,
      topCode,
      legCode,
      deskLabel,
      legType,
      casterType,
      topShape,
      size,
    } = req.body || {};"""

new = """const {
      deskImage,
      topTexture,
      legTexture,
      screenTexture,
      screenCode,
      screenImage,
      screenMask,
      SCREEN_MASK,
      topCode,
      legCode,
      deskLabel,
      legType,
      casterType,
      topShape,
      size,
    } = req.body || {};"""

if old in text:
    text = text.replace(old, new, 1)

# 2) Replace prompt block lines for screen support
text = text.replace(
    """        'Apply the provided leg material naturally only to the vertical desk legs.',

'Keep the cable duct / cable tray area under the desktop matte white.',""",
    """        'Apply the provided leg material naturally only to the vertical desk legs.',
        screenTexture ? 'Apply the provided screen material texture naturally only to the screen panel area.' : '',
        screenCode ? `Screen material code: ${screenCode}.` : '',
        screenTexture ? 'If a screen panel exists in the base image, preserve it and recolor only the screen surface using the screen material texture reference.' : '',
        screenTexture ? 'Do not leave the screen panel black if a screen texture reference is provided.' : '',
        screenTexture ? 'Do not apply the screen material to the desktop or legs.' : '',

'Keep the cable duct / cable tray area under the desktop matte white.',"""
)

# 3) Remove "Do not add a screen panel." only from generate-preview prompt
text = text.replace("        'Do not add a screen panel.',\n", "")

# 4) Add screen references to imageInputs
old_inputs = """    const imageInputs = [
      ['base furniture product image', deskImage],
      ['desktop material texture reference', topTexture],
      ['legs and frame material color reference', legTexture],
    ];"""

new_inputs = """    const imageInputs = [
      ['base furniture product image', deskImage],
      ['desktop material texture reference', topTexture],
      ['legs and frame material color reference', legTexture],
      ['screen material texture reference', screenTexture],
      ['screen product reference', screenImage],
      ['screen mask reference - white area means screen panel only', SCREEN_MASK || screenMask],
    ];"""

if old_inputs in text:
    text = text.replace(old_inputs, new_inputs, 1)

# 5) Make the loop skip empty src to avoid needless warnings
text = text.replace(
"""    for (const [label, src] of imageInputs) {
      const part = await loadImagePart(src, label, baseUrl).catch((err) => {""",
"""    for (const [label, src] of imageInputs) {
      if (!src) continue;
      const part = await loadImagePart(src, label, baseUrl).catch((err) => {""",
1
)

# 6) Fix /api/generate-screen-preview ai undefined bug: add ai init before generateContent
screen_route_old = """    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image-preview',
      contents: [{ role: 'user', parts }]
    });"""
screen_route_new = """    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image-preview',
      contents: [{ role: 'user', parts }],
      config: { responseModalities: ['TEXT', 'IMAGE'] },
    });"""
if screen_route_old in text:
    text = text.replace(screen_route_old, screen_route_new, 1)

out = Path('/mnt/data/server_screen_texture_fixed.js')
out.write_text(text, encoding='utf-8')

# Syntax check with node
try:
    res = subprocess.run(['node', '--check', str(out)], capture_output=True, text=True, timeout=20)
    ok = res.returncode == 0
    msg = (res.stderr or res.stdout).strip()
except Exception as e:
    ok = None
    msg = str(e)

print(json.dumps({
    "saved": str(out),
    "node_check_ok": ok,
    "msg": msg[:1000]
}, ensure_ascii=False, indent=2))
