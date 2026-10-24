# Brand-glossary golden fixtures — provenance

Copied **verbatim** on 2026-10-23 for the brand-glossary golden-run tests
(`../brandGlossary.golden.test.ts`). Do not edit these files; if the golden
set changes, re-copy from the originals and update the tests deliberately.

| Fixture | Original |
|---|---|
| `brand-golden-testset.json` | `~/workspace/rea-product-line/phase4l/captions/testset.json` (md5 b8b77f36ce1843f91674239805693f0d at copy time) |
| `brand-golden-whisper.json` | `~/workspace/rea-product-line/phase4l/captions/raw/whisper_small_en.json` (md5 e36494d079096bddebb0692097bc9e1e at copy time) |

The 12 clips' ground truths were verified against frozen sources (locked
promo creative 2026-10-21; brand-film FROZEN BEAT TABLE; Small Up Yuhself
skit script). The transcripts are the local faster-whisper small.en
baseline — NOT Studio's Gemini engine (no Gemini key is available locally;
the live-provider golden run remains owner-gated — see
`~/workspace/rea-product-line/phase4l/captions/CORRECTION-SPEC.md` §d.4).
