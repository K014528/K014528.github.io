# TESS AI — Local Books Folder

Place NCERT (or any) textbook PDFs inside this directory using this exact filename convention:

    NCERT-books-for-class-{CLASS}-{SUBJECT}.pdf

Where:
- `{CLASS}` is a number 6, 7, 8, 9, 10, 11, or 12
- `{SUBJECT}` is one of: `maths`, `science`, `physics`, `chemistry`, `biology`,
  `history`, `geography`, `english`, `hindi`, `civics`, `economics`, `computer`, `sst`

Examples (case-INsensitive on the class/subject part; keep the exact ".pdf" extension):
- `NCERT-books-for-class-6-maths.pdf`
- `NCERT-books-for-class-6-science.pdf`
- `NCERT-books-for-class-8-maths.pdf`
- `NCERT-books-for-class-9-chemistry.pdf`

## How TESS AI uses these files

1. Backend extracts Class + Subject (+ Page / Exercise / Question) from the user's prompt.
2. Backend looks up the corresponding local file using the naming convention above (also tries a few alt filename variants — see `LOCAL_BOOK_PATHS` fallback list in `server.py`).
3. Backend parses the PDF with `pypdf`, slices the text around the requested page/exercise/question, and injects it as **TEXTBOOK CONTEXT** into the Gemini system prompt.
4. Gemini answers strictly from that context.

If a matching file is not found, TESS returns a friendly "not found" message — it never invents textbook content.

## Adding new subjects

Just drop the PDF into this folder using a filename that includes `class-{N}` and the subject word. The mapper `resolve_local_pdf()` in `server.py` performs case-insensitive substring matching.
