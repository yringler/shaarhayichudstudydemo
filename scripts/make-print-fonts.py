"""Regenerate the print-book fonts in public/fonts/print/ (see README
"Print-ready PDF for KDP"). Needs Python 3 with fontTools and brotli
(pip install fonttools brotli) and network access to GitHub.

Chromium embeds a variable font in a PDF as a Type 3 font (outlines drawn as
procedures, no hinting), so the book uses static instances, which it embeds as
TrueType:

  * Source Serif 4 and Frank Ruhl Libre come from google/fonts, whose OFL
    reserves no font name, so they are instanced (weight, and optical size for
    Source Serif) and subset to Latin, Latin-ext, punctuation and Hebrew with
    every OpenType layout feature kept (smcp, c2sc, onum, lnum, tnum, pnum,
    Hebrew mark positioning).
  * Source Sans 3 is Adobe's static TTF release, copied unmodified: its OFL
    reserves the name "Source", so it is not subset or converted.

The EPUB editions (scripts/build-epub.ts) embed a few of the same instances
as TrueType in epub/fonts/: Kindle takes TTF or OTF only, not WOFF2. They are
made from the WOFF2 files here (decompressed, otherwise unchanged), so
`--epub` alone needs no network.

Usage: python3 scripts/make-print-fonts.py [download-dir]
       python3 scripts/make-print-fonts.py --epub     # only epub/fonts/, from public/fonts/print/
"""

import sys
import urllib.request
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'fonts' / 'print'
GOOGLE = 'https://raw.githubusercontent.com/google/fonts/main/ofl'
ADOBE_SANS = 'https://raw.githubusercontent.com/adobe-fonts/source-sans/release'

# Latin, Latin-ext, IPA/modifiers, combining marks, Hebrew (letters, nikud,
# geresh/gershayim, presentation forms), general punctuation, super/subscripts,
# currency, letterlike, number forms, arrows, maths, geometric shapes.
UNICODES = [
    *range(0x0000, 0x0370), *range(0x0590, 0x0600), *range(0x1E00, 0x1F00),
    *range(0x2000, 0x20D0), *range(0x2100, 0x2300), *range(0x25A0, 0x2600),
    *range(0xFB1D, 0xFB50), 0xFEFF, 0xFFFD,
]

SERIF = 'SourceSerif4[opsz,wght].ttf'
SERIF_IT = 'SourceSerif4-Italic[opsz,wght].ttf'
FRANK = 'FrankRuhlLibre[wght].ttf'

# (output name, source variable font, axis location)
INSTANCES = [
    # Text: optical size 12, for 8–14 pt.
    ('SourceSerif4Text-Regular', SERIF, {'wght': 400, 'opsz': 12}),
    ('SourceSerif4Text-Semibold', SERIF, {'wght': 600, 'opsz': 12}),
    ('SourceSerif4Text-Bold', SERIF, {'wght': 700, 'opsz': 12}),
    ('SourceSerif4Text-Italic', SERIF_IT, {'wght': 400, 'opsz': 12}),
    ('SourceSerif4Text-SemiboldItalic', SERIF_IT, {'wght': 600, 'opsz': 12}),
    ('SourceSerif4Text-BoldItalic', SERIF_IT, {'wght': 700, 'opsz': 12}),
    # Display: optical size 36, for headings of about 16 pt and up.
    ('SourceSerif4Display-Regular', SERIF, {'wght': 400, 'opsz': 36}),
    ('SourceSerif4Display-Semibold', SERIF, {'wght': 600, 'opsz': 36}),
    ('SourceSerif4Display-Bold', SERIF, {'wght': 700, 'opsz': 36}),
    ('SourceSerif4Display-Italic', SERIF_IT, {'wght': 400, 'opsz': 36}),
    ('FrankRuhlLibre-Regular', FRANK, {'wght': 400}),
    ('FrankRuhlLibre-Medium', FRANK, {'wght': 500}),
    ('FrankRuhlLibre-Bold', FRANK, {'wght': 700}),
]
GOOGLE_FOLDER = {SERIF: 'sourceserif4', SERIF_IT: 'sourceserif4', FRANK: 'frankruhllibre'}
SANS = ['SourceSans3-Regular', 'SourceSans3-Semibold', 'SourceSans3-Bold']

EPUB_OUT = ROOT / 'epub' / 'fonts'
# The instances the EPUB's stylesheet (epub/epub.css) uses.
EPUB_FONTS = [
    'SourceSerif4Text-Regular', 'SourceSerif4Text-Italic', 'SourceSerif4Text-Semibold',
    'SourceSerif4Text-SemiboldItalic', 'FrankRuhlLibre-Regular', 'FrankRuhlLibre-Medium',
]


def fetch(url: str, dest: Path) -> Path:
    if not dest.exists():
        print(f'  fetch {url}')
        with urllib.request.urlopen(url) as r:
            dest.write_bytes(r.read())
    return dest


def write_epub_fonts() -> None:
    EPUB_OUT.mkdir(parents=True, exist_ok=True)
    for name in EPUB_FONTS:
        font = TTFont(OUT / f'{name}.woff2')
        font.flavor = None
        font.save(EPUB_OUT / f'{name}.ttf')
        print(f'  epub/fonts/{name}.ttf')


def main() -> None:
    if sys.argv[1:] == ['--epub']:
        write_epub_fonts()
        return
    dl = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '.font-downloads'
    dl.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    for name, folder in GOOGLE_FOLDER.items():
        fetch(f"{GOOGLE}/{folder}/{name.replace('[', '%5B').replace(']', '%5D')}", dl / name)
    fetch(f'{GOOGLE}/sourceserif4/OFL.txt', OUT / 'OFL-SourceSerif4.txt')
    fetch(f'{GOOGLE}/frankruhllibre/OFL.txt', OUT / 'OFL-FrankRuhlLibre.txt')
    fetch(f'{ADOBE_SANS}/LICENSE.md', OUT / 'OFL-SourceSans3.txt')
    for name in SANS:
        fetch(f'{ADOBE_SANS}/TTF/{name}.ttf', OUT / f'{name}.ttf')

    for out, src, loc in INSTANCES:
        font = instancer.instantiateVariableFont(TTFont(dl / src), loc)
        # A PostScript name per instance, so pdffonts tells the weights apart.
        font['name'].setName(out, 6, 3, 1, 0x409)
        font['name'].setName(out, 6, 1, 0, 0)
        opts = Options()
        opts.layout_features = ['*']
        opts.layout_scripts = ['*']
        opts.name_IDs = ['*']
        opts.name_languages = ['*']
        opts.notdef_outline = True
        sub = Subsetter(opts)
        sub.populate(unicodes=UNICODES)
        sub.subset(font)
        font.flavor = 'woff2'
        font.save(OUT / f'{out}.woff2')
        print(f'  {out}.woff2')
    write_epub_fonts()


if __name__ == '__main__':
    main()
