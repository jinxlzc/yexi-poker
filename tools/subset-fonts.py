#!/usr/bin/env python3
"""Build the self-hosted font subsets in public/fonts/.

Sources (SIL OFL 1.1, from github.com/google/fonts):
  ofl/notosanssc/NotoSansSC[wght].ttf
  ofl/notoserifsc/NotoSerifSC[wght].ttf
  ofl/inter/Inter[opsz,wght].ttf
  ofl/fraunces/Fraunces[SOFT,WONK,opsz,wght].ttf
Usage: python3 tools/subset-fonts.py <dir with the source .ttf files>
Requires fonttools + brotli.
"""
import pathlib, re, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

root = pathlib.Path(__file__).resolve().parent.parent
src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/srcfonts')
out = root / 'public' / 'fonts'
out.mkdir(parents=True, exist_ok=True)

ui = set()
for f in [*root.glob('public/**/*.js'), *root.glob('public/*.html'), *root.glob('server/*.js')]:
    ui.update(ch for ch in f.read_text('utf-8') if ord(ch) > 0x2000)
ascii_ = {chr(c) for c in range(0x20, 0x7f)}
punct = set('，。、；：？！“”‘’（）《》【】—…·～　「」『』％＋－×÷→←↑↓·•')
gb_l1 = set()
for hi in range(0xB0, 0xD8):
    for lo in range(0xA1, 0xFF):
        try: gb_l1.add(bytes([hi, lo]).decode('gb2312'))
        except UnicodeDecodeError: pass
print('ui chars', len(ui), 'gb2312 level-1', len(gb_l1))

def build(name, file, axes, chars, features=('kern', 'liga', 'calt', 'tnum', 'locl', 'ccmp')):
    font = TTFont(src / file, lazy=False)
    font = instancer.instantiateVariableFont(font, axes) if axes is not None else font
    import io; buf = io.BytesIO(); font.save(buf); buf.seek(0); font = TTFont(buf)
    opts = subset.Options(); opts.flavor = 'woff2'; opts.layout_features = list(features); opts.name_IDs = ['*']; opts.notdef_outline = True; opts.hinting = False; opts.desubroutinize = True
    s = subset.Subsetter(opts); s.populate(text=''.join(sorted(chars))); s.subset(font)
    path = out / f'{name}.woff2'; opts_font = font; subset.save_font(opts_font, str(path), opts)
    print(f'{path.name:32} {path.stat().st_size/1024:8.1f} KB')

sans_chars = ui | ascii_ | punct | gb_l1
serif_chars = ui | ascii_ | punct
import os
if not os.environ.get('SKIP_CJK'):
  build('noto-sans-sc-400', 'NotoSansSC[wght].ttf', {'wght': 400}, sans_chars)
  build('noto-sans-sc-700', 'NotoSansSC[wght].ttf', {'wght': 700}, sans_chars)
  build('noto-serif-sc-600', 'NotoSerifSC[wght].ttf', {'wght': 600}, serif_chars | gb_l1)
  build('noto-serif-sc-700', 'NotoSerifSC[wght].ttf', {'wght': 700}, serif_chars)
build('inter-var', 'Inter[opsz,wght].ttf', {'opsz': 14, 'wght': (400, 700)}, ascii_ | set('·•–—‘’“”…×−→←✓'), features=('kern', 'liga', 'calt', 'tnum', 'cv11', 'ss01', 'case'))
build('fraunces-rank', 'Fraunces[SOFT,WONK,opsz,wght].ttf', {'opsz': 72, 'SOFT': 30, 'WONK': 0, 'wght': 620}, set('AKQJ1234567890夜'), features=('kern', 'tnum', 'lnum'))
