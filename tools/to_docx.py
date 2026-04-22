#!/usr/bin/env python3
"""
Конвертер Markdown → DOCX через pandoc.
Использование:
    ./to_docx.py <входной-файл.md> [<выходной-файл.docx>]
"""
import sys
import subprocess
from pathlib import Path


def convert_md_to_docx(md_file: str, docx_file: str = None) -> str:
    """
    Конвертирует Markdown в DOCX через pandoc.
    """
    md_path = Path(md_file).expanduser().resolve()
    if not md_path.exists():
        raise FileNotFoundError(f"Файл не найден: {md_path}")
    
    if not docx_file:
        docx_file = md_path.with_suffix(".docx")
    
    docx_path = Path(docx_file).expanduser().resolve()
    
    # pandoc --from=markdown --to=docx --output=out.docx in.md
    cmd = [
        "pandoc",
        "--from=markdown",
        "--to=docx",
        f"--output={docx_path}",
        str(md_path),
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(f"pandoc failed: {result.stderr}")
    except FileNotFoundError:
        raise RuntimeError("pandoc не найден в PATH. Установи: brew install pandoc")
    
    return str(docx_path)


def main():
    if len(sys.argv) < 2:
        sys.exit("Укажи входной Markdown файл: ./to_docx.py contract.md [output.docx]")
    
    md_file = sys.argv[1]
    docx_file = sys.argv[2] if len(sys.argv) > 2 else None
    
    try:
        output = convert_md_to_docx(md_file, docx_file)
        print(f"✅ Готово: {output}")
    except Exception as e:
        sys.exit(f"❌ Ошибка: {e}")


if __name__ == "__main__":
    main()
